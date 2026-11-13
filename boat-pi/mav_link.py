"""
MAVLink link between the boat's Raspberry Pi and its Pixhawk (ArduRover, boat frame).

One background thread owns the connection: it reads every message, keeps the
latest vehicle state, sends the GCS heartbeat the Pixhawk's failsafe watches,
re-requests telemetry streams and reconnects if the cable or port drops.

Commands (arm, mode, mission upload) run in the caller's thread. Replies they
wait for (COMMAND_ACK, mission protocol messages) are handed over by the reader
thread, so no two threads ever read from the connection.
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
log = logging.getLogger("boat.mav")

# ArduRover flight modes (custom_mode numbers).
ROVER_MODES = {
    "MANUAL": 0, "ACRO": 1, "STEERING": 3, "HOLD": 4, "LOITER": 5, "FOLLOW": 6,
    "SIMPLE": 7, "DOCK": 8, "CIRCLE": 9, "AUTO": 10, "RTL": 11, "SMART_RTL": 12,
    "GUIDED": 15, "INITIALISING": 16,
}
MODE_NAMES = {v: k for k, v in ROVER_MODES.items()}

GCS_SYSID = 255
GCS_COMPID = mavlink.MAV_COMP_ID_MISSIONPLANNER
FORCE_DISARM_MAGIC = 21196
FC_TIMEOUT_S = 3.5
SILENT_SWITCH_S = 6.0   # try the next port/baud after this long without a heartbeat
WORKED_SWITCH_S = 30.0  # ...but stay this long on a link that already worked
TELEM2_DEVICE = "/dev/serial0"
USB_BAUD = 115200
# TELEM2 speeds to try (SERIAL2_BAUD on the Pixhawk): 57, 115, 921, 230, 460, 500, 1500 (x1000).
TELEM2_BAUDS = (57600, 115200, 921600, 230400, 460800, 500000, 1500000)

ACK_TEXT = {
    mavlink.MAV_RESULT_ACCEPTED: "accepted",
    mavlink.MAV_RESULT_TEMPORARILY_REJECTED: "temporarily rejected",
    mavlink.MAV_RESULT_DENIED: "denied",
    mavlink.MAV_RESULT_UNSUPPORTED: "unsupported",
    mavlink.MAV_RESULT_FAILED: "failed",
    mavlink.MAV_RESULT_IN_PROGRESS: "in progress",
}

# What the boat reads, per ArduPilot stream group (everything else stays off):
#   POSITION        GLOBAL_POSITION_INT: position + heading, also matched to camera frames
#   EXTRA1          ATTITUDE
#   EXTRA2          VFR_HUD: ground speed, throttle
#   EXTENDED_STATUS SYS_STATUS (battery), GPS_RAW_INT, MISSION_CURRENT
# HEARTBEAT, STATUSTEXT, MISSION_ITEM_REACHED and command / mission replies
# always come, whatever the stream rates.
STREAM_RATES = (
    (mavlink.MAV_DATA_STREAM_POSITION, 5),
    (mavlink.MAV_DATA_STREAM_EXTRA1, 2),
    (mavlink.MAV_DATA_STREAM_EXTRA2, 2),
    (mavlink.MAV_DATA_STREAM_EXTENDED_STATUS, 1),
)

MISSION_PROTOCOL = ("MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_ACK", "MISSION_COUNT",
                    "MISSION_ITEM_INT", "MISSION_ITEM")


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def mission_result_name(code):
    try:
        return mavlink.enums["MAV_MISSION_RESULT"][code].name.replace("MAV_MISSION_", "")
    except (KeyError, AttributeError):
        return str(code)


class _Waiter:
    __slots__ = ("types", "pred", "event", "msg")

    def __init__(self, types, pred):
        self.types = types
        self.pred = pred
        self.event = threading.Event()
        self.msg = None


def usb_devices():
    """Flight controllers plugged in over USB (ArduPilot boards show up as ttyACM)."""
    found = []
    for path in sorted(glob.glob("/dev/serial/by-id/*")):
        real = os.path.realpath(path)
        if "ttyACM" in real and real not in found:
            found.append(real)
    for path in sorted(glob.glob("/dev/ttyACM*")):
        if path not in found:
            found.append(path)
    return found


class BoatLink:
    def __init__(self, connection, baud=57600, on_link_found=None):
        # The configured link is tried first. If the Pixhawk doesn't answer
        # there, every USB port and TELEM2 speed is tried in turn (a Pixhawk on
        # USB while TELEM2 is configured, or a different SERIAL2_BAUD, is the
        # most common reason a new boat "never connects"). on_link_found(device,
        # baud) is called once a link works, so it can be saved.
        self.connection = connection
        self.baud = baud
        self.configured = (connection, baud)
        self.on_link_found = on_link_found
        self._cand_index = 0
        self._cand_key = None
        self._opened_at = 0.0
        self._bad_bytes = 0
        self._tried = {}                       # "port @ baud" -> what was seen there
        self._worked = False                   # the configured link has answered at least once
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

        self.target_system = None
        self.target_component = None
        self.last_fc_heartbeat = 0.0
        self.link_error = None
        self.messages = deque(maxlen=30)       # recent STATUSTEXT from the Pixhawk
        self.track = deque(maxlen=600)         # recent positions for the map trail
        self._last_track = 0.0
        # Every position report for the last ~15 s, so a camera frame can be
        # matched to where the boat was (and which way it faced) when taken.
        self.poses = deque(maxlen=150)
        self.state = {
            "lat": None, "lng": None, "relative_alt": 0.0,
            "heading": None, "groundspeed": 0.0, "throttle": 0,
            "roll": 0.0, "pitch": 0.0, "yaw": 0.0,
            "armed": False, "flight_mode": "UNKNOWN", "custom_mode": None,
            "battery_voltage": None, "battery_percent": None,
            "satellites": 0, "gps_fix": 0,
            "home_lat": None, "home_lng": None,
            "mission_seq": None, "mission_count": None,
            "board_v": None, "servo_v": None, "board_v_t": 0.0,   # POWER_STATUS: Pixhawk 5 V rail, servo rail
            "servo_out": None, "servo_out_t": 0.0,                # SERVO_OUTPUT_RAW: µs on outputs 1–8
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

    @property
    def fc_connected(self):
        return self.target_system is not None and (time.time() - self.last_fc_heartbeat) < FC_TIMEOUT_S

    def snapshot(self):
        with self._state_lock:
            s = dict(self.state)
        s["fc_connected"] = self.fc_connected
        s["link_error"] = None if self.fc_connected else self.link_error
        s["messages"] = list(self.messages)[-8:]
        return s

    def recent_track(self, limit=300):
        return list(self.track)[-limit:]

    def pose_at(self, t):
        """(lat, lng, heading) at time t, interpolated from the position history;
        None if the history doesn't reach back that far (or there is none)."""
        poses = list(self.poses)
        if not poses:
            return None
        if t >= poses[-1][0]:
            return poses[-1][1:] if t - poses[-1][0] < 2.0 else None
        if t < poses[0][0]:
            return None
        for a, b in zip(poses, poses[1:]):
            if a[0] <= t <= b[0]:
                k = (t - a[0]) / max(1e-6, b[0] - a[0])
                ha, hb = a[3] or 0.0, b[3] or 0.0
                dh = (hb - ha + 540) % 360 - 180
                return (a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, (ha + dh * k) % 360)
        return poses[-1][1:]

    # ------------------------------------------------------------------ connection
    def _candidates(self):
        """(device, baud) pairs to try, configured one first. Network links
        (simulator, SITL) are used as they are."""
        dev, baud = self.configured
        if not str(dev).startswith("/dev/"):
            return [(dev, baud)]
        return self._serial_candidates()

    def _serial_candidates(self):
        out = [self.configured]
        out += [(d, USB_BAUD) for d in usb_devices()]
        out += [(TELEM2_DEVICE, b) for b in TELEM2_BAUDS]
        seen, unique = set(), []
        for dev, baud in out:
            key = self._key(dev, baud)
            if key not in seen:
                seen.add(key)
                unique.append((dev, baud))
        return unique

    @staticmethod
    def _key(dev, baud):
        # A USB flight controller ignores the baud rate: one entry per port.
        return dev if "ttyACM" in dev or "/by-id/" in dev else f"{dev} @ {baud}"

    def _connect(self):
        cands = self._candidates()
        device, baud = cands[self._cand_index % len(cands)]
        key = self._key(device, baud)
        if device.startswith("/dev/") and not os.path.exists(device):
            self._tried[key] = "not present"
            self._cand_index += 1
            self.link_error = self._summary()
            return
        try:
            log.info("Connecting to Pixhawk on %s (baud %s)", device, baud)
            self._m = mavutil.mavlink_connection(
                device, baud=baud,
                source_system=GCS_SYSID, source_component=GCS_COMPID,
                autoreconnect=True,
            )
            self.connection, self.baud, self._cand_key = device, baud, key
            self._opened_at = time.time()
            self._bad_bytes = 0
            trying = f"Waiting for the Pixhawk heartbeat on {key}…"
            # Keep what earlier ports/bauds showed visible while the search goes on.
            self.link_error = f"{self._summary()} Now trying {key}…" if self._tried else trying
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

    def _found(self):
        self._tried = {self._cand_key: "connected"}
        self._worked = True
        if (self.connection, self.baud) != self.configured:
            log.info("Pixhawk found on %s — remembering it.", self._cand_key)
            self.configured = (self.connection, self.baud)
            self._cand_index = 0
            if self.on_link_found:
                try:
                    self.on_link_found(self.connection, self.baud)
                except Exception as exc:
                    log.warning("Could not save the working link: %s", exc)

    def _run(self):
        last_hb = last_stream = last_home = 0.0
        while not self._stop.is_set():
            if self._m is None:
                self._connect()
                if self._m is None:
                    self._stop.wait(0.5)
                    continue
            try:
                msg = self._m.recv_match(blocking=True, timeout=0.2)
            except Exception as exc:
                # USB cable pulled, port gone, …: note it and move on.
                self._tried[self._cand_key] = f"error ({exc})"
                self.link_error = f"Link error on {self._cand_key}: {exc}"
                log.warning(self.link_error)
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
                        self._found()

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
                    self.link_error = "No heartbeat from the Pixhawk — check the TELEM cable and power."
                    last_stream = 0.0
                # Silent for a while: record what this port/baud looked like, then try the next one.
                # A link that already worked gets longer (a Pixhawk reboot, a loose plug) before
                # the search moves away from it.
                limit = WORKED_SWITCH_S if self._cand_key == self._key(*self.configured) and self._worked                     else SILENT_SWITCH_S
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
        """Ask for only the messages the boat uses. "Everything at 4 Hz" is ~90
        messages a second from ArduRover — over half of a 57600-baud link, with
        commands and mission uploads queuing behind sensor data nobody reads, and
        every message decoded in Python on a Pi Zero. This is ~20 a second."""
        ts, tc = self.target_system, self.target_component
        self._send(lambda m: m.mav.request_data_stream_send(ts, tc, mavlink.MAV_DATA_STREAM_ALL, 0, 0))
        for stream, hz in STREAM_RATES:
            self._send(lambda m, s=stream, r=hz: m.mav.request_data_stream_send(ts, tc, s, r, 1))
        # What the Pixhawk actually sends each motor output (motor setup check, the app's readout).
        self.set_message_rate(36, 4)                            # SERVO_OUTPUT_RAW

    def set_message_rate(self, msg_id, hz):
        """MAV_CMD_SET_MESSAGE_INTERVAL, fire and forget (no answer awaited)."""
        if self.target_system is None:
            return
        ts, tc = self.target_system, self.target_component
        us = int(1e6 / hz) if hz > 0 else -1
        self._send(lambda m: m.mav.command_long_send(ts, tc, mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
                                                     msg_id, us, 0, 0, 0, 0, 0))

    # ------------------------------------------------------------------ incoming
    def _handle(self, msg):
        t = msg.get_type()
        if t == "BAD_DATA":
            return
        now = time.time()

        if t == "HEARTBEAT":
            # Ignore other ground stations / companion software on the link.
            if msg.type == mavlink.MAV_TYPE_GCS or msg.autopilot == mavlink.MAV_AUTOPILOT_INVALID:
                return
            if self.target_system is None:
                log.info("Pixhawk found: system %s component %s", msg.get_srcSystem(), msg.get_srcComponent())
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
                if msg.hdg != 65535:
                    s["heading"] = msg.hdg / 100.0
                s["groundspeed"] = math.hypot(msg.vx, msg.vy) / 100.0
                if s["lat"] is not None:
                    self.poses.append((now, s["lat"], s["lng"], s["heading"] if s["heading"] is not None else s["yaw"]))
                if s["lat"] is not None and now - self._last_track >= 1.0:
                    self._last_track = now
                    self.track.append({"t": round(now, 1), "lat": s["lat"], "lng": s["lng"]})
            elif t == "GPS_RAW_INT":
                s["gps_fix"] = msg.fix_type
                s["satellites"] = 0 if msg.satellites_visible == 255 else msg.satellites_visible
            elif t == "SYS_STATUS":
                s["battery_voltage"] = None if msg.voltage_battery in (0, 65535) else msg.voltage_battery / 1000.0
                s["battery_percent"] = None if msg.battery_remaining < 0 else msg.battery_remaining
            elif t == "VFR_HUD":
                s["groundspeed"] = float(msg.groundspeed)
                s["throttle"] = int(msg.throttle)
                if s["heading"] is None:
                    s["heading"] = float(msg.heading)
            elif t == "ATTITUDE":
                s["roll"] = round(math.degrees(msg.roll), 2)
                s["pitch"] = round(math.degrees(msg.pitch), 2)
                s["yaw"] = round(math.degrees(msg.yaw) % 360, 1)
            elif t == "HOME_POSITION":
                s["home_lat"] = msg.latitude / 1e7
                s["home_lng"] = msg.longitude / 1e7
            elif t == "MISSION_CURRENT":
                s["mission_seq"] = msg.seq
            elif t == "SERVO_OUTPUT_RAW":
                s["servo_out"] = [msg.servo1_raw, msg.servo2_raw, msg.servo3_raw, msg.servo4_raw,
                                  msg.servo5_raw, msg.servo6_raw, msg.servo7_raw, msg.servo8_raw]
                s["servo_out_t"] = now
            elif t == "POWER_STATUS":
                s["board_v"] = msg.Vcc / 1000.0 if msg.Vcc else None
                s["servo_v"] = msg.Vservo / 1000.0 if msg.Vservo else None
                s["board_v_t"] = now

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
        just AFTER the COMMAND_ACK, so give it a moment rather than reporting a
        bare 'failed' to the operator."""
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

    def set_mode(self, name):
        name = str(name).upper().strip()
        if name not in ROVER_MODES:
            raise LinkError(f"Unknown boat mode '{name}'. Use one of: {', '.join(sorted(ROVER_MODES))}.")
        number = ROVER_MODES[name]
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
                raise LinkError(f"Mode {name} {ACK_TEXT.get(result, result)}"
                                + (f": {reason.rstrip('.')}." if reason else ".") + self._mode_hint(name))
            if not self._wait_state(lambda s: s["custom_mode"] == number, 3.0):
                raise LinkError(f"The Pixhawk accepted {name} but did not switch to it.")
            return f"Mode set to {name}."

    def _mode_hint(self, name):
        """Modes that need to know where the boat is are refused without a GPS fix."""
        if name not in ("AUTO", "RTL", "SMART_RTL", "GUIDED", "LOITER"):
            return ""
        with self._state_lock:
            fix, sats = self.state["gps_fix"], self.state["satellites"]
        if fix < 3:
            return f" The boat has no GPS fix yet ({sats} satellites) — {name} needs one. Move it where it can see the sky and wait."
        return ""

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
                raise LinkError(f"{verb} {ACK_TEXT.get(result, result)}" + (f": {reason.rstrip('.')}." if reason else "."))
            if not self._wait_state(lambda s: s["armed"] == bool(arm), 3.0):
                raise LinkError("The Pixhawk accepted the command but the arm state did not change.")
            return "Armed." if arm else "Disarmed."

    def brake_disarm(self, timeout=1.5):
        """Instant brake: force-disarm now (the motors stop at once). Skips the
        command lock so a slow command can't hold it up. True once the Pixhawk
        has disarmed: its ACK (it disarms before answering), not the next
        heartbeat, which can be a second away."""
        self._require_fc()
        cmd = mavlink.MAV_CMD_COMPONENT_ARM_DISARM
        w = self._expect(("COMMAND_ACK",), lambda m: m.command == cmd)
        for attempt in range(2):
            self._send(lambda m: m.mav.command_long_send(
                self.target_system, self.target_component, cmd, attempt, 0, FORCE_DISARM_MAGIC, 0, 0, 0, 0, 0))
        ack = self._wait(w, timeout)
        if ack is not None and ack.result == mavlink.MAV_RESULT_ACCEPTED:
            with self._state_lock:
                self.state["armed"] = False
            return True
        return self._wait_state(lambda s: not s["armed"], timeout)

    def set_current_item(self, seq, nav_seq=None):
        """Make `seq` the next mission item. If it is a DO command, the Pixhawk
        reports the first NAV item after it (nav_seq) as current instead."""
        self._require_fc()
        ok = {seq} if nav_seq is None else {seq, nav_seq}
        self._send(lambda m: m.mav.mission_set_current_send(self.target_system, self.target_component, seq))
        return self._wait_state(lambda s: s["mission_seq"] in ok, 3.0)

    def goto(self, lat, lng):
        """GUIDED: drive to this point (the Pixhawk steers and keeps its own speed)."""
        self._require_fc()
        mask = 0b110111111000   # use position only: ignore velocity, acceleration, yaw, yaw rate
        return self._send(lambda m: m.mav.set_position_target_global_int_send(
            0, self.target_system, self.target_component, mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            mask, int(round(lat * 1e7)), int(round(lng * 1e7)), 0, 0, 0, 0, 0, 0, 0, 0, 0))

    def rc_override(self, steer_pwm, throttle_pwm):
        """Stick values for the Pixhawk (no transmitter): steering on channel 1,
        throttle on 3; 0 on every other channel leaves it alone. The Pixhawk
        drops overrides that stop arriving (RC_OVERRIDE_TIME), then its radio
        failsafe acts — so this must be sent continuously."""
        if self.target_system is None:
            return False
        return self.rc_override_channels({1: steer_pwm, 3: throttle_pwm}, others=0)

    def rc_override_channels(self, values, others=0):
        """RC override on any channels 1–16: {channel: µs}; µs 0 hands that
        channel back to the radio at once. others=0: every other channel 1–8
        goes back to the radio too (the stick sender); others=None: they are
        left exactly as they are (UINT16_MAX = "ignore this field")."""
        if self.target_system is None:
            return False
        ts, tc = self.target_system, self.target_component
        ignore = 65535
        base = [ignore if others is None else int(others)] * 8
        ext = [0] * 8                                    # channels 9–16: 0 = ignore
        for ch, us in values.items():
            ch, us = int(ch), int(us)
            if 1 <= ch <= 8:
                base[ch - 1] = us
            elif 9 <= ch <= 16:
                ext[ch - 9] = us if us else 65534        # 65534 = back to the radio
        if any(ext):
            return self._send(lambda m: m.mav.rc_channels_override_send(ts, tc, *base, *ext))
        return self._send(lambda m: m.mav.rc_channels_override_send(ts, tc, *base))

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
        """Set a Pixhawk parameter and confirm it took (the Pixhawk echoes the
        stored value). Returns the stored value; raises LinkError otherwise."""
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

    def set_speed(self, mps):
        """Change the cruise speed (works in AUTO and GUIDED)."""
        result = self.command_long(mavlink.MAV_CMD_DO_CHANGE_SPEED, [1, float(mps), -1, 0])
        if result != mavlink.MAV_RESULT_ACCEPTED:
            raise LinkError(f"Speed change {ACK_TEXT.get(result, result)}.")
        return f"Speed set to {mps:g} m/s."

    def upload_mission(self, items, timeout=30.0):
        """Run the MAVLink mission upload protocol. `items` are dicts with
        command/frame/param1-4/lat/lng/alt. Raises LinkError on failure."""
        self._require_fc()
        if not items:
            raise LinkError("Nothing to upload.")
        with self._cmd_lock:
            while not self._mission_q.empty():
                self._mission_q.get_nowait()
            self._mission_listen = True
            try:
                return self._upload(items, timeout)
            finally:
                self._mission_listen = False

    def _upload(self, items, timeout):
        n = len(items)
        ts, tc = self.target_system, self.target_component

        def send_count():
            if not self._send(lambda m: m.mav.mission_count_send(ts, tc, n, mavlink.MAV_MISSION_TYPE_MISSION)):
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
                    ts, tc, seq, f, cmd, 0, 1, p1, p2, p3, p4, x, y, z, mavlink.MAV_MISSION_TYPE_MISSION)):
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
                    self._verify(packed)
                    with self._state_lock:
                        self.state["mission_count"] = n
                    return n
                raise LinkError(f"The Pixhawk rejected the mission: {mission_result_name(msg.type)}.")
        raise LinkError("Mission upload timed out — the Pixhawk stopped answering.")

    def _verify(self, packed):
        """Read the mission back from the Pixhawk and compare it with what was
        sent, item by item. An ACK only says the Pixhawk took the upload; this
        proves it stored exactly these items (count, commands, positions, holds)."""
        ts, tc = self.target_system, self.target_component
        n = len(packed)

        def ask(send, want, pred, tries=3):
            for _ in range(tries):
                if not self._send(send):
                    raise LinkError("Lost the link to the Pixhawk while checking the mission.")
                end = time.time() + 2.0
                while time.time() < end:
                    try:
                        msg = self._mission_q.get(timeout=max(0.05, end - time.time()))
                    except queue.Empty:
                        break
                    if msg.get_type() == "MISSION_ACK" and msg.type != mavlink.MAV_MISSION_ACCEPTED:
                        raise LinkError(f"The Pixhawk refused to send the mission back: {mission_result_name(msg.type)}.")
                    if msg.get_type() in want and pred(msg):
                        return msg
            raise LinkError("The mission was uploaded but the Pixhawk did not send it back for checking. Upload it again.")

        count = ask(lambda m: m.mav.mission_request_list_send(ts, tc, mavlink.MAV_MISSION_TYPE_MISSION),
                    ("MISSION_COUNT",), lambda m: True)
        if count.count != n:
            raise LinkError(f"The Pixhawk stored {count.count} mission items instead of {n}. Upload it again.")
        # Item 0 is the home slot: the Pixhawk sends back its own home there, so start at 1.
        for seq in range(1, n):
            got = ask(lambda m: m.mav.mission_request_int_send(ts, tc, seq, mavlink.MAV_MISSION_TYPE_MISSION),
                      ("MISSION_ITEM_INT", "MISSION_ITEM"), lambda m: m.seq == seq)
            _f, cmd, p1, p2, _p3, _p4, x, y, _z = packed[seq]
            if got.get_type() == "MISSION_ITEM":         # float lat/lng: compare at ~1 cm
                gx, gy, tol = round(got.x * 1e7), round(got.y * 1e7), 1000
            else:
                gx, gy, tol = got.x, got.y, 1
            bad = None
            if got.command != cmd:
                bad = f"command {got.command} instead of {cmd}"
            elif cmd == mavlink.MAV_CMD_NAV_WAYPOINT:
                if abs(gx - x) > tol or abs(gy - y) > tol:
                    bad = f"position {gx / 1e7:.7f}, {gy / 1e7:.7f} instead of {x / 1e7:.7f}, {y / 1e7:.7f}"
                elif int(got.param1) != int(p1):
                    bad = f"hold {got.param1:g} s instead of {p1:g} s"
            elif cmd == mavlink.MAV_CMD_DO_CHANGE_SPEED and abs(got.param2 - p2) > 0.01:
                bad = f"speed {got.param2:g} m/s instead of {p2:g} m/s"
            elif cmd == mavlink.MAV_CMD_DO_SET_SERVO and (int(got.param1) != int(p1) or int(got.param2) != int(p2)):
                bad = f"servo {int(got.param1)} → {int(got.param2)} instead of {int(p1)} → {int(p2)}"
            if bad:
                raise LinkError(f"The Pixhawk stored mission item {seq} differently ({bad}). Upload it again.")
        # Close the download, as the MAVLink mission protocol expects.
        self._send(lambda m: m.mav.mission_ack_send(ts, tc, mavlink.MAV_MISSION_ACCEPTED, mavlink.MAV_MISSION_TYPE_MISSION))
        log.info("Mission checked: the Pixhawk holds all %d items exactly as sent", n)


class LinkError(Exception):
    """A command could not be completed; the message is shown to the operator."""
