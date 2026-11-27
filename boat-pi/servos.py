"""
Two extra servos (gates, flaps, an arm): two-position, worked from the RC
transmitter OR the game controller in the app.

How it works on the Pixhawk: each servo's output passes an RC channel straight
through (SERVOn_FUNCTION = 50 + channel, "RCINx"). So

  * a transmitter switch on that channel moves the servo directly, with the Pi
    doing nothing, and
  * the app (controller D-pad or the on-screen button) moves it with an RC
    override on that same channel, sent by this Pi.

Who has it:
  rc_source "gamepad" (no transmitter): the Pi always sends both servo channels
    together with the sticks (drive.py), so each servo holds where it was put.
    They start in the "off" position (servoN_pwm_off).
  rc_source "transmitter": the transmitter has them until the app touches one.
    The app then holds that servo (an override on its channel only; the sticks
    and every other channel are left to the transmitter) until it is handed
    back: the "Give back" button (D-pad down), or the app going away for
    servo_app_lost_s. Handing back releases the override at once, so the servo
    goes to wherever the transmitter switch is.

DO_SET_SERVO can't move these outputs (their function isn't 0), which is how
the Pixhawk keeps a mission item or another tool from fighting the switch.
"""

import logging
import threading
import time

from mav_link import LinkError

log = logging.getLogger("boat.servos")

COUNT = 2
SEND_HZ = 5                 # transmitter mode: re-send held overrides (RC_OVERRIDE_TIME is 3 s by default)
RCIN_BASE = 50              # SERVOn_FUNCTION 51…66 = RCIN1…RCIN16


class ServoManager:
    def __init__(self, link, cfg, app_present=None):
        self.link = link
        self.cfg = cfg
        self.app_present = app_present or (lambda: True)   # False once the app has been gone servo_app_lost_s
        self.lock = threading.Lock()
        self.on = [False] * COUNT        # commanded position: True = "on" PWM
        self.held = [False] * COUNT      # transmitter mode: the app holds this one
        self.events = []
        self.check = None                # last Pixhawk set-up check (check_setup)
        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------------ settings
    def spec(self, i):
        n = i + 1
        c = self.cfg
        return {"name": c[f"servo{n}_name"], "output": int(c[f"servo{n}_output"]), "channel": int(c[f"servo{n}_channel"]),
                "pwm_off": int(c[f"servo{n}_pwm_off"]), "pwm_on": int(c[f"servo{n}_pwm_on"])}

    @property
    def gamepad(self):
        return self.cfg["rc_source"] == "gamepad"

    def _valid(self, i):
        if not isinstance(i, int) or not 0 <= i < COUNT:
            raise ValueError(f"No servo {i + 1 if isinstance(i, int) else i} (there are {COUNT}).")

    # ------------------------------------------------------------------ commands from the app
    def set(self, i, on=None, by="app"):
        """Move servo i (0-based) to on / off, or toggle it (on None). Returns a message."""
        self._valid(i)
        sp = self.spec(i)
        if on is None and not self.gamepad and not self.held[i]:
            # Taking it from the transmitter: toggle from where the switch has it now.
            us = self._output_us(sp["output"])
            if us:
                with self.lock:
                    self.on[i] = abs(us - sp["pwm_on"]) < abs(us - sp["pwm_off"])
        with self.lock:
            self.on[i] = (not self.on[i]) if on is None else bool(on)
            took = not self.gamepad and not self.held[i]
            if not self.gamepad:
                self.held[i] = True
            pos = self.on[i]
        if not self.gamepad:
            self._send_held()                  # move now, don't wait for the next tick
        word = "on" if pos else "off"
        pwm = sp["pwm_on"] if pos else sp["pwm_off"]
        self._event(f"{sp['name']} {word} ({pwm} µs) by {by}" + (" — the app has it until you give it back" if took else ""))
        return f"{sp['name']} {word}."

    def release(self, i=None, why="app"):
        """Transmitter mode: hand servo i (or both) back to the transmitter."""
        if self.gamepad:
            return "No transmitter: the app always has the servos."
        idx = range(COUNT) if i is None else [i]
        for k in idx:
            self._valid(k)
        with self.lock:
            gone = [k for k in idx if self.held[k]]
            for k in gone:
                self.held[k] = False
        if not gone:
            return "The transmitter already has them."
        chans = {self.spec(k)["channel"]: 0 for k in gone}      # 0 = back to the radio
        try:
            if self.link.fc_connected:
                self.link.rc_override_channels(chans, others=None)
        except LinkError:
            pass                                                # the override times out on its own
        names = " and ".join(self.spec(k)["name"] for k in gone)
        self._event(f"{names} back to the transmitter ({why})")
        return f"{names}: the transmitter has {'it' if len(gone) == 1 else 'them'} again."

    # ------------------------------------------------------------------ output
    def channels(self):
        """{RC channel: µs} the app is commanding now (gamepad mode: always both)."""
        with self.lock:
            out = {}
            for i in range(COUNT):
                if self.gamepad or self.held[i]:
                    sp = self.spec(i)
                    out[sp["channel"]] = sp["pwm_on"] if self.on[i] else sp["pwm_off"]
            return out

    def _send_held(self):
        if self.gamepad or not self.link.fc_connected:
            return
        chans = self.channels()
        if chans:
            try:
                self.link.rc_override_channels(chans, others=None)   # sticks and the rest: left alone
            except LinkError:
                pass

    def start(self):
        self._thread = threading.Thread(target=self._run, name="servos", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _run(self):
        # Gamepad mode: drive.py sends these with the sticks. Transmitter mode: here.
        while not self._stop.wait(1.0 / SEND_HZ):
            if self.gamepad:
                continue
            if any(self.held) and not self.app_present():
                self.release(None, "the app went away")
                continue
            self._send_held()

    # ------------------------------------------------------------------ Pixhawk set-up
    def check_setup(self):
        """Read back what the Pixhawk does with each servo's output and channel."""
        problems, rows = [], []
        collector_out = int(self.cfg.get("collector_servo") or 0)
        for i in range(COUNT):
            sp = self.spec(i)
            fn = self.link.get_param(f"SERVO{sp['output']}_FUNCTION")
            opt = self.link.get_param(f"RC{sp['channel']}_OPTION")
            want = RCIN_BASE + sp["channel"]
            row = {"name": sp["name"], "output": sp["output"], "channel": sp["channel"],
                   "function": fn, "want_function": want, "rc_option": opt, "ok": False, "fixable": False}
            if fn is None:
                problems.append(f"{sp['name']}: could not read SERVO{sp['output']}_FUNCTION.")
            elif sp["output"] == collector_out:
                problems.append(f"{sp['name']}: output {sp['output']} is the intake roller's — pick another output.")
            elif int(fn) == want:
                row["ok"] = True
            elif int(fn) == 0:
                row["fixable"] = True
                problems.append(f"{sp['name']}: output {sp['output']} is unused (SERVO{sp['output']}_FUNCTION 0); "
                                f"it must pass channel {sp['channel']} through ({want} = RCIN{sp['channel']}).")
            else:
                problems.append(f"{sp['name']}: output {sp['output']} already does something else "
                                f"(SERVO{sp['output']}_FUNCTION {int(fn)}) — pick a free output.")
            if opt is not None and int(opt) != 0:
                row["ok"] = False
                problems.append(f"{sp['name']}: channel {sp['channel']} also has a switch function "
                                f"(RC{sp['channel']}_OPTION {int(opt)}), which the servo would trigger — "
                                f"set it to 0 or pick another channel.")
            rows.append(row)
        outs = [self.spec(i)["output"] for i in range(COUNT)]
        chans = [self.spec(i)["channel"] for i in range(COUNT)]
        if len(set(outs)) < COUNT or len(set(chans)) < COUNT:
            problems.append("The two servos must use different outputs and different channels.")
        self.check = {"ok": not problems, "servos": rows, "problems": problems, "t": round(time.time(), 1)}
        return self.check

    def setup(self):
        """Set each unused servo output to pass its channel through. Disarmed only;
        never takes over an output that already has a function."""
        if self.link.snapshot()["armed"]:
            return False, "Disarm the boat before changing Pixhawk parameters.", None
        report = self.check_setup()
        changed = []
        for row in report["servos"]:
            if row["fixable"]:
                name = f"SERVO{row['output']}_FUNCTION"
                self.link.set_param(name, row["want_function"])
                changed.append(f"{name} → {row['want_function']}")
                log.info("Pixhawk parameter %s: 0 → %d (%s)", name, row["want_function"], row["name"])
        report = self.check_setup()
        if report["ok"]:
            msg = ("Set " + ", ".join(changed) + "." if changed else "Already set up.")
            return True, msg, report
        return False, ("Set " + ", ".join(changed) + "; " if changed else "") + " ".join(report["problems"]), report

    # ------------------------------------------------------------------ status
    def _event(self, text, level="info"):
        self.events = (self.events + [{"t": round(time.time(), 1), "text": text, "level": level}])[-20:]
        (log.warning if level == "warn" else log.info)(text)

    def _output_us(self, output):
        """µs on a Pixhawk output (SERVO_OUTPUT_RAW, outputs 1–8), or None if not known."""
        s = self.link.snapshot()
        out = s.get("servo_out") if time.time() - (s.get("servo_out_t") or 0) < 3 else None
        return (out[output - 1] or None) if out and 1 <= output <= len(out) else None

    def status(self):
        rows = []
        with self.lock:
            for i in range(COUNT):
                sp = self.spec(i)
                us = self._output_us(sp["output"])
                app = self.gamepad or self.held[i]
                if us:                                   # what the output really does (switch or app)
                    pos = abs(us - sp["pwm_on"]) < abs(us - sp["pwm_off"])
                else:
                    pos = self.on[i] if app else None
                rows.append({**sp, "index": i, "on": pos, "commanded": self.on[i], "us": us,
                             "by": "app" if app else "transmitter"})
        return {"servos": rows, "source": self.cfg["rc_source"],
                "setup_ok": None if self.check is None else self.check["ok"], "events": self.events[-5:]}
