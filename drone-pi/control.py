"""
Flying the drone from the laptop keyboard (VARUNA app → Control tab).

The app sends the keys it has held down over the /api/control WebSocket about
20 times a second, as stick values -1…1:
    x  forward (W) / back (S)        y  right (D) / left (A)
    z  climb (↑) / descend (↓)       r  yaw right (→) / left (←)

They are NOT raw sticks. The Pi turns them into a velocity for ArduCopter in
GUIDED mode (SET_POSITION_TARGET_LOCAL_NED, velocities + yaw rate): the Pixhawk
keeps the drone level and in place by itself, and no keys = hover here.

Safety, all decided here on the drone:
  * Only in GUIDED, armed and in the air. In any other mode nothing is sent —
    an RC transmitter's mode switch takes over at once (ArduCopter ignores
    GUIDED commands in LOITER, ALT_HOLD, …), and so does every mode button.
  * Speed limits (kb_speed_mps, kb_climb_mps, kb_yaw_dps); never below
    kb_min_alt_m by keyboard (landing is the LAND button), never above
    max_altitude_m, never farther from home than max_distance_m.
  * Keys stop arriving (window closed, Wi-Fi gone) → hover within 0.5 s.
    Still silent after kb_lost_s → kb_lost_action (rtl / land / hover).
  * If the Pi itself stops, ArduCopter stops after 3 s without a new velocity
    (GUIDED's own timeout) and holds; its GCS failsafe (FS_GCS_ENABLE) can then
    bring it home.
"""

import logging
import math
import threading
import time

from mav_link import LinkError, haversine_m

log = logging.getLogger("drone.control")

SEND_HZ = 10
FRESH_S = 0.5              # keys older than this count as released
LOST_MODES = {"rtl": "RTL", "land": "LAND"}


def _axis(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(-1.0, min(1.0, v)) if v == v else 0.0     # NaN → 0


class KeyboardControl:
    def __init__(self, link, cfg):
        self.link = link
        self.cfg = cfg
        self.lock = threading.Lock()
        self.keys = {"x": 0.0, "y": 0.0, "z": 0.0, "r": 0.0}
        self.t_input = 0.0
        self.clients = 0
        self.flying = False          # keyboard drove in GUIDED since the last release
        self.lost_acted = False
        self.limit = None            # why the last command was trimmed (shown in the app)
        self.events = []
        self.sent = {"vn": 0.0, "ve": 0.0, "vd": 0.0, "yaw_rate": 0.0}
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name="keyboard", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    # ------------------------------------------------------------------ from the app
    def input(self, msg):
        with self.lock:
            for k in self.keys:
                self.keys[k] = _axis(msg.get(k))
            self.t_input = time.time()
            self.lost_acted = False

    def connected(self, on):
        with self.lock:
            self.clients = max(0, self.clients + (1 if on else -1))
            if not on and self.clients == 0:
                # Keys released at once; t_input keeps the last input time, so the
                # "app went quiet" countdown runs from the last real key packet.
                self.keys = dict.fromkeys(self.keys, 0.0)
        if not on:
            self._hover_if_guided()

    def take(self):
        """Keyboard flight on: GUIDED, holding position. Only when flying."""
        s = self.link.snapshot()
        if not s["fc_connected"]:
            raise LinkError("The Pixhawk is not connected.")
        if not s["armed"] or s["relative_alt"] < 1.0 or s["landed_state"] == "on_ground":
            raise LinkError("Take off first: keyboard flight starts in the air (ARM, then TAKEOFF).")
        msg = self.link.set_mode("GUIDED")
        self._send_velocity(0, 0, 0, 0)
        with self.lock:
            self.flying = True
            self.lost_acted = False
            self.t_input = time.time()          # the quiet countdown starts now, not at the last flight
        self._event("Keyboard flight on (GUIDED)")
        return "Keyboard flight on — the drone is holding position. " + ("" if msg.startswith("Already") else msg)

    def release(self, mode="BRAKE"):
        """Keyboard flight off: stop and hover in BRAKE. Not LOITER: LOITER follows the
        transmitter's sticks, and a throttle stick left low would make the drone sink
        and land (seen in SITL). BRAKE holds position whatever the sticks say; a mode
        button or the transmitter's mode switch takes it from there."""
        self._hover_if_guided()
        with self.lock:
            self.flying = False
        if self.link.snapshot()["armed"]:
            msg = self.link.set_mode(mode)
            self._event(f"Keyboard flight off ({mode})")
            return f"Keyboard flight off — {msg}"
        return "Keyboard flight off."

    # ------------------------------------------------------------------ to the Pixhawk
    def command(self, s=None):
        """The velocity to send now: (vn, ve, vd, yaw_rate rad/s), after the limits."""
        s = s or self.link.snapshot()
        with self.lock:
            fresh = time.time() - self.t_input <= FRESH_S
            k = dict(self.keys) if fresh else dict.fromkeys(self.keys, 0.0)
        speed, climb = self.cfg["kb_speed_mps"], self.cfg["kb_climb_mps"]
        fwd, right = k["x"] * speed, k["y"] * speed
        hdg = math.radians(s["heading"] or s["yaw"] or 0.0)
        vn = fwd * math.cos(hdg) - right * math.sin(hdg)
        ve = fwd * math.sin(hdg) + right * math.cos(hdg)
        vd = -k["z"] * climb                     # NED: positive is down
        yaw_rate = math.radians(k["r"] * self.cfg["kb_yaw_dps"])
        limit = None
        alt = s["relative_alt"] or 0.0
        floor, ceiling = self.cfg["kb_min_alt_m"], self.cfg["max_altitude_m"]
        # Slow down over the last ~2 m, so it stops ON the floor / ceiling rather than braking past it.
        if vd > 0 and vd > max(0.0, (alt - floor) * 0.5):
            vd = max(0.0, (alt - floor) * 0.5)
            if vd < 0.05:
                vd, limit = 0.0, f"lowest keyboard height {floor:.1f} m — land with LAND"
        if vd < 0 and -vd > max(0.0, (ceiling - alt) * 0.5):
            vd = -max(0.0, (ceiling - alt) * 0.5)
            if -vd < 0.05:
                vd, limit = 0.0, f"altitude limit {ceiling:.0f} m"
        if (vn or ve) and s["home_lat"] is not None and s["lat"] is not None:
            d = haversine_m(s["home_lat"], s["home_lng"], s["lat"], s["lng"])
            if d >= self.cfg["max_distance_m"]:
                # Only movement back towards home is allowed out there.
                n = math.radians(s["lat"] - s["home_lat"]) * 6371000.0
                e = math.radians(s["lng"] - s["home_lng"]) * 6371000.0 * math.cos(math.radians(s["lat"]))
                if vn * n + ve * e > 0:
                    vn = ve = 0.0
                    limit = f"distance limit {self.cfg['max_distance_m']:g} m from home"
        self.limit = limit
        return vn, ve, vd, yaw_rate

    def _send_velocity(self, vn, ve, vd, yaw_rate):
        self.sent = {"vn": round(vn, 2), "ve": round(ve, 2), "vd": round(vd, 2), "yaw_rate": round(yaw_rate, 3)}
        return self.link.send_velocity(vn, ve, vd, yaw_rate)

    def _hover_if_guided(self):
        s = self.link.snapshot()
        if s["fc_connected"] and s["armed"] and s["flight_mode"] == "GUIDED":
            self._send_velocity(0, 0, 0, 0)

    def _run(self):
        period = 1.0 / SEND_HZ
        while not self._stop.wait(period):
            try:
                self._tick()
            except Exception:
                log.exception("keyboard control tick failed")

    def _tick(self):
        s = self.link.snapshot()
        with self.lock:
            flying, clients, quiet = self.flying, self.clients, time.time() - self.t_input
        if not (flying and s["fc_connected"] and s["armed"]):
            return
        if s["flight_mode"] != "GUIDED":
            # Someone switched mode (a mode button, the transmitter, a failsafe):
            # keyboard flight is over until it is taken again.
            with self.lock:
                self.flying = False
            self._event(f"Keyboard flight ended: the drone is in {s['flight_mode']}")
            return
        if clients:
            self._send_velocity(*self.command(s))
        if quiet >= self.cfg["kb_lost_s"] and not self.lost_acted:
            self.lost_acted = True
            action = self.cfg["kb_lost_action"]
            self._event(f"No keys from the app for {quiet:.0f} s while flying by keyboard", "warn")
            if action in LOST_MODES:
                try:
                    self.link.set_mode(LOST_MODES[action])
                    self._event(f"…switched to {LOST_MODES[action]}", "warn")
                except LinkError as exc:
                    self._event(f"…could not switch to {LOST_MODES[action]}: {exc}", "warn")
            else:
                self._send_velocity(0, 0, 0, 0)    # hover; the transmitter can take over

    def _event(self, text, level="info"):
        self.events = (self.events + [{"t": round(time.time(), 1), "text": text, "level": level}])[-20:]
        (log.warning if level == "warn" else log.info)(text)

    # ------------------------------------------------------------------ status
    def status(self):
        with self.lock:
            fresh = time.time() - self.t_input <= FRESH_S
            return {
                "active": self.flying,
                "linked": self.clients > 0 and fresh,
                "keys": dict(self.keys) if fresh else dict.fromkeys(self.keys, 0.0),
                "sent": dict(self.sent),
                "limit": self.limit,
                "speed_mps": self.cfg["kb_speed_mps"],
                "climb_mps": self.cfg["kb_climb_mps"],
                "yaw_dps": self.cfg["kb_yaw_dps"],
                "min_alt_m": self.cfg["kb_min_alt_m"],
                "lost_action": self.cfg["kb_lost_action"],
                "events": self.events[-5:],
            }
