"""
Driving the boat by hand with a game controller on the PC (no RC transmitter).

The VARUNA app reads the controller and sends its sticks over the /api/drive
WebSocket ~20 times a second. This module turns them into RC override values
for the Pixhawk (steering on channel 1, throttle on 3) and sends them ten times
a second — ALWAYS while rc_source is "gamepad", neutral when nobody drives:

  * The Pixhawk gets its steering and throttle from the Pi, with no radio
    receiver. Pixhawk settings for this (README → game controller): radio
    failsafe off (FS_THR_ENABLE 0), RC1/RC3 calibrated to 1100–1500–1900 so
    1500 is "stopped", and the RC arming check skipped (ARMING_SKIPCHK).
  * If the boat Pi dies, its heartbeats stop and the Pixhawk's GCS failsafe
    acts after FS_GCS_TIMEOUT (FS_GCS_ENABLE 1, FS_ACTION 2 = Hold).
  * If the PC / controller link drops, this module centres the sticks after
    gamepad_timeout_s (0.5 s) and, if the boat was being driven in MANUAL,
    switches it to HOLD after gamepad_lost_s (3 s).

The sticks only move the boat in MANUAL (the controller's A button) or ACRO;
in AUTO, GUIDED, HOLD, LOITER and RTL the Pixhawk ignores them. With rc_source
"transmitter" nothing is sent, so a real transmitter keeps full control.
"""

import logging
import threading
import time

from mav_link import LinkError

log = logging.getLogger("boat.drive")

SEND_HZ = 10
NEUTRAL = 1500
SPAN = 400                 # 1100…1900 µs: ArduPilot's default RC range
STICK_MODES = ("MANUAL", "ACRO")   # modes where the Pixhawk follows the sticks


def _expo(x, e):
    """Stick curve: small stick = gentle throttle, full stick still = full.
    (1 - e)·x + e·x³ — e = 0 is linear; at e = 0.5 half stick gives 31 %."""
    return (1.0 - e) * x + e * x * x * x


def _clamp(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(-1.0, min(1.0, v)) if v == v else 0.0   # NaN → 0


class DriveManager:
    def __init__(self, link, cfg, vision=None):
        self.link = link
        self.cfg = cfg
        self.vision = vision
        self.lock = threading.Lock()
        self.steer = 0.0
        self.throttle = 0.0
        self.t_input = 0.0          # last packet from the app's controller
        self.clients = 0            # open /api/drive sockets
        self.pad = None             # controller name the app reported
        self.drove = False          # sticks moved since the link was last lost
        self.lost_acted = False
        self.events = []
        self._stop = threading.Event()
        self._thread = None

    @property
    def enabled(self):
        return self.cfg["rc_source"] == "gamepad"

    def start(self):
        self._thread = threading.Thread(target=self._run, name="drive", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    # ------------------------------------------------------------------ input from the app
    def input(self, steer, throttle, pad=None):
        with self.lock:
            self.steer, self.throttle = _clamp(steer), _clamp(throttle)
            self.t_input = time.time()
            if pad:
                self.pad = str(pad)[:80]
            if abs(self.steer) > 0.05 or abs(self.throttle) > 0.05:
                self.drove = True
                self.lost_acted = False

    def brake(self):
        """Instant brake: centre the sticks and send neutral to the Pixhawk now."""
        with self.lock:
            self.steer = self.throttle = 0.0
            self.drove = False
        if self.enabled and self.link.fc_connected:
            self.link.rc_override(NEUTRAL, NEUTRAL)

    def connected(self, on):
        with self.lock:
            self.clients = max(0, self.clients + (1 if on else -1))
            if not on and self.clients == 0:
                # Socket closed: centre at once, don't wait for the timeout.
                self.steer = self.throttle = 0.0

    # ------------------------------------------------------------------ output to the Pixhawk
    def pwm(self):
        """(steer, throttle) µs to send now: the sticks if fresh, else neutral."""
        with self.lock:
            fresh = time.time() - self.t_input <= self.cfg["gamepad_timeout_s"]
            s, t = (self.steer, self.throttle) if fresh else (0.0, 0.0)
        t = _expo(t, self.cfg["gamepad_throttle_expo"]) * self.cfg["gamepad_max_throttle"]
        return int(round(NEUTRAL + SPAN * s)), int(round(NEUTRAL + SPAN * t))

    def _run(self):
        period = 1.0 / SEND_HZ
        while not self._stop.wait(period):
            if not self.enabled or not self.link.fc_connected:
                continue
            steer, thr = self.pwm()
            self.link.rc_override(steer, thr)
            self._watch_link()

    def _watch_link(self):
        """Controller link lost while driving in MANUAL or ACRO: put the boat in HOLD."""
        with self.lock:
            quiet = time.time() - self.t_input
            if not self.drove or self.lost_acted or quiet < self.cfg["gamepad_lost_s"]:
                return
            self.lost_acted = True
            self.drove = False
        s = self.link.snapshot()
        if not (s["armed"] and s["flight_mode"] in STICK_MODES):
            return
        self._event(f"Controller link lost for {quiet:.0f} s while driving — holding the boat", "warn")
        if self.vision is not None:
            self.vision.operator("controller link lost")
        try:
            self.link.set_mode("HOLD")
        except LinkError as exc:
            self._event(f"Could not switch to HOLD: {exc}", "warn")

    def _event(self, text, level="info"):
        self.events = (self.events + [{"t": round(time.time(), 1), "text": text, "level": level}])[-20:]
        (log.warning if level == "warn" else log.info)(text)

    # ------------------------------------------------------------------ status
    def status(self):
        with self.lock:
            age = time.time() - self.t_input
            return {
                "source": self.cfg["rc_source"],
                "linked": self.clients > 0 and age <= self.cfg["gamepad_timeout_s"],
                "pad": self.pad,
                "steer": round(self.steer, 2) if age <= self.cfg["gamepad_timeout_s"] else 0.0,
                "throttle": round(self.throttle, 2) if age <= self.cfg["gamepad_timeout_s"] else 0.0,
                "max_throttle": self.cfg["gamepad_max_throttle"],
                "events": self.events[-5:],
            }
