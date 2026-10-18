"""
A small simulated Pixhawk running ArduRover in boat mode, spoken to over real
MAVLink (TCP, like ArduPilot SITL). It lets the whole chain — VARUNA app -> boat backend -> pymavlink
-> "Pixhawk" — be tested on a laptop with no hardware.

It implements what the boat backend uses: heartbeat, position/GPS/battery/
attitude telemetry, arming, mode changes, the mission upload protocol,
MISSION_SET_CURRENT, AUTO / RTL / HOLD driving with MISSION_ITEM_REACHED, and
GUIDED driving to SET_POSITION_TARGET_GLOBAL_INT points (camera homing).

Run it on its own:   python sim_vehicle.py   then   python main.py --connection tcp:127.0.0.1:5762
or let the backend start it:   python main.py --sim
"""

import argparse
import json
import logging
import math
import os
import threading
import time

from pymavlink import mavutil

from mav_link import MODE_NAMES, ROVER_MODES

mavlink = mavutil.mavlink
log = logging.getLogger("boat.sim")

EARTH_R = 6371000.0
ARRIVE_M = 1.0          # waypoint radius
TURN_RATE = 60.0        # deg/s
MANUAL_MAX_MPS = 2.0    # full throttle in MANUAL


def _offset(lat, lng, north_m, east_m):
    dlat = north_m / EARTH_R
    dlng = east_m / (EARTH_R * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lng + math.degrees(dlng)


def _dist_bearing(lat1, lng1, lat2, lng2):
    north = math.radians(lat2 - lat1) * EARTH_R
    east = math.radians(lng2 - lng1) * EARTH_R * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(north, east), (math.degrees(math.atan2(east, north)) + 360) % 360


class SimBoat:
    def __init__(self, lat, lng, address="tcpin:127.0.0.1:5762", speed_mps=1.0, sim_rate=1.0,
                 no_transmitter=False):
        self.address = address
        self.home = (lat, lng)
        self.lat, self.lng = lat, lng
        self.heading = 0.0
        self.speed = 0.0
        self.cruise = speed_mps
        self.default_cruise = speed_mps   # WP_SPEED: ArduRover goes back to it on entering AUTO / GUIDED
        self.rate = sim_rate          # >1 runs the world faster (tests)
        self.armed = False
        self.mode = ROVER_MODES["HOLD"]
        self.battery = 12.6
        self.mission = []             # list of MISSION_ITEM_INT messages
        self.cur = 0
        self.hold_until = None
        self.reached_sent = set()
        self.rtl_done = False
        self.guided_target = None     # (lat, lng) in GUIDED
        self.upload = None            # {"count": n, "items": {}, "next": seq, "last": t}
        # No RC transmitter (driven by a game controller through the Pi): like
        # ArduRover, the only "radio" is RC override; without it the radio
        # failsafe is on (no arming) and, armed, FS_ACTION is taken.
        self.no_rc = no_transmitter
        self.rc = {"steer": 1500, "thr": 1500, "t": 0.0}
        self.rc_failsafe = no_transmitter
        self.params = {"FS_THR_ENABLE": 1.0, "FS_ACTION": 2.0, "FS_TIMEOUT": 1.5, "RC_OVERRIDE_TIME": 3.0,
                       "FS_GCS_ENABLE": 0.0}
        # Tests can start the simulated Pixhawk with other values, e.g. '{"FS_ACTION": 0}'.
        try:
            self.params.update({k: float(v) for k, v in json.loads(os.environ.get("BOAT_SIM_PARAMS", "{}")).items()
                                if k in self.params})
        except (ValueError, TypeError, AttributeError):
            pass
        self._stop = threading.Event()
        self._thread = None
        self.m = None

    # ------------------------------------------------------------------ plumbing
    def start(self):
        self.m = mavutil.mavlink_connection(self.address, source_system=1, source_component=1)
        self._thread = threading.Thread(target=self._run, name="sim-boat", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        try:
            self.m.close()
        except Exception:
            pass

    def text(self, s, severity=mavlink.MAV_SEVERITY_INFO):
        self.m.mav.statustext_send(severity, s.encode()[:50])

    def _run(self):
        last = time.time()
        last_hb = last_tel = last_slow = 0.0
        while not self._stop.is_set():
            msg = self.m.recv_match(blocking=True, timeout=0.05)
            while msg is not None:
                try:
                    self._handle(msg)
                except Exception:
                    log.exception("sim failed handling %s", msg.get_type())
                msg = self.m.recv_match(blocking=False)
            now = time.time()
            self._step((now - last) * self.rate)
            last = now
            if now - last_hb >= 1.0:
                last_hb = now
                base = mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (mavlink.MAV_MODE_FLAG_SAFETY_ARMED if self.armed else 0)
                self.m.mav.heartbeat_send(mavlink.MAV_TYPE_SURFACE_BOAT, mavlink.MAV_AUTOPILOT_ARDUPILOTMEGA,
                                          base, self.mode, mavlink.MAV_STATE_ACTIVE if self.armed else mavlink.MAV_STATE_STANDBY)
            if now - last_tel >= 0.2:
                last_tel = now
                self._send_telemetry()
            if now - last_slow >= 1.0:
                last_slow = now
                self.m.mav.mission_current_send(self.cur)
            self._upload_timeout(now)
            self._radio_failsafe(now)

    def _send_telemetry(self):
        vn = self.speed * math.cos(math.radians(self.heading))
        ve = self.speed * math.sin(math.radians(self.heading))
        t_ms = int(time.time() * 1000) & 0xFFFFFFFF
        self.m.mav.global_position_int_send(t_ms, int(self.lat * 1e7), int(self.lng * 1e7), 0, 0,
                                            int(vn * 100), int(ve * 100), 0, int(self.heading * 100) % 36000)
        self.m.mav.gps_raw_int_send(t_ms * 1000, 3, int(self.lat * 1e7), int(self.lng * 1e7), 0, 90, 120,
                                    int(self.speed * 100), int(self.heading * 100) % 36000, 12)
        pct = max(0, min(100, int((self.battery - 10.5) / 2.1 * 100)))
        self.m.mav.sys_status_send(0, 0, 0, 200, int(self.battery * 1000), 150, pct, 0, 0, 0, 0, 0, 0)
        self.m.mav.vfr_hud_send(0, self.speed, int(self.heading) % 360, 50 if self.speed > 0 else 0, 0, 0)
        self.m.mav.attitude_send(t_ms, 0, 0, math.radians(self.heading if self.heading <= 180 else self.heading - 360), 0, 0, 0)

    # ------------------------------------------------------------------ incoming
    def _ack(self, command, result):
        self.m.mav.command_ack_send(command, result)

    def _handle(self, msg):
        t = msg.get_type()
        if t == "COMMAND_LONG":
            self._command(msg)
        elif t == "SET_MODE":
            self._set_mode(msg.custom_mode)
        elif t == "MISSION_COUNT":
            self.upload = {"count": msg.count, "items": {}, "next": 0, "last": time.time(),
                           "src": (msg.get_srcSystem(), msg.get_srcComponent())}
            if msg.count == 0:
                self.mission, self.upload = [], None
                self.m.mav.mission_ack_send(msg.get_srcSystem(), msg.get_srcComponent(), mavlink.MAV_MISSION_ACCEPTED)
            else:
                self._request_item(0)
        elif t in ("MISSION_ITEM_INT", "MISSION_ITEM") and self.upload:
            if msg.seq != self.upload["next"]:
                self._request_item(self.upload["next"])
                return
            if t == "MISSION_ITEM":
                msg.x, msg.y = int(msg.x * 1e7), int(msg.y * 1e7)
            if msg.command == mavlink.MAV_CMD_NAV_WAYPOINT:
                # ArduRover keeps a waypoint's hold time as whole seconds (uint16).
                msg.param1 = float(max(0, min(65535, int(msg.param1))))
            self.upload["items"][msg.seq] = msg
            self.upload["next"] = msg.seq + 1
            self.upload["last"] = time.time()
            if self.upload["next"] >= self.upload["count"]:
                src = self.upload["src"]
                self.mission = [self.upload["items"][i] for i in range(self.upload["count"])]
                self.upload = None
                self.cur = 1 if len(self.mission) > 1 else 0
                self.reached_sent.clear()
                self.m.mav.mission_ack_send(src[0], src[1], mavlink.MAV_MISSION_ACCEPTED)
                self.text(f"Mission: {len(self.mission) - 1} items received")
            else:
                self._request_item(self.upload["next"])
        elif t == "MISSION_REQUEST_LIST":
            self.m.mav.mission_count_send(msg.get_srcSystem(), msg.get_srcComponent(), len(self.mission))
        elif t in ("MISSION_REQUEST_INT", "MISSION_REQUEST") and not self.upload:
            self._send_item(msg)
        elif t == "MISSION_SET_CURRENT":
            if 0 <= msg.seq < len(self.mission):
                self.cur = msg.seq
                self.hold_until = None
                self.m.mav.mission_current_send(self.cur)
        elif t == "SET_POSITION_TARGET_GLOBAL_INT":
            if msg.lat_int or msg.lon_int:
                self.guided_target = (msg.lat_int / 1e7, msg.lon_int / 1e7)
        elif t == "RC_CHANNELS_OVERRIDE":
            if msg.chan1_raw not in (0, 65535):
                self.rc["steer"] = msg.chan1_raw
            if msg.chan3_raw not in (0, 65535):
                self.rc["thr"] = msg.chan3_raw
            self.rc["t"] = time.time()
        elif t == "PARAM_REQUEST_READ":
            name = msg.param_id
            if name in self.params:
                self.m.mav.param_value_send(name.encode(), self.params[name], mavlink.MAV_PARAM_TYPE_REAL32,
                                            len(self.params), list(self.params).index(name))
        elif t == "PARAM_SET":
            name = msg.param_id
            if name in self.params:
                self.params[name] = float(msg.param_value)
                self.m.mav.param_value_send(name.encode(), self.params[name], mavlink.MAV_PARAM_TYPE_REAL32,
                                            len(self.params), list(self.params).index(name))
        elif t == "MISSION_CLEAR_ALL":
            self.mission, self.cur = [], 0
            self.m.mav.mission_ack_send(msg.get_srcSystem(), msg.get_srcComponent(), mavlink.MAV_MISSION_ACCEPTED)

    def _send_item(self, req):
        """Mission download: one stored item, as ArduPilot sends it (item 0 is home)."""
        src = (req.get_srcSystem(), req.get_srcComponent())
        if not 0 <= req.seq < len(self.mission):
            self.m.mav.mission_ack_send(src[0], src[1], mavlink.MAV_MISSION_INVALID_SEQUENCE)
            return
        it = self.mission[req.seq]
        x, y = it.x, it.y
        if req.seq == 0:
            x, y = int(self.home[0] * 1e7), int(self.home[1] * 1e7)
        self.m.mav.mission_item_int_send(src[0], src[1], req.seq, it.frame, it.command, 0, it.autocontinue,
                                         it.param1, it.param2, it.param3, it.param4, x, y, it.z,
                                         mavlink.MAV_MISSION_TYPE_MISSION)

    def _request_item(self, seq):
        src = self.upload["src"]
        self.m.mav.mission_request_int_send(src[0], src[1], seq)

    def _upload_timeout(self, now):
        if self.upload and now - self.upload["last"] > 5.0:
            self.upload = None
            self.text("Mission upload timed out", mavlink.MAV_SEVERITY_WARNING)

    def _command(self, msg):
        c = msg.command
        if c == mavlink.MAV_CMD_COMPONENT_ARM_DISARM:
            want = msg.param1 > 0.5
            if want and self.mode not in (ROVER_MODES["HOLD"], ROVER_MODES["MANUAL"], ROVER_MODES["AUTO"],
                                          ROVER_MODES["GUIDED"], ROVER_MODES["LOITER"]):
                self.text("Arm: Mode not armable", mavlink.MAV_SEVERITY_CRITICAL)
                return self._ack(c, mavlink.MAV_RESULT_FAILED)
            if want and self.rc_failsafe:
                self.text("Arm: Radio failsafe on", mavlink.MAV_SEVERITY_CRITICAL)
                return self._ack(c, mavlink.MAV_RESULT_FAILED)
            if want and self.battery < 10.8:
                self.text("PreArm: Battery below minimum", mavlink.MAV_SEVERITY_CRITICAL)
                return self._ack(c, mavlink.MAV_RESULT_FAILED)
            self.armed = want
            if not want:
                self.speed = 0.0
            self.text("Throttle armed" if want else "Throttle disarmed")
            return self._ack(c, mavlink.MAV_RESULT_ACCEPTED)
        if c == mavlink.MAV_CMD_DO_SET_MODE:
            ok = self._set_mode(int(msg.param2))
            return self._ack(c, mavlink.MAV_RESULT_ACCEPTED if ok else mavlink.MAV_RESULT_DENIED)
        if c == mavlink.MAV_CMD_GET_HOME_POSITION:
            self._ack(c, mavlink.MAV_RESULT_ACCEPTED)
            return self.m.mav.home_position_send(int(self.home[0] * 1e7), int(self.home[1] * 1e7), 0, 0, 0, 0,
                                                 [1, 0, 0, 0], 0, 0, 0)
        if c == mavlink.MAV_CMD_DO_CHANGE_SPEED:
            if msg.param2 > 0:
                self.cruise = float(msg.param2)
            return self._ack(c, mavlink.MAV_RESULT_ACCEPTED)
        if c == mavlink.MAV_CMD_MISSION_START:
            ok = self._set_mode(ROVER_MODES["AUTO"])
            return self._ack(c, mavlink.MAV_RESULT_ACCEPTED if ok else mavlink.MAV_RESULT_FAILED)
        return self._ack(c, mavlink.MAV_RESULT_UNSUPPORTED)

    def _set_mode(self, number):
        if number not in MODE_NAMES:
            return False
        if number == ROVER_MODES["AUTO"] and len(self.mission) <= 1:
            self.text("No mission loaded", mavlink.MAV_SEVERITY_WARNING)
            return False
        if number != self.mode:
            if number == ROVER_MODES["GUIDED"]:
                self.guided_target = None     # stay put until given a point, like ArduRover
            if number in (ROVER_MODES["GUIDED"], ROVER_MODES["AUTO"]):
                self.cruise = self.default_cruise   # like ArduRover: a mode change resets the speed
            self.mode = number
            self.hold_until = None
            self.rtl_done = False
            self.text(f"Mode {MODE_NAMES[number]}")
        return True

    def _radio_failsafe(self, now):
        if not self.no_rc:
            return
        lost = now - self.rc["t"] > self.params["RC_OVERRIDE_TIME"]
        if lost == self.rc_failsafe:
            return
        self.rc_failsafe = lost
        if not lost:
            self.text("Radio Failsafe Cleared")
            return
        self.text("Radio Failsafe", mavlink.MAV_SEVERITY_WARNING)
        if self.armed and self.params["FS_THR_ENABLE"]:
            action = int(self.params["FS_ACTION"])
            if action == 1:
                self._set_mode(ROVER_MODES["RTL"])
            elif action in (2, 4):
                self._set_mode(ROVER_MODES["HOLD"])

    # ------------------------------------------------------------------ physics
    def _drive_to(self, lat, lng, dt, arrive=ARRIVE_M):
        dist, brg = _dist_bearing(self.lat, self.lng, lat, lng)
        if dist <= arrive:
            self.speed = 0.0
            return True
        diff = (brg - self.heading + 540) % 360 - 180
        self.heading = (self.heading + max(-TURN_RATE * dt, min(TURN_RATE * dt, diff))) % 360
        self.speed = self.cruise if abs(diff) < 60 else self.cruise * 0.3
        step = min(dist, self.speed * dt)
        n = step * math.cos(math.radians(self.heading))
        e = step * math.sin(math.radians(self.heading))
        self.lat, self.lng = _offset(self.lat, self.lng, n, e)
        return False

    def _step(self, dt):
        if self.armed and self.speed > 0:
            self.battery = max(10.0, self.battery - 0.0004 * dt)
        if not self.armed:
            self.speed = 0.0
            return
        name = MODE_NAMES.get(self.mode)
        if name == "RTL":
            # Like ArduRover: stop at home and stay in RTL until told otherwise.
            if self._drive_to(self.home[0], self.home[1], dt) and not self.rtl_done:
                self.rtl_done = True
                self.text("Reached destination")
            return
        if name == "GUIDED":
            if self.guided_target is None or self._drive_to(self.guided_target[0], self.guided_target[1], dt, arrive=0.3):
                self.speed = 0.0
            return
        if name == "MANUAL":
            # The sticks: throttle (channel 3) sets the speed, steering (channel 1) the turn.
            fresh = time.time() - self.rc["t"] <= self.params["RC_OVERRIDE_TIME"]
            thr = (self.rc["thr"] - 1500) / 400 if fresh else 0.0
            steer = (self.rc["steer"] - 1500) / 400 if fresh else 0.0
            self.speed = MANUAL_MAX_MPS * max(-1.0, min(1.0, thr))
            if abs(self.speed) > 0.05:
                self.heading = (self.heading + TURN_RATE * dt * max(-1.0, min(1.0, steer))) % 360
            step = self.speed * dt
            self.lat, self.lng = _offset(self.lat, self.lng, step * math.cos(math.radians(self.heading)),
                                         step * math.sin(math.radians(self.heading)))
            return
        if name != "AUTO":
            self.speed = 0.0
            return
        if self.cur >= len(self.mission):
            self.speed = 0.0
            return
        item = self.mission[self.cur]
        cmd = item.command
        if cmd == mavlink.MAV_CMD_DO_CHANGE_SPEED:
            if item.param2 > 0:
                self.cruise = float(item.param2)
            return self._advance()
        if cmd == mavlink.MAV_CMD_DO_SET_SERVO:
            self.text(f"Servo {int(item.param1)} -> {int(item.param2)}")
            return self._advance()
        if cmd == mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH:
            if self._drive_to(self.home[0], self.home[1], dt):
                self._reached(self.cur)
                self._advance()
            return
        if cmd == mavlink.MAV_CMD_NAV_WAYPOINT:
            if self.hold_until is not None:
                self.speed = 0.0
                if time.time() >= self.hold_until:
                    self.hold_until = None
                    self._advance()
                return
            if self._drive_to(item.x / 1e7, item.y / 1e7, dt):
                self._reached(self.cur)
                hold = float(item.param1 or 0) / self.rate
                if hold > 0:
                    self.hold_until = time.time() + hold
                else:
                    self._advance()
            return
        self._advance()  # unknown items are skipped, like ArduPilot does

    def _reached(self, seq):
        if seq not in self.reached_sent:
            self.reached_sent.add(seq)
            self.m.mav.mission_item_reached_send(seq)
            self.text(f"Reached waypoint #{seq}")

    def _advance(self):
        self.cur += 1
        self.m.mav.mission_current_send(min(self.cur, max(0, len(self.mission) - 1)))
        if self.cur >= len(self.mission):
            self.text("Mission Complete")
            self.mode = ROVER_MODES["HOLD"]
            self.speed = 0.0
            self.cur = max(0, len(self.mission) - 1)


def main():
    ap = argparse.ArgumentParser(description="Simulated ArduRover boat (MAVLink over TCP, like ArduPilot SITL)")
    ap.add_argument("--lat", type=float, default=17.4239)
    ap.add_argument("--lng", type=float, default=78.4738)
    ap.add_argument("--listen", default="tcpin:127.0.0.1:5762", help="where the backend connects (use --connection tcp:127.0.0.1:5762)")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sim = SimBoat(args.lat, args.lng, args.listen, args.speed)
    sim.start()
    log.info("Simulated boat running at %.6f, %.6f on %s (Ctrl+C to stop)", args.lat, args.lng, args.listen)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        sim.stop()


if __name__ == "__main__":
    main()
