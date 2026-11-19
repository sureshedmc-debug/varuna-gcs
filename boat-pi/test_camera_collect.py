"""
The boat's own camera: verified plastic -> motor -> scoop (boat_extras.CameraCollect).

Proves the thing that matters most: the motor runs ONLY for plastic the app has
verified, and stops the moment that plastic is gone, the app goes quiet, or the
operator takes over. The Pixhawk, the camera and the scoop are all faked, so
this runs anywhere.

Run:  py test_camera_collect.py
"""

import sys
import tempfile
import time
import types
from pathlib import Path

import boat_extras as be

PASS = FAIL = 0


def check(cond, what):
    global PASS, FAIL
    print(("  PASS  " if cond else "  FAIL  ") + what)
    if cond:
        PASS += 1
    else:
        FAIL += 1


class FakeLink:
    def __init__(self):
        self.fc_connected = True
        self.target_system = 1
        self.target_component = 1
        self.sent = []
        self.s = {"fc_connected": True, "armed": True, "flight_mode": "MANUAL", "lat": None, "lng": None,
                  "gps_fix": 0, "groundspeed": 0.2, "messages": [], "servo_out": None, "servo_out_t": 0}

    def snapshot(self):
        return dict(self.s, fc_connected=self.fc_connected)

    def rc_override_channels(self, values, others=0):
        self.sent.append((dict(values), others))
        return True

    def get_param(self, name, timeout=3.0):
        return None

    def command_long(self, cmd, args):
        return 0

    def _send(self, fn):
        return None

    def set_mode(self, name):
        self.s["flight_mode"] = name

    def arm(self, on, force=False):
        self.s["armed"] = bool(on)


class FakeMover:
    moving = False
    pos = 1000
    target = 1000

    def wait_still(self, timeout):
        return True


class FakeCollector:
    def __init__(self):
        self.scoop = True
        self.output = 2
        self.on = False
        self.by = None
        self.error = None
        self.calls = []
        self.__dict__["_mover"] = FakeMover()

    def set(self, on, by="operator"):
        self.on = bool(on)
        self.by = by
        self.calls.append(("set", on, by))
        return f"scoop {'extreme' if on else '0'}"

    def _pwm(self, on):
        return 2000 if on else 1000


class FakeCamera:
    connected = True


class FakeLive:
    state = "running"


def fake_main(link, collector):
    m = types.ModuleType("main")
    m.link = link
    m.camera = FakeCamera()
    m.collector = collector
    live = FakeLive()
    live.collector = collector
    m.live = live
    m.cfg = {"rc_source": "transmitter", "camera_plastic_conf": 0.45, "camera_plastic_hits": 2,
             "camera_lock_lost_s": 1.2, "camera_target_max_m": 15.0, "homing_capture_m": 1.5,
             "homing_speed_mps": 0.4}
    vm = types.SimpleNamespace(link=link, live=live, cfg=m.cfg)
    m.vision = vm
    sys.modules["main"] = m
    return m


def item(**kw):
    """What the app sends as a verified plastic (src/lib/boatTarget.js)."""
    base = {"id": "7", "label": "plastic bottle", "score": 0.82, "hits": 3, "seen": 3,
            "distance_m": 6.0, "forward_m": 6.0, "right_m": 0.3, "bearing_deg": 3.0,
            "centred": True, "closing": True, "age_ms": 40, "visible": True,
            "held_ms": 700, "confirmed": True}
    base.update(kw)
    return base


def motor_running():
    return be.MOTOR.on


def reset(link, collector):
    be.MOTOR.stop("test reset")
    be.CAMERA.abort("test reset")
    with be.CAMERA.lock:
        be.CAMERA.state = "idle"
        be.CAMERA.target = None
        be.CAMERA.cooldown_until = 0.0
    link.sent.clear()
    collector.calls.clear()
    collector.on = False


def main():
    tmp = Path(tempfile.mkdtemp())
    be.OPS.log_path = str(tmp / "events.log")
    be.OPS_FILE = str(tmp / "ops.json")
    link = FakeLink()
    col = FakeCollector()
    fake_main(link, col)
    be.OPS_SETTINGS.update({"camera_motor": True, "camera_motor_pct": 10, "camera_scoop": True,
                            "camera_scoop_m": 1.5, "camera_cooldown_s": 0.3, "camera_stale_s": 1.5,
                            "camera_alert": False, "auto_collect": True, "motor_run_s": 10, "motor_on_signal": False,
                            "collect_max_speed_mps": 0.8})

    print("Nothing but verified plastic starts the motor")
    for bad, why in (
        ({}, "no plastic in view"),
        (item(confirmed=False), "seen once, not verified yet"),
        (item(score=0.30), "only 30 % sure"),
        (item(hits=1, score=0.5), "seen in one pass only"),
        (item(distance_m=None), "no distance"),
        (item(distance_m=40.0), "far outside the useful range"),
    ):
        reset(link, col)
        be.CAMERA.observe({"plastic": bad or None})
        check(not motor_running() and not link.sent, f"{why}: motor stays OFF")

    print("Verified plastic: the motor runs at once")
    reset(link, col)
    t0 = time.time()
    be.CAMERA.observe({"plastic": item()})
    dt = (time.time() - t0) * 1000
    check(motor_running(), "motor ON")
    check(link.sent and link.sent[-1][0] == {3: be.throttle_pwm(10, be.MOTOR.params)},
          f"at 10 % on CH3 only ({link.sent[-1] if link.sent else None})")
    check(all(1 not in v and 4 not in v for v, _ in link.sent), "steering never touched (stays on the transmitter)")
    check(dt < 50, f"decided in {dt:.1f} ms")
    check(be.CAMERA.view()["state"] == "approach", "state: approach")

    print("The boat keeps going for the SAME item")
    be.CAMERA.observe({"plastic": item(distance_m=4.0)})
    be.CAMERA.observe({"plastic": item(distance_m=2.6)})
    v = be.CAMERA.view()
    check(v["state"] == "approach" and v["distance_m"] == 2.6, f"distance now {v['distance_m']} m")
    check(motor_running(), "motor still on while approaching")

    print("A different object does not steal it")
    be.CAMERA.observe({"plastic": item(id="99", score=0.95, distance_m=9.0)})
    check(be.CAMERA.view()["target"]["id"] == "99", "the app decides which item is locked, the boat follows it")

    print("Out of sight: the motor stops")
    reset(link, col)
    be.CAMERA.observe({"plastic": item()})
    check(motor_running(), "running")
    with be.CAMERA.lock:
        be.CAMERA.t_seen = time.time() - 5.0
        be.CAMERA.t_obs = time.time()
    be.CAMERA._tick()
    check(not motor_running(), "plastic gone for 5 s: motor OFF")

    print("The app goes quiet: the motor stops (watchdog)")
    reset(link, col)
    be.CAMERA.observe({"plastic": item()})
    with be.CAMERA.lock:
        be.CAMERA.t_obs = time.time() - 3.0
        be.CAMERA.t_seen = time.time() - 3.0
    be.CAMERA._tick()
    check(not motor_running(), "nothing from the app for 3 s: motor OFF")

    print("The operator always wins")
    reset(link, col)
    be.CAMERA.observe({"plastic": item()})
    check(motor_running(), "running")
    be.CAMERA.abort("operator")
    check(not motor_running() and be.CAMERA.view()["state"] == "idle", "STOP: motor OFF, target dropped")

    reset(link, col)
    be.OPS_SETTINGS["camera_motor"] = False
    be.CAMERA.observe({"plastic": item()})
    check(not motor_running(), "Camera motor OFF: motor stays OFF")
    be.OPS_SETTINGS["camera_motor"] = True

    print("Disarmed or out of MANUAL: nothing runs")
    reset(link, col)
    link.s["armed"] = False
    be.CAMERA.observe({"plastic": item()})
    check(not motor_running(), "disarmed: motor stays OFF (never armed by a detection)")
    link.s["armed"] = True
    reset(link, col)
    be.CAMERA.observe({"plastic": item()})
    check(motor_running(), "armed again: running")
    link.s["flight_mode"] = "HOLD"          # the operator flips SwD
    be.MOTOR.step()
    check(not motor_running(), "SwD out of MANUAL: motor OFF on the next tick")
    link.s["flight_mode"] = "MANUAL"

    print("In the collection zone: motor off, scoop runs")
    reset(link, col)
    be.CAMERA.observe({"plastic": item(distance_m=5.0)})
    check(motor_running(), "approaching")
    be.CAMERA.observe({"plastic": item(distance_m=1.2)})
    check(not motor_running(), "inside 1.5 m: motor OFF (the boat coasts in)")
    for _ in range(80):
        if col.calls:
            break
        time.sleep(0.05)
    check(("set", True, "auto-collect") in col.calls, f"scoop closed: {col.calls}")
    for _ in range(80):
        if ("set", False, "auto-collect") in col.calls:
            break
        time.sleep(0.05)
    check(("set", False, "auto-collect") in col.calls, "scoop returned to 0")
    for _ in range(40):
        be.CAMERA._tick()
        if be.CAMERA.view()["state"] in ("cooldown", "idle"):
            break
        time.sleep(0.05)
    check(be.CAMERA.view()["state"] in ("cooldown", "idle"), "target cleared, ready for the next")

    print("Not in front of the boat: no scoop")
    reset(link, col)
    be.CAMERA.observe({"plastic": item(distance_m=1.0, centred=False)})
    time.sleep(0.2)
    check(("set", True, "auto-collect") not in col.calls, "off to one side: the scoop does not run")

    print("Too fast to scoop")
    reset(link, col)
    link.s["groundspeed"] = 2.5
    be.CAMERA.observe({"plastic": item(distance_m=1.0)})
    time.sleep(0.4)
    check(("set", True, "auto-collect") not in col.calls, "2.5 m/s: the scoop does not run")
    link.s["groundspeed"] = 0.2

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
