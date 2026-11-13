"""
MAVLink link between the drone's Raspberry Pi and its Pixhawk (ArduCopter).

One background thread owns the connection: it reads every message, keeps the
latest vehicle state, sends the GCS heartbeat the Pixhawk's failsafe watches,
re-requests telemetry streams and reconnects if the cable or port drops.

The Pixhawk can be reached over USB (/dev/ttyACM0) or TELEM2 (the Pi's UART,
/dev/serial0). link_prefer chooses: "usb", "telem2", or "auto" (USB first, then
TELEM2 if USB isn't there or stays silent).

Commands (arm, mode, take-off, mission upload) run in the caller's thread. The
replies they wait for (COMMAND_ACK, mission protocol messages) are handed over
by the reader thread, so no two threads ever read from the connection.
"""

import glob
import logging
import math
import os
import queue
import threading
import time
from collections import deque

from pymavlink import mavutil

mavlink = mavutil.mavlink
log = logging.getLogger("drone.mav")

# ArduCopter flight modes (custom_mode numbers).
COPTER_MODES = {
    "STABILIZE": 0, "ACRO": 1, "ALT_HOLD": 2, "AUTO": 3, "GUIDED": 4, "LOITER": 5,
    "RTL": 6, "CIRCLE": 7, "LAND": 9, "DRIFT": 11, "SPORT": 13, "FLIP": 14,
    "AUTOTUNE": 15, "POSHOLD": 16, "BRAKE": 17, "THROW": 18, "AVOID_ADSB": 19,
    "GUIDED_NOGPS": 20, "SMART_RTL": 21, "FLOWHOLD": 22, "FOLLOW": 23, "ZIGZAG": 24,
    "SYSTEMID": 25, "AUTOROTATE": 26, "AUTO_RTL": 27,
}
MODE_NAMES = {v: k for k, v in COPTER_MODES.items()}
# Modes the copter can be armed in without moving off by itself.
ARMABLE_MODES = ("STABILIZE", "ALT_HOLD", "LOITER", "GUIDED", "POSHOLD")
GPS_MODES = ("AUTO", "GUIDED", "LOITER", "RTL", "CIRCLE", "POSHOLD", "SMART_RTL", "FOLLOW", "AUTO_RTL")

GCS_SYSID = 255
GCS_COMPID = mavlink.MAV_COMP_ID_MISSIONPLANNER
FORCE_DISARM_MAGIC = 21196
FC_TIMEOUT_S = 3.5
POSE_HZ = 10            # position + attitude rate asked of the Pixhawk (for placing detections)
POSE_HZ_USB = 20        # ...over USB, which has the bandwidth for it
POSE_KEEP = 300         # samples kept of each: 30 s at POSE_HZ, 15 s at POSE_HZ_USB
STREAM_HZ = 5           # every other telemetry stream
STREAM_HZ_USB = 10
USB_CHECK_S = 1.0       # while searching, how often to look for a Pixhawk plugged in over USB
POSE_MAX_GAP_S = 0.5    # a pose further than this from any sample is not trusted
SILENT_SWITCH_S = 6.0   # try the next port/baud after this long without a heartbeat
WORKED_SWITCH_S = 30.0  # ...but stay this long on a link that already worked (in flight!)
# TELEM2 speeds to try (SERIAL2_BAUD on the Pixhawk): 57, 115, 921, 230, 460, 500, 1500 (x1000).
TELEM2_BAUDS = (57600, 115200, 921600, 230400, 460800, 500000, 1500000)

LANDED = {0: "unknown", 1: "on_ground", 2: "in_air", 3: "taking_off", 4: "landing"}

ACK_TEXT = {
    mavlink.MAV_RESULT_ACCEPTED: "accepted",
    mavlink.MAV_RESULT_TEMPORARILY_REJECTED: "temporarily rejected",
    mavlink.MAV_RESULT_DENIED: "denied",
    mavlink.MAV_RESULT_UNSUPPORTED: "unsupported",
    mavlink.MAV_RESULT_FAILED: "failed",
    mavlink.MAV_RESULT_IN_PROGRESS: "in progress",
}

MISSION_PROTOCOL = ("MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_ACK", "MISSION_COUNT")


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _interp(samples, t, angle_idx=()):
    """samples: (time, v1, v2, ...) tuples, oldest first. The values at time t,
    linear between the two samples around it (angles the short way round), or
    the nearest sample if t is just outside them; None if none is close."""
    if not samples:
        return None
    if t <= samples[0][0]:
        return samples[0][1:] if samples[0][0] - t <= POSE_MAX_GAP_S else None
    if t >= samples[-1][0]:
        return samples[-1][1:] if t - samples[-1][0] <= POSE_MAX_GAP_S else None
    for i in range(len(samples) - 1, 0, -1):
        a, b = samples[i - 1], samples[i]
        if a[0] <= t <= b[0]:
            break
    if b[0] - a[0] > 2 * POSE_MAX_GAP_S:        # a hole in the telemetry: the nearer side, if near
        near = a if t - a[0] < b[0] - t else b
        return near[1:] if abs(t - near[0]) <= POSE_MAX_GAP_S else None
    f = (t - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
    out = []
    for k in range(1, len(a)):
        va, vb = a[k], b[k]
        if k in angle_idx:
            out.append((va + ((vb - va + 180) % 360 - 180) * f) % 360)
        else:
            out.append(va + (vb - va) * f)
    return tuple(out)


def mission_result_name(code):
    try:
        return mavlink.enums["MAV_MISSION_RESULT"][code].name.replace("MAV_MISSION_", "")
    except (KeyError, AttributeError):
        return str(code)


class LinkError(Exception):
    """A command could not be completed; the message is shown to the operator."""


class _Waiter:
    __slots__ = ("types", "pred", "event", "msg")

    def __init__(self, types, pred):
        self.types = types
        self.pred = pred
        self.event = threading.Event()
        self.msg = None


class DroneLink:
    def __init__(self, cfg):
        self.cfg = cfg
        self._m = None
        self._thread = None
        self._stop = threading.Event()
        self._send_lock = threading.Lock()
        self._cmd_lock = threading.Lock()      # one command sequence at a time
        self._state_lock = threading.Lock()
        self._waiters = []
        self._waiters_lock = threading.Lock()
        self._mission_q = queue.Queue()
        self._mission_listen = False
        self._reached_callbacks = []
        self._cand_index = 0
        self._cand_key = None
        self._opened_at = 0.0
        self._bad_bytes = 0
        self._tried = {}                       # "port @ baud" -> what was seen there
        self._worked_key = None                # the port/baud the Pixhawk last answered on
        self._reconnect = threading.Event()
        self.baud = None

        self.link_name = None                  # "usb" | "telem2" | "custom"
        self.connection = None
        self.target_system = None
        self.target_component = None
        self.last_fc_heartbeat = 0.0
        self.link_error = None
        self.messages = deque(maxlen=30)       # recent STATUSTEXT from the Pixhawk
        self.track = deque(maxlen=900)         # recent positions for the map trail
        # Recent positions (time, lat, lng, relative alt) and attitudes (time, roll,
        # pitch, yaw): pose_at() gives where the drone was when a video frame was
        # taken, so detections are placed from that, not from later telemetry.
        self._positions = deque(maxlen=POSE_KEEP)
        self._attitudes = deque(maxlen=POSE_KEEP)
        self._last_track = 0.0
        self.state = {
            "lat": None, "lng": None, "relative_alt": 0.0, "alt_msl": None, "climb": 0.0,
            "heading": None, "groundspeed": 0.0, "airspeed": 0.0, "throttle": 0,
            "roll": 0.0, "pitch": 0.0, "yaw": 0.0,
            "armed": False, "flight_mode": "UNKNOWN", "custom_mode": None, "landed_state": "unknown",
            "battery_voltage": None, "battery_current": None, "battery_percent": None,
            "satellites": 0, "gps_fix": 0, "hdop": None,
            "home_lat": None, "home_lng": None, "home_alt": None,
            "mission_seq": None, "mission_count": None,
        }

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        self._thread = threading.Thread(target=self._run, name="mavlink", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        self._close()

    def on_item_reached(self, fn):
        self._reached_callbacks.append(fn)

    def set_prefer(self, mode):
        """Switch the preferred physical link (auto | usb | telem2) and reconnect."""
        self.cfg.set("link_prefer", mode)
        self._cand_index = 0
        self._tried = {}
        self._worked_key = None
        self._reconnect.set()

    @property
    def fc_connected(self):
        return self.target_system is not None and (time.time() - self.last_fc_heartbeat) < FC_TIMEOUT_S

    def snapshot(self):
        with self._state_lock:
            s = dict(self.state)
        s["fc_connected"] = self.fc_connected
        s["link"] = self.link_name
        s["link_error"] = None if self.fc_connected else self.link_error
        s["messages"] = list(self.messages)[-8:]
        return s

    def recent_track(self, limit=300):
        return list(self.track)[-limit:]

    def pose_at(self, t):
        """Position and attitude at time t (time.time()), interpolated between
        telemetry samples: {"lat", "lng", "alt", "hdg", "roll", "pitch"} with
        None for what isn't known then (no GPS fix, no recent telemetry)."""
        with self._state_lock:
            pos = _interp(self._positions, t)
            att = _interp(self._attitudes, t, angle_idx=(3,))
        return {
            "lat": round(pos[0], 7) if pos else None, "lng": round(pos[1], 7) if pos else None,
            "alt": round(pos[2], 2) if pos else None,
            "hdg": round(att[2], 1) if att else None,
            "roll": round(att[0], 2) if att else None, "pitch": round(att[1], 2) if att else None,
        }

    # ------------------------------------------------------------------ connection
    @staticmethod
    def _usb_devices():
        """Flight controllers plugged in over USB (ArduPilot/PX4 boards show up as ttyACM), in
        any of the Pi's USB ports. By their /dev/serial/by-id name where there is one: it stays
        the same if the board drops off the bus and comes back as another ttyACM number."""
        found, real_seen = [], set()
        for path in sorted(glob.glob("/dev/serial/by-id/*")):
            real = os.path.realpath(path)
            if "ttyACM" in real and real not in real_seen:
                real_seen.add(real)
                found.append(path)
        for path in sorted(glob.glob("/dev/ttyACM*")):
            if path not in real_seen:
                found.append(path)
        return found

    def _candidates(self):
        """Every (name, device, baud) to try, in order. link_prefer narrows it down."""
        forced = (self.cfg["mav_connection"] or "").strip()
        if forced:
            return [("custom", forced, self.cfg["usb_baud"])]
        usb_devs = self._usb_devices() or [self.cfg["usb_device"]]
        usb = [("usb", d, self.cfg["usb_baud"]) for d in usb_devs]
        bauds = []
        for b in (self.cfg["telem2_baud"], *TELEM2_BAUDS):
            if b not in bauds:
                bauds.append(b)
        tel = [("telem2", self.cfg["telem2_device"], b) for b in bauds]
        plugged = usb if self._usb_devices() else []
        prefer = self.cfg["link_prefer"]
        # "Prefer" = try that first, but still find the Pixhawk on the other link
        # (a common mistake is choosing TELEM2 while the Pixhawk is on USB).
        if prefer == "usb":
            return usb + tel
        if prefer == "telem2":
            return tel + plugged
        # auto: a USB-connected Pixhawk first (if one is plugged in), then TELEM2 at each baud.
        return plugged + tel

    def _connect(self):
        cands = self._candidates()
        name, device, baud = cands[self._cand_index % len(cands)]
        key = f"{device} @ {baud}" if name == "telem2" else device
        if device.startswith("/dev/") and not os.path.exists(device):
            self._tried[key] = "not present"
            self._cand_index += 1
            self.link_error = self._summary()
            return
        try:
            log.info("Connecting to Pixhawk via %s (%s, baud %s)", name, device, baud)
            self._m = mavutil.mavlink_connection(
                device, baud=baud, source_system=GCS_SYSID, source_component=GCS_COMPID, autoreconnect=True)
            if device.startswith("udpout:"):
                # Say hello first: a phone relay (phone-link/relay.py) only learns where
                # to send once it hears from us, and Windows can't read a UDP socket
                # that hasn't sent anything yet.
                self._m.mav.heartbeat_send(mavlink.MAV_TYPE_GCS, mavlink.MAV_AUTOPILOT_INVALID, 0, 0,
                                           mavlink.MAV_STATE_ACTIVE)
            self.link_name, self.connection, self.baud = name, device, baud
            self._cand_key = key
            self._opened_at = time.time()
            self._bad_bytes = 0
            trying = f"Waiting for the Pixhawk heartbeat on {name} ({key})…"
            # Keep what earlier ports/bauds showed visible while the search goes on.
            self.link_error = f"{self._summary()} Now trying {name} ({key})…" if self._tried else trying
        except Exception as exc:  # serial port missing, permission denied, …
            self._m = None
            self._tried[key] = f"cannot open ({exc})"
            self.link_error = self._summary()
            log.warning("Cannot open %s: %s", device, exc)
            self._cand_index += 1

    def _summary(self):
        """What every port/baud tried so far looked like — shown to the operator."""
        if not self._tried:
            return "Looking for the Pixhawk…"
        parts = [f"{k}: {v}" for k, v in self._tried.items()]
        hint = ""
        seen = set(self._tried.values())
        if any(v.startswith("data") for v in seen):
            hint = (" Data arrives but isn't MAVLink at those speeds — check SERIAL2_PROTOCOL=2 and the baud "
                    "rate (SERIAL2_BAUD) on the Pixhawk.")
        elif all(v in ("no data", "not present") or v.startswith("cannot open") for v in seen):
            hint = (" Nothing at all comes from the Pixhawk — check it is powered, TELEM2 TX→Pi RX (pin 10) and "
                    "RX→Pi TX (pin 8) are not swapped, GND is connected, or plug it in by USB.")
        return "No Pixhawk found. Tried " + "; ".join(parts) + "." + hint

    def _close(self):
        m, self._m = self._m, None
        if m is not None:
            try:
                m.close()
            except Exception:
                pass

    def _remember_working_link(self):
        """Save the port/baud that works, so the next start finds it straight away."""
        try:
            changed = False
            if self.link_name == "telem2" and self.cfg["telem2_baud"] != self.baud:
                self.cfg.set("telem2_baud", self.baud)
                changed = True
            if self.link_name == "usb" and self.cfg["usb_device"] != self.connection:
                self.cfg.set("usb_device", self.connection)
                changed = True
            # Found on the other link than the preferred one: the preference was
            # wrong, and would make every start search the wrong port first.
            prefer = self.cfg["link_prefer"]
            if prefer in ("usb", "telem2") and self.link_name in ("usb", "telem2") and prefer != self.link_name:
                self.cfg.set("link_prefer", "auto")
                changed = True
            if changed:
                self.cfg.save()
                log.info("Saved the working Pixhawk link: %s %s @ %s", self.link_name, self.connection, self.baud)
        except Exception as exc:
            log.warning("Could not save the working link: %s", exc)

    def _run(self):
        last_hb = last_stream = last_home = last_usb = 0.0
        usb_seen = ()
        while not self._stop.is_set():
            if self._reconnect.is_set():
                self._reconnect.clear()
                self._close()
                self.target_system = None
                self._tried = {}
            if self._m is None:
                self._connect()
                if self._m is None:
                    self._stop.wait(0.5)
                    continue
            try:
                msg = self._m.recv_match(blocking=True, timeout=0.2)
            except Exception as exc:
                if isinstance(exc, ConnectionResetError) and str(self.connection or "").startswith("udpout:"):
                    # udpout on Windows: our heartbeat reached a port nobody listens on
                    # yet (the phone relay isn't running). Nothing is wrong with the link:
                    # keep the socket and wait, as on Linux.
                    if not self.fc_connected:
                        self.link_error = (f"Waiting for the phone relay at {self.connection[7:]} — is relay.py "
                                           "running on the phone, and the phone on NetBird?")
                    self._stop.wait(0.5)
                    continue
                self._tried[self._cand_key] = f"error ({exc})"
                self.link_error = self._summary()
                log.warning("Link error on %s: %s", self._cand_key, exc)
                self._close()
                self._cand_index += 1
                self._stop.wait(1)
                continue
            if msg is not None:
                if msg.get_type() == "BAD_DATA":
                    self._bad_bytes += len(getattr(msg, "data", b"") or b"")
                else:
                    was_connected = self.fc_connected
                    try:
                        self._handle(msg)
                    except Exception:
                        log.exception("Failed to handle %s", msg.get_type())
                    if not was_connected and self.fc_connected:
                        self._tried = {self._cand_key: "connected"}
                        self._worked_key = self._cand_key
                        self._remember_working_link()

            now = time.time()
            if now - last_hb >= 1.0:
                last_hb = now
                self._send(lambda m: m.mav.heartbeat_send(
                    mavlink.MAV_TYPE_GCS, mavlink.MAV_AUTOPILOT_INVALID, 0, 0, mavlink.MAV_STATE_ACTIVE))
            if self.fc_connected:
                if now - last_stream >= 15.0:
                    last_stream = now
                    self._request_streams()
                if self.state["home_lat"] is None and now - last_home >= 5.0:
                    last_home = now
                    self._send(lambda m: m.mav.command_long_send(
                        self.target_system, self.target_component,
                        mavlink.MAV_CMD_GET_HOME_POSITION, 0, 0, 0, 0, 0, 0, 0, 0))
            else:
                if self.target_system is not None and now - self.last_fc_heartbeat > FC_TIMEOUT_S:
                    self.link_error = f"No heartbeat from the Pixhawk on {self.link_name} — check the cable and power."
                    last_stream = 0.0
                # Plugged in over USB while the search is on TELEM2: go to it now, rather than
                # after every TELEM2 speed has had its turn (USB comes first in the list). Only
                # when a USB device newly appears, so a USB gadget that isn't the Pixhawk can't
                # keep pulling the search back to it.
                if (now - last_usb >= USB_CHECK_S and self.link_name != "usb"
                        and self.cfg["link_prefer"] in ("usb", "auto") and not (self.cfg["mav_connection"] or "").strip()):
                    last_usb = now
                    devs = tuple(self._usb_devices())
                    appeared, usb_seen = bool(devs) and devs != usb_seen, devs
                    if appeared:
                        log.info("Pixhawk plugged in over USB — switching to it.")
                        self._close()
                        self._cand_index = 0
                        self.target_system = None
                        continue
                # Silent for a while: record what this port/baud looked like, then try the next one.
                # The link that was working gets longer: a short dropout in flight (loose plug,
                # radio noise) must not send the search off through every other port for a minute.
                limit = WORKED_SWITCH_S if self._cand_key == self._worked_key else SILENT_SWITCH_S
                if now - max(self._opened_at, self.last_fc_heartbeat) > limit:
                    self._tried[self._cand_key] = (f"data but no MAVLink ({self._bad_bytes} bytes)"
                                                   if self._bad_bytes > 20 else "no data")
                    self.link_error = self._summary()
                    if len(self._candidates()) > 1:
                        log.info("No heartbeat on %s — trying the next port/baud.", self._cand_key)
                        self._close()
                        self._cand_index += 1
                        self.target_system = None
                    else:
                        self._opened_at = now          # single option: keep listening, re-check later
                        self._bad_bytes = 0

    def _send(self, fn):
        m = self._m
        if m is None:
            return False
        try:
            with self._send_lock:
                fn(m)
            return True
        except Exception as exc:
            log.warning("Send failed: %s", exc)
            return False

    def _request_streams(self):
        usb = self.link_name == "usb"
        stream_hz, pose_hz = (STREAM_HZ_USB, POSE_HZ_USB) if usb else (STREAM_HZ, POSE_HZ)
        self._send(lambda m: m.mav.request_data_stream_send(
            self.target_system, self.target_component, mavlink.MAV_DATA_STREAM_ALL, stream_hz, 1))
        # Position and attitude faster than the rest, to place detections in the video.
        for msg_id in (mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, mavlink.MAVLINK_MSG_ID_ATTITUDE):
            self._send(lambda m, i=msg_id: m.mav.command_long_send(
                self.target_system, self.target_component, mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
                i, 1_000_000 // pose_hz, 0, 0, 0, 0, 0))
        # Landed state (on ground / in air) is not part of the classic streams.
        self._send(lambda m: m.mav.command_long_send(
            self.target_system, self.target_component, mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
            mavlink.MAVLINK_MSG_ID_EXTENDED_SYS_STATE, 1_000_000, 0, 0, 0, 0, 0))

    # ------------------------------------------------------------------ incoming
    def _handle(self, msg):
        t = msg.get_type()
        if t == "BAD_DATA":
            return
        now = time.time()

        if t == "HEARTBEAT":
            # Ignore other ground stations / companion software / gimbals on the link.
            if msg.type == mavlink.MAV_TYPE_GCS or msg.autopilot == mavlink.MAV_AUTOPILOT_INVALID:
                return
            if self.target_system is None:
                log.info("Pixhawk found on %s: system %s component %s",
                         self.link_name, msg.get_srcSystem(), msg.get_srcComponent())
            self.target_system = msg.get_srcSystem()
            self.target_component = msg.get_srcComponent()
            self.last_fc_heartbeat = now
            self.link_error = None
            with self._state_lock:
                self.state["armed"] = bool(msg.base_mode & mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                self.state["custom_mode"] = msg.custom_mode
                self.state["flight_mode"] = MODE_NAMES.get(msg.custom_mode, f"MODE {msg.custom_mode}")
            self._notify_waiters(t, msg)
            return

        if self.target_system is not None and msg.get_srcSystem() != self.target_system:
            return

        with self._state_lock:
            s = self.state
            if t == "GLOBAL_POSITION_INT":
                if msg.lat or msg.lon:
                    s["lat"] = msg.lat / 1e7
                    s["lng"] = msg.lon / 1e7
                s["relative_alt"] = msg.relative_alt / 1000.0
                s["alt_msl"] = msg.alt / 1000.0
                s["climb"] = -msg.vz / 100.0
                if msg.hdg != 65535:
                    s["heading"] = msg.hdg / 100.0
                s["groundspeed"] = math.hypot(msg.vx, msg.vy) / 100.0
                if msg.lat or msg.lon:
                    self._positions.append((now, msg.lat / 1e7, msg.lon / 1e7, msg.relative_alt / 1000.0))
                if s["lat"] is not None and now - self._last_track >= 1.0:
                    self._last_track = now
                    self.track.append({"t": round(now, 1), "lat": s["lat"], "lng": s["lng"],
                                       "alt": round(s["relative_alt"], 1)})
            elif t == "GPS_RAW_INT":
                s["gps_fix"] = msg.fix_type
                s["satellites"] = 0 if msg.satellites_visible == 255 else msg.satellites_visible
                s["hdop"] = None if msg.eph == 65535 else msg.eph / 100.0
            elif t == "SYS_STATUS":
                s["battery_voltage"] = None if msg.voltage_battery in (0, 65535) else msg.voltage_battery / 1000.0
                s["battery_current"] = None if msg.current_battery < 0 else msg.current_battery / 100.0
                s["battery_percent"] = None if msg.battery_remaining < 0 else msg.battery_remaining
            elif t == "VFR_HUD":
                s["groundspeed"] = float(msg.groundspeed)
                s["airspeed"] = float(msg.airspeed)
                s["throttle"] = int(msg.throttle)
                if s["heading"] is None:
                    s["heading"] = float(msg.heading)
            elif t == "ATTITUDE":
                s["roll"] = round(math.degrees(msg.roll), 2)
                s["pitch"] = round(math.degrees(msg.pitch), 2)
                s["yaw"] = round(math.degrees(msg.yaw) % 360, 1)
                self._attitudes.append((now, math.degrees(msg.roll), math.degrees(msg.pitch),
                                        math.degrees(msg.yaw) % 360))
            elif t == "HOME_POSITION":
                s["home_lat"] = msg.latitude / 1e7
                s["home_lng"] = msg.longitude / 1e7
                s["home_alt"] = msg.altitude / 1000.0
            elif t == "MISSION_CURRENT":
                s["mission_seq"] = msg.seq
            elif t == "EXTENDED_SYS_STATE":
                s["landed_state"] = LANDED.get(msg.landed_state, "unknown")

        if t == "STATUSTEXT":
            text = (msg.text or "").replace("\x00", "").strip()
            if text:
                self.messages.append({"t": round(now, 1), "severity": int(msg.severity), "text": text})
                log.info("Pixhawk: %s", text)
        elif t == "MISSION_ITEM_REACHED":
            for fn in list(self._reached_callbacks):
                try:
                    fn(msg.seq)
                except Exception:
                    log.exception("item-reached callback failed")

        if t in MISSION_PROTOCOL and self._mission_listen:
            target = getattr(msg, "target_system", GCS_SYSID)
            if target in (0, GCS_SYSID):
                self._mission_q.put(msg)
        self._notify_waiters(t, msg)

    def _notify_waiters(self, t, msg):
        with self._waiters_lock:
            if not self._waiters:
                return
            done = [w for w in self._waiters if t in w.types and w.pred(msg)]
            for w in done:
                w.msg = msg
                w.event.set()
                self._waiters.remove(w)

    def _expect(self, types, pred=lambda m: True):
        w = _Waiter(set(types), pred)
        with self._waiters_lock:
            self._waiters.append(w)
        return w

    def _wait(self, w, timeout):
        ok = w.event.wait(timeout)
        if not ok:
            with self._waiters_lock:
                if w in self._waiters:
                    self._waiters.remove(w)
        return w.msg if ok else None

    def _latest_warning(self, since, wait=1.5):
        """The Pixhawk's own reason for a refusal. Its STATUSTEXT usually lands
        just AFTER the COMMAND_ACK, so give it a moment."""
        end = time.time() + wait
        while True:
            for m in reversed(self.messages):
                if m["t"] >= since - 0.5 and m["severity"] <= mavlink.MAV_SEVERITY_WARNING:
                    return m["text"]
            if time.time() >= end:
                return None
            time.sleep(0.1)

    # ------------------------------------------------------------------ commands
    def _require_fc(self):
        if not self.fc_connected:
            raise LinkError(self.link_error or "The Pixhawk is not connected.")

    def command_long(self, command, params, timeout=3.0):
        """Send COMMAND_LONG and wait for its COMMAND_ACK. Returns the MAV_RESULT."""
        self._require_fc()
        p = list(params) + [0] * (7 - len(params))
        for attempt in range(2):
            w = self._expect(("COMMAND_ACK",), lambda m: m.command == command)
            self._send(lambda m: m.mav.command_long_send(
                self.target_system, self.target_component, command, attempt, *p))
            ack = self._wait(w, timeout)
            if ack is not None:
                return ack.result
        raise LinkError("The Pixhawk did not answer the command (no COMMAND_ACK).")

    def _wait_state(self, check, timeout):
        end = time.time() + timeout
        while time.time() < end:
            with self._state_lock:
                if check(self.state):
                    return True
            time.sleep(0.1)
        return False

    def _gps_hint(self, what):
        with self._state_lock:
            fix, sats = self.state["gps_fix"], self.state["satellites"]
        if fix < 3:
            return (f" The drone has no GPS fix yet ({sats} satellites) — {what} needs one. "
                    "Take it outside with a clear view of the sky and wait a minute.")
        return ""

    def set_mode(self, name):
        name = str(name).upper().strip().replace(" ", "_")
        if name == "RTH":
            name = "RTL"
        if name not in COPTER_MODES:
            raise LinkError(f"Unknown flight mode '{name}'. Use one of: {', '.join(sorted(COPTER_MODES))}.")
        number = COPTER_MODES[name]
        with self._cmd_lock:
            if self.state["custom_mode"] == number:
                return f"Already in {name}."
            started = time.time()
            result = self.command_long(mavlink.MAV_CMD_DO_SET_MODE,
                                       [mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, number])
            if result == mavlink.MAV_RESULT_UNSUPPORTED:
                self._send(lambda m: m.mav.set_mode_send(
                    self.target_system, mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, number))
            elif result != mavlink.MAV_RESULT_ACCEPTED:
                reason = self._latest_warning(started)
                hint = self._gps_hint(name) if name in GPS_MODES else ""
                raise LinkError(f"Mode {name} {ACK_TEXT.get(result, result)}"
                                + (f": {reason.rstrip('.')}." if reason else ".") + hint)
            if not self._wait_state(lambda s: s["custom_mode"] == number, 3.0):
                raise LinkError(f"The Pixhawk accepted {name} but did not switch to it.")
            return f"Mode set to {name}."

    def arm(self, arm, force=False):
        with self._cmd_lock:
            if self.state["armed"] == bool(arm):
                return "Already armed." if arm else "Already disarmed."
            started = time.time()
            result = self.command_long(mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                                       [1 if arm else 0, FORCE_DISARM_MAGIC if force else 0])
            if result != mavlink.MAV_RESULT_ACCEPTED:
                reason = self._latest_warning(started)
                verb = "Arming" if arm else "Disarming"
                raise LinkError(f"{verb} {ACK_TEXT.get(result, result)}"
                                + (f": {reason.rstrip('.')}." if reason else ".")
                                + (" Disarming is refused while flying — land first." if not arm else ""))
            if not self._wait_state(lambda s: s["armed"] == bool(arm), 3.0):
                raise LinkError("The Pixhawk accepted the command but the arm state did not change.")
            return "Motors armed." if arm else "Motors disarmed."

    def arm_ready(self):
        """Arm in a mode where the copter stays put (GUIDED if it has GPS)."""
        snap = self.snapshot()
        if snap["armed"]:
            return "Already armed."
        if snap["flight_mode"] not in ARMABLE_MODES:
            self.set_mode("GUIDED")
        return self.arm(True)

    def takeoff(self, altitude):
        """GUIDED take-off to `altitude` metres above home, arming first if needed."""
        self._require_fc()
        snap = self.snapshot()
        if snap["armed"] and snap["relative_alt"] > 1.0 and snap["landed_state"] != "on_ground":
            raise LinkError("The drone is already flying.")
        self.set_mode("GUIDED")
        armed_here = False
        if not self.snapshot()["armed"]:
            self.arm(True)
            armed_here = True
        with self._cmd_lock:
            started = time.time()
            result = self.command_long(mavlink.MAV_CMD_NAV_TAKEOFF, [0, 0, 0, float("nan"), 0, 0, float(altitude)])
            if result != mavlink.MAV_RESULT_ACCEPTED:
                reason = self._latest_warning(started)
                err = f"Take-off {ACK_TEXT.get(result, result)}" + (f": {reason.rstrip('.')}." if reason else ".")
            else:
                err = None
        if err:
            if armed_here:
                try:
                    self.arm(False)
                except LinkError:
                    pass
            raise LinkError(err)
        return f"Taking off to {altitude:g} m."

    def send_velocity(self, vn, ve, vd, yaw_rate):
        """GUIDED: fly at this velocity (m/s north, east, down) and yaw rate
        (rad/s). ArduCopter holds it level and in place by itself; with no new
        command for 3 s it stops and hovers. Ignored in every other mode."""
        if self.target_system is None:
            return False
        # Use velocity + yaw rate; ignore position, acceleration and yaw angle.
        mask = 0b0000_0101_1100_0111
        ts, tc = self.target_system, self.target_component
        return self._send(lambda m: m.mav.set_position_target_local_ned_send(
            0, ts, tc, mavlink.MAV_FRAME_LOCAL_NED, mask,
            0, 0, 0, float(vn), float(ve), float(vd), 0, 0, 0, 0, float(yaw_rate)))

    def get_param(self, name, timeout=3.0):
        """A Pixhawk parameter's value, or None if it didn't answer / has no such parameter."""
        self._require_fc()
        for _ in range(2):
            w = self._expect(("PARAM_VALUE",), lambda m: m.param_id == name)
            self._send(lambda m: m.mav.param_request_read_send(
                self.target_system, self.target_component, name.encode(), -1))
            msg = self._wait(w, timeout)
            if msg is not None:
                return float(msg.param_value)
        return None

    def set_param(self, name, value, timeout=3.0):
        """Set a Pixhawk parameter and confirm it took. Returns the stored value."""
        self._require_fc()
        for _ in range(2):
            w = self._expect(("PARAM_VALUE",), lambda m: m.param_id == name)
            self._send(lambda m: m.mav.param_set_send(
                self.target_system, self.target_component, name.encode(), float(value),
                mavlink.MAV_PARAM_TYPE_REAL32))
            msg = self._wait(w, timeout)
            if msg is not None:
                if abs(float(msg.param_value) - float(value)) > 1e-3:
                    raise LinkError(f"The Pixhawk kept {name} = {msg.param_value:g} (asked for {value:g}).")
                return float(msg.param_value)
        raise LinkError(f"The Pixhawk did not confirm {name}.")

    def mission_start(self):
        with self._cmd_lock:
            started = time.time()
            result = self.command_long(mavlink.MAV_CMD_MISSION_START, [0, 0])
            if result != mavlink.MAV_RESULT_ACCEPTED:
                reason = self._latest_warning(started)
                raise LinkError(f"Mission start {ACK_TEXT.get(result, result)}" + (f": {reason.rstrip('.')}." if reason else "."))

    def set_current_item(self, seq):
        self._require_fc()
        self._send(lambda m: m.mav.mission_set_current_send(self.target_system, self.target_component, seq))
        return self._wait_state(lambda s: s["mission_seq"] == seq, 3.0)

    def upload_mission(self, items, timeout=30.0, mission_type=mavlink.MAV_MISSION_TYPE_MISSION):
        """Run the MAVLink mission upload protocol. `items` are dicts with
        command/frame/param1-4/lat/lng/alt. mission_type MAV_MISSION_TYPE_FENCE
        uploads a geofence instead (polygon vertices). Raises LinkError on failure."""
        self._require_fc()
        if not items:
            raise LinkError("Nothing to upload.")
        with self._cmd_lock:
            while not self._mission_q.empty():
                self._mission_q.get_nowait()
            self._mission_listen = True
            try:
                return self._upload(items, timeout, mission_type)
            finally:
                self._mission_listen = False

    def _upload(self, items, timeout, mission_type=mavlink.MAV_MISSION_TYPE_MISSION):
        n = len(items)
        ts, tc = self.target_system, self.target_component

        def send_count():
            if not self._send(lambda m: m.mav.mission_count_send(ts, tc, n, mission_type)):
                raise LinkError("Lost the link to the Pixhawk during the mission upload.")

        # Encode every item up front, so a bad value fails here with a clear
        # message instead of as a silent send error halfway through the protocol.
        def num(v):
            return 0.0 if v is None else float(v)
        packed = []
        for seq, it in enumerate(items):
            try:
                packed.append((it.get("frame", mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT), int(it["command"]),
                               num(it.get("param1")), num(it.get("param2")), num(it.get("param3")), num(it.get("param4")),
                               int(round(num(it.get("lat")) * 1e7)), int(round(num(it.get("lng")) * 1e7)), num(it.get("alt"))))
            except (KeyError, TypeError, ValueError) as exc:
                raise LinkError(f"Mission item {seq} is invalid: {exc}")

        def send_item(seq):
            f, cmd, p1, p2, p3, p4, x, y, z = packed[seq]
            if not self._send(lambda m: m.mav.mission_item_int_send(
                    ts, tc, seq, f, cmd, 0, 1, p1, p2, p3, p4, x, y, z, mission_type)):
                raise LinkError("Lost the link to the Pixhawk during the mission upload.")

        send_count()
        deadline = time.time() + timeout
        last_sent = None
        retries = 0
        sent = set()
        while time.time() < deadline:
            try:
                msg = self._mission_q.get(timeout=2.0)
            except queue.Empty:
                retries += 1
                if retries > 5:
                    break
                if last_sent is None:
                    send_count()
                else:
                    send_item(last_sent)
                continue
            t = msg.get_type()
            if t in ("MISSION_REQUEST", "MISSION_REQUEST_INT"):
                if msg.seq >= n:
                    raise LinkError(f"The Pixhawk asked for item {msg.seq} of {n}.")
                send_item(msg.seq)
                last_sent = msg.seq
                sent.add(msg.seq)
                retries = 0
            elif t == "MISSION_ACK":
                if msg.type == mavlink.MAV_MISSION_ACCEPTED:
                    if len(sent) < n:
                        raise LinkError("The Pixhawk accepted the mission before receiving every item.")
                    if mission_type == mavlink.MAV_MISSION_TYPE_MISSION:
                        with self._state_lock:
                            self.state["mission_count"] = n
                    return n
                raise LinkError(f"The Pixhawk rejected the mission: {mission_result_name(msg.type)}.")
        raise LinkError("Mission upload timed out — the Pixhawk stopped answering.")
