"""
The collector. Two kinds (collector_kind):

  * "scoop" (the default): a digital servo tipping the scoop on a free Pixhawk
    output. R1 on the game controller moves it to its extreme position
    (scoop_pwm_extreme); R1 again brings it back to its original 0 position
    (scoop_pwm_zero), and so on. It starts at 0 and never moves by itself:
    no automation, and disarming / emergency stop leave it where it is.
  * "roller": the old intake roller / belt, a relay module on a Pi GPIO pin or
    a brushed motor on its own ESC on a free Pixhawk output. Everything below
    is about the roller.

One place switches it, for everyone:

  * the operator: R1 on the game controller (POST /api/collector) runs / stops it;
  * live collect (live_collect.py): on when the boat closes in on an item or
    the camera homing takes over, off when nothing is close;
  * a planned mission: on within live_roller_on_m of the waypoint the Pixhawk
    is heading to (or while the camera homing is on an item), off otherwise;
  * safety: off when the boat is disarmed or emergency-stopped.

Last command wins: the automation only acts when what it wants CHANGES (going
on near an item, off leaving it), so R1 can stop the roller near an item and
it stays stopped until the next one — or run it anywhere, until the next
automatic stop.

Relay (collector_relay_gpio set, BCM numbering): switched with `pinctrl`.
Active-low modules (most: IN pulled low = on) get the pin driven low for on
and released to an input for off, so the module's own pull-up turns it fully
off; active-high ones get high / low. Off at start and at shutdown, and a
released pin (Pi booting, service stopped) is off too.

ESC (collector_servo set, no relay): DO_SET_SERVO on that output (its
SERVOn_FUNCTION must be 0), collector_pwm_on / collector_pwm_off. A
forward/reverse brushed ESC stops at 1500 µs (the default); a forward-only one
at 1000. The stop signal is sent whenever the Pixhawk (re)connects, so the ESC
sees a valid neutral and arms.
"""

import logging
import subprocess
import threading
import time
from collections import deque

from mav_link import LinkError, haversine_m

log = logging.getLogger("boat.collector")

TICK_S = 0.5
PINCTRL = "pinctrl"                      # Raspberry Pi OS's GPIO tool


class Collector:
    def __init__(self, link, cfg):
        self.link = link
        self.cfg = cfg
        self.missions = None                 # set by main.py
        self.vision = None
        self.live = None
        self.on = False
        self.by = None                       # who switched it last: operator | auto | safety
        self.t = 0.0
        self.error = None
        self.events = deque(maxlen=20)
        self._auto_want = False
        self._was_armed = False
        self._was_connected = False
        self._last_output = None
        self._was_scoop = self.scoop
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    @property
    def scoop(self):
        return self.cfg.get("collector_kind", "scoop") == "scoop"

    @property
    def output(self):
        return int(self.cfg["collector_servo"] or 0)

    @property
    def relay_pin(self):
        if self.scoop:
            return 0                         # a servo is never on a relay
        return int(self.cfg.get("collector_relay_gpio") or 0)

    def _target(self):
        """Where the signal goes and what it is now: a change (output, kind, a new
        position in µs) makes the next tick send it again."""
        if self.relay_pin:
            return ("gpio", self.relay_pin)
        return ("servo", self.output, self.scoop, self._pwm(self.on))

    # ------------------------------------------------------------------ switching
    def _relay(self, on):
        """Switch the relay on its GPIO pin. True if pinctrl took it."""
        pin = self.relay_pin
        if self.cfg.get("collector_relay_active_low", True):
            how = ["op", "dl"] if on else ["ip", "pn"]
        else:
            how = ["op", "dh"] if on else ["op", "dl"]
        try:
            r = subprocess.run([PINCTRL, "set", str(pin), *how], capture_output=True, text=True, timeout=3)
        except (OSError, subprocess.SubprocessError) as exc:
            self.error = f"Relay on GPIO{pin}: {exc}"
            return False
        if r.returncode != 0:
            self.error = f"Relay on GPIO{pin}: {(r.stderr or r.stdout).strip() or f'pinctrl exit {r.returncode}'}"
            return False
        self.error = None
        return True

    def _send(self, on):
        """The signal for on / off: the relay, or the roller ESC's output. True if it took."""
        if self.relay_pin:
            return self._relay(on)
        n = self.output
        if not n:
            return True                      # no roller output set: tracked only
        pwm = self._pwm(on)
        try:
            result = self.link.command_long(183, [n, pwm])       # MAV_CMD_DO_SET_SERVO
        except LinkError as exc:
            self.error = str(exc)
            return False
        if result != 0:
            self.error = (f"The Pixhawk refused output {n} (result {result}) — is SERVO{n}_FUNCTION 0?")
            return False
        self.error = None
        return True

    def _pwm(self, on):
        if self.scoop:
            return int(self.cfg.get("scoop_pwm_extreme", 2000) if on else self.cfg.get("scoop_pwm_zero", 1000))
        return int(self.cfg["collector_pwm_on"] if on else self.cfg["collector_pwm_off"])

    def _words(self, on):
        if self.scoop:
            return "Scoop at its extreme position" if on else "Scoop back at its 0 position"
        return "Roller running" if on else "Roller stopped"

    def set(self, on, by="operator"):
        """Run / stop the roller, or move the scoop (on = extreme, off = 0 position).
        Returns a message; raises LinkError if the Pixhawk refused."""
        on = bool(on)
        if self.scoop and by in ("safety", "auto"):
            return "The scoop only moves on R1 — left where it is."
        with self._lock:
            if not self._send(on):
                what = ("Scoop to " + ("extreme" if on else "0")) if self.scoop else f"Roller {'run' if on else 'stop'}"
                self._event(f"{what} failed: {self.error}", "warn")
                raise LinkError(self.error or "The collector command failed.")
            changed = on != self.on
            self.on, self.by, self.t = on, by, time.time()
            self._last_output = self._target()
            if changed:
                self._event(f"{self._words(on)} ({by})")
        if not self.output and not self.relay_pin:
            return f"{self._words(on)} (no output set — collector_servo is 0, so nothing moved)."
        return f"{self._words(on)}" + (f" ({self._pwm(on)} µs)." if self.scoop else ".")

    def toggle(self, by="operator"):
        return self.set(not self.on, by)

    def auto(self, want):
        """The automation's wish. Acts only when it changes (last command wins).
        The scoop has no automation: only R1 moves it."""
        if self.scoop:
            return
        want = bool(want)
        if want == self._auto_want:
            return
        self._auto_want = want
        if want != self.on:
            try:
                self.set(want, "auto")
            except LinkError:
                self._auto_want = not want   # try again on the next call
        # already where the automation wants it (e.g. the operator ran it): nothing to send

    def _event(self, text, level="info"):
        self.events.append({"t": round(time.time(), 1), "text": text, "level": level})
        (log.warning if level == "warn" else log.info)(text)

    # ------------------------------------------------------------------ loop
    def start(self):
        self._thread = threading.Thread(target=self._run, name="collector", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        if self.relay_pin:
            self._relay(False)               # service stopping: release the relay (off)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("Roller step failed")
            self._stop.wait(TICK_S)

    def _tick(self):
        if self.scoop != self._was_scoop:
            # Switched between the roller and the scoop: start the new one off / at 0.
            self._was_scoop = self.scoop
            self.on, self.by, self._auto_want = False, None, False
        s = self.link.snapshot()
        connected = s["fc_connected"]
        target = self._target()
        if self.relay_pin:
            if target != self._last_output and self._send(self.on):
                self._last_output = target   # relay pin set / changed: put it in the current state
        elif connected and (not self._was_connected or target != self._last_output):
            # (Re)connected, or the roller output was just set: give the ESC a
            # valid signal straight away (it arms on neutral).
            if self._send(self.on):
                self._last_output = target
        self._was_connected = connected
        if not connected:
            return
        armed = s["armed"]
        if self._was_armed and not armed and self.on and not self.scoop:
            try:
                self.set(False, "safety")
                self._event("Boat disarmed — roller stopped")
            except LinkError:
                pass
        self._was_armed = armed
        if not armed:
            self._auto_want = False
            return
        if self.live is not None and self.live.state in ("running", "returning"):
            return                           # live collect drives the roller itself
        self.auto(self._mission_wants(s))

    def _mission_wants(self, s):
        """A planned mission: on near the item the Pixhawk is heading to, or while homing onto one."""
        if self.missions is None or self.missions.status()["state"] not in ("running",):
            return False
        if self.vision is not None and self.vision.owner() == "homing":
            return True
        if s["flight_mode"] != "AUTO" or s["lat"] is None:
            return False
        wp = self.missions.waypoint_at(s["mission_seq"])
        return bool(wp) and haversine_m(s["lat"], s["lng"], wp[1], wp[2]) <= self.cfg["live_roller_on_m"]

    def summary(self):
        return {"kind": "scoop" if self.scoop else "roller",
                "on": self.on, "by": self.by, "since": round(self.t, 1) if self.t else None,
                "output": self.output, "relay_gpio": self.relay_pin or None, "error": self.error,
                "pwm_on": self._pwm(True), "pwm_off": self._pwm(False)}
