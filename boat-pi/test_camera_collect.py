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
                            "camera_scoop_m": 0.9, "camera_scoop_confirm": 3,
                            "camera_scoop_inside": False,   # the "very close" rule first; "trapped" below
                            "scoop_zone_x1": 0.30, "scoop_zone_x2": 0.70,
                            "scoop_zone_y1": 0.72, "scoop_zone_y2": 1.00,
                            "camera_cooldown_s": 0.3, "camera_stale_s": 1.5,
                            "camera_alert": False, "auto_collect": True, "motor_run_s": 10, "motor_on_signal": False,
                            "collect_max_speed_mps": 0.8})

    print("Nothing but verified plastic starts the motor")
    for bad, why in (
        ({}, "no plastic in view"),
        (item(confirmed=False), "seen once, not verified yet"),
        (item(score=0.30), "only 30 % sure"),
        (item(hits=1, score=0.5), "seen in one pass only"),
        (item(box_frac=0.7, score=0.6), "a box over most of the picture (the scene, not an item)"),
    ):
        reset(link, col)
        be.CAMERA.observe({"plastic": bad or None})
        check(not motor_running() and not link.sent, f"{why}: motor stays OFF")

    print("Any plastic the camera sees runs the motor, near or far")
    for far, why in ((item(distance_m=None, forward_m=None, right_m=None), "no distance (above the horizon line)"),
                     (item(distance_m=40.0), "40 m away")):
        reset(link, col)
        be.CAMERA.observe({"plastic": far})
        check(motor_running(), f"{why}: motor ON")
        time.sleep(0.15)
        check(("set", True, "auto-collect") not in col.calls, f"{why}: no scoop")

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

    print("Motor first, scoop only when VERY close")
    reset(link, col)
    be.CAMERA.observe({"plastic": item(distance_m=5.0)})
    check(motor_running(), "approaching")
    be.CAMERA.observe({"plastic": item(distance_m=1.2)})
    time.sleep(0.2)
    check(motor_running() and not col.calls, "1.2 m (close, not VERY close): motor still on, no scoop")
    be.CAMERA.observe({"plastic": item(distance_m=0.8)})
    be.CAMERA.observe({"plastic": item(distance_m=1.4)})   # one jumpy reading
    be.CAMERA.observe({"plastic": item(distance_m=0.8)})
    time.sleep(0.2)
    check(motor_running() and not col.calls, "very close only now and then: motor on, no scoop")
    be.CAMERA.observe({"plastic": item(distance_m=0.8)})
    time.sleep(0.2)
    check(motor_running() and not col.calls, "2 very-close readings in a row: still no scoop (needs 3)")
    be.CAMERA.observe({"plastic": item(distance_m=0.75)})
    check(not motor_running(), "3rd very-close reading: motor OFF (the boat coasts in)")
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
    for _ in range(4):
        be.CAMERA.observe({"plastic": item(distance_m=0.7, centred=False)})
    time.sleep(0.2)
    check(("set", True, "auto-collect") not in col.calls, "off to one side: the scoop does not run")

    print("Too fast to scoop")
    reset(link, col)
    link.s["groundspeed"] = 2.5
    for _ in range(4):
        be.CAMERA.observe({"plastic": item(distance_m=0.7)})
    time.sleep(0.4)
    check(("set", True, "auto-collect") not in col.calls, "2.5 m/s: the scoop does not run")
    link.s["groundspeed"] = 0.2

    print("Trapped: the scoop closes only with the waste INSIDE it")
    be.OPS_SETTINGS["camera_scoop_inside"] = True
    water = [0.45, 0.40, 0.55, 0.50]          # out on the water, ahead
    near = [0.42, 0.60, 0.58, 0.70]           # just in front of the scoop's mouth
    inside = [0.40, 0.78, 0.60, 0.92]         # inside the scoop's mouth
    side = [0.05, 0.78, 0.20, 0.92]           # bottom of the picture, but beside the scoop
    reset(link, col)
    be.CAMERA.observe({"plastic": item(distance_m=0.6, box=near)})
    for _ in range(5):
        be.CAMERA.observe({"plastic": item(distance_m=0.6, box=near)})
    time.sleep(0.2)
    check(motor_running() and not col.calls, "very close but not in the scoop yet: motor on, no scoop")
    for _ in range(5):
        be.CAMERA.observe({"plastic": item(distance_m=0.6, box=side)})
    time.sleep(0.2)
    check(motor_running() and not col.calls, "at the bottom but beside the scoop: no scoop")
    be.CAMERA.observe({"plastic": item(distance_m=0.6, box=inside)})
    be.CAMERA.observe({"plastic": item(distance_m=0.6, box=near)})   # bobbed out again
    be.CAMERA.observe({"plastic": item(distance_m=0.6, box=inside)})
    be.CAMERA.observe({"plastic": item(distance_m=0.6, box=inside)})
    time.sleep(0.2)
    check(motor_running() and not col.calls, "inside only 2x in a row: no scoop (needs 3)")
    be.CAMERA.observe({"plastic": item(distance_m=0.6, box=inside)})
    check(not motor_running(), "3rd time inside the scoop: motor OFF")
    for _ in range(80):
        if col.calls:
            break
        time.sleep(0.05)
    check(("set", True, "auto-collect") in col.calls, f"trapped: the scoop closes ({col.calls})")
    for _ in range(80):
        if ("set", False, "auto-collect") in col.calls:
            break
        time.sleep(0.05)
    for _ in range(40):
        be.CAMERA._tick()
        if be.CAMERA.view()["state"] in ("cooldown", "idle"):
            break
        time.sleep(0.05)

    print("Out of sight (the app only remembers it there): does not count")
    reset(link, col)
    time.sleep(0.4)
    be.CAMERA.observe({"plastic": item(id="77", distance_m=0.6, box=water)})
    for _ in range(6):
        be.CAMERA.observe({"plastic": item(id="77", distance_m=0.6, box=inside, visible=False)})
    time.sleep(0.3)
    check(not col.calls, "last box inside the scoop but not in sight now: the scoop does not run")

    print("Something sitting in the scoop all along (never seen on the water): no scoop, when that rule is on")
    be.OPS_SETTINGS["camera_scoop_seen_first"] = True
    reset(link, col)
    time.sleep(0.4)                           # past the cooldown
    for _ in range(6):
        be.CAMERA.observe({"plastic": item(id="55", distance_m=0.6, box=inside)})
    time.sleep(0.3)
    check(not col.calls, "first seen inside the scoop (part of the boat?): the scoop does not run")
    check("water first" in (be.CAMERA.ready_to_scoop(item(id="55", box=inside))[1] or ""),
          "and says why: not seen out on the water first")
    be.OPS_SETTINGS["camera_scoop_seen_first"] = False

    print("A bottle put straight into the scoop, big in the picture: the scoop closes (default)")
    reset(link, col)
    time.sleep(0.4)
    big_inside = [0.20, 0.50, 0.90, 1.00]     # covers 35 % of the picture, centre inside the scoop
    for _ in range(3):
        be.CAMERA.observe({"plastic": item(id="88", distance_m=0.4, box=big_inside, box_frac=0.35)})
    for _ in range(80):
        if col.calls:
            break
        time.sleep(0.05)
    check(("set", True, "auto-collect") in col.calls,
          f"bottle in the scoop (35 % of the picture, never seen outside): the scoop closes ({col.calls})")
    for _ in range(80):
        if ("set", False, "auto-collect") in col.calls:
            break
        time.sleep(0.05)
    for _ in range(40):
        be.CAMERA._tick()
        if be.CAMERA.view()["state"] in ("cooldown", "idle"):
            break
        time.sleep(0.05)

    print("A huge box out on the water is still the scene, not an item")
    reset(link, col)
    time.sleep(0.4)
    for _ in range(4):
        be.CAMERA.observe({"plastic": item(id="89", box=[0.0, 0.0, 0.6, 0.6], box_frac=0.36)})
    check(be.CAMERA.view()["state"] == "idle" and not motor_running(),
          "36 % box outside the scoop: refused")
    for _ in range(4):
        be.CAMERA.observe({"plastic": item(id="90", box=[0.0, 0.0, 1.0, 1.0], box_frac=1.0)})
    check(not col.calls, "a whole-picture box never scoops, even centred in the scoop area")

    print("An app without box positions never scoops (in trapped mode)")
    reset(link, col)
    for _ in range(6):
        be.CAMERA.observe({"plastic": item(id="66", distance_m=0.6)})
    time.sleep(0.3)
    check(not col.calls, "no box from the app: the scoop does not run")

    print("The scoop area can be moved, and must be a real area")
    _, err = be.update_ops({"scoop_zone_x1": 0.8, "scoop_zone_x2": 0.7})
    check(err is not None, f"x2 left of x1 refused ({err})")
    be.OPS_FILE = str(tmp / "ops.json")

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
