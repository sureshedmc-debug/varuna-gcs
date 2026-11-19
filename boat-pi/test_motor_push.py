"""
Motor on drone signal (boat_extras.MotorPush): a NEW plastic find from the
drone runs the motor at motor_power_pct (50 %) for motor_run_s by overriding
the THROTTLE channel (CH3) only. No steering, no GUIDED, no correction. Only
when the boat is ARMED in MANUAL; STOP / SwD / disarm / link loss / timeout
hand the throttle straight back to the transmitter. The Pixhawk is faked, so
this runs anywhere.

Run:  py test_motor_push.py
"""

import sys
import tempfile
import time
from pathlib import Path

import boat_extras as be
import live_collect


class FakeLink:
    def __init__(self):
        self.fc_connected = True
        self.target_system = 1
        self.sent = []                 # (values, others) of every RC override
        self.params = {}
        self.s = {"fc_connected": True, "armed": False, "flight_mode": "MANUAL", "lat": None, "lng": None,
                  "home_lat": None, "home_lng": None, "gps_fix": 0, "mission_seq": 0}

    def snapshot(self):
        return dict(self.s, fc_connected=self.fc_connected)

    def rc_override_channels(self, values, others=0):
        self.sent.append((dict(values), others))
        return True

    def get_param(self, name, timeout=3.0):
        return self.params.get(name)

    def set_mode(self, name):
        self.s["flight_mode"] = name
        return f"Mode set to {name}."


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what)
    if not cond:
        sys.exit(1)


def ardupilot_throttle(pwm, p):
    """RC_Channel::pwm_to_angle_dz_trim for the throttle (high_in 100), integer maths as in C."""
    mn, tr, mx, dz = int(p["RC3_MIN"]), int(p["RC3_TRIM"]), int(p["RC3_MAX"]), int(p["RC3_DZ"])
    r = max(mn, min(mx, pwm))
    hi, lo = tr + dz, tr - dz
    if r > hi and mx != hi:
        return int(100 * (r - hi) / (mx - hi))
    if r < lo and lo != mn:
        return int(100 * (r - lo) / (lo - mn))
    return 0


def make(link, **settings):
    events = []
    st = {"motor_on_signal": True, "motor_power_pct": 50, "motor_run_s": 10}
    st.update(settings)
    mp = be.MotorPush(get_link=lambda: link, event=lambda text, level="info": events.append((level, text)),
                      settings=st, get_cfg=lambda: {"rc_source": "transmitter"})
    return mp, st, events


def ch1_never_touched(link):
    return all(1 not in v and others is None for v, others in link.sent)


def main():
    print("Throttle µs")
    d = be.MOTOR_PARAM_DEFAULTS
    check(be.throttle_pwm(50, d) == 1525, f"boat values: 50 % -> CH3 {be.throttle_pwm(50, d)} µs (1525)")
    check(ardupilot_throttle(1525, d) == 50, "ArduPilot reads 1525 µs as exactly 50 %")
    sim = dict(d, RC3_MIN=1100, RC3_TRIM=1500, RC3_MAX=1900, RC3_DZ=30)
    for p in (d, sim):
        bad = [pct for pct in range(1, 101) if ardupilot_throttle(be.throttle_pwm(pct, p), p) != pct]
        check(not bad, f"every 1-100 % lands exactly (RC3 {p['RC3_MIN']:g}/{p['RC3_TRIM']:g}/{p['RC3_MAX']:g})")
    check(be.throttle_pwm(0, d) == 1000, "0 % -> the trim (stopped)")
    mp = be.MotorPush(get_link=lambda: None, event=lambda *a, **k: None, settings={})
    check(mp.esc_us(50) == 1500, "50 % -> ESC 1500 µs (SERVO3 1000-2000)")

    print("Not ready: nothing moves")
    link = FakeLink()
    mp, st, ev = make(link)
    ok, msg = mp.signal(["p1"])
    check(not ok and "DISARMED" in msg and not link.sent, f"disarmed: refused, nothing sent ({msg})")
    link.s.update(armed=True, flight_mode="ACRO")
    ok, msg = mp.signal(["p1"])
    check(not ok and "not MANUAL" in msg and not link.sent, f"ACRO: refused ({msg})")
    link.s["flight_mode"] = "GUIDED"
    ok, _ = mp.signal(["p1"])
    check(not ok and not link.sent, "GUIDED: refused (live collect drives there, not this)")
    link.s["flight_mode"] = "MANUAL"
    link.fc_connected = False
    ok, msg = mp.signal(["p1"])
    check(not ok and "not connected" in msg and not link.sent, "no Pixhawk: refused")
    link.fc_connected = True
    st["motor_on_signal"] = False
    ok, msg = mp.signal(["p1"])
    check(not ok and "Auto motor is OFF" in msg and not link.sent, "Auto motor OFF: refused")
    gp = be.MotorPush(get_link=lambda: link, event=lambda *a, **k: None, settings=dict(st, motor_on_signal=True),
                      get_cfg=lambda: {"rc_source": "gamepad"})
    check(not gp.signal(["p1"])[0] and not link.sent, "rc_source gamepad: refused (drive.py owns CH3)")
    st["motor_on_signal"] = True

    print("Armed in MANUAL: motor at 50 %, CH3 only")
    ok, msg = mp.signal(["p1"])
    check(ok and mp.on and link.sent[-1] == ({3: 1525}, None), f"started at once: {msg}")
    for _ in range(3):
        mp.step()
    check(link.sent[-1] == ({3: 1525}, None) and len(link.sent) == 4, "kept alive every tick")
    check(ch1_never_touched(link), "steering / every other channel never touched (sent as 'ignore')")
    until = mp.until
    time.sleep(0.05)
    ok, msg = mp.signal(["p2"])
    check(ok and mp.until > until and "stays" in msg, f"a new find restarts the time: {msg}")

    print("Hand back to the transmitter")
    link.s["flight_mode"] = "ACRO"
    mp.step()
    check(not mp.on and link.sent[-1] == ({3: 0}, None), "SwD flipped to ACRO -> CH3 released")
    n = len(link.sent)
    mp.step()
    check(len(link.sent) == n, "nothing sent after the release")
    link.s["flight_mode"] = "MANUAL"
    mp.signal(["p3"])
    link.s["armed"] = False
    mp.step()
    check(not mp.on and link.sent[-1] == ({3: 0}, None), "disarmed -> released")
    link.s["armed"] = True
    mp.signal(["p4"])
    link.fc_connected = False
    mp.step()
    check(not mp.on, "Pixhawk link lost -> stopped")
    link.fc_connected = True
    mp.signal(["p5"])
    check(mp.stop("operator") and not mp.on and link.sent[-1] == ({3: 0}, None), "STOP -> released")
    check(not mp.stop("again"), "stop when not running: nothing")
    st["motor_run_s"] = 0.2
    mp.signal(["p6"])
    time.sleep(0.3)
    mp.step()
    check(not mp.on and link.sent[-1] == ({3: 0}, None) and "run finished" in ev[-1][1],
          f"time up -> released ({ev[-1][1]})")
    st["motor_run_s"] = 10
    st["motor_on_signal"] = False
    ok, _ = mp.signal(["test"], source="operator test", force=True)
    check(ok and mp.on, "the app's Test runs it even with Auto motor OFF")
    mp.stop("test done")
    st["motor_on_signal"] = True
    st["motor_power_pct"] = 80
    ok, msg = mp.signal(["p7"])
    check(ok and "capped to 50 %" in msg, f"above MOT_THR_MAX: told it is capped ({msg})")
    mp.stop("done")
    st["motor_power_pct"] = 50

    print("Pixhawk's own RC3 values")
    link.params = {"RC3_MIN": 1100.0, "RC3_TRIM": 1500.0, "RC3_MAX": 1900.0, "RC3_DZ": 30.0, "RC3_REVERSED": 0.0,
                   "SERVO3_TRIM": 950.0, "SERVO3_MAX": 2000.0, "MOT_THR_MAX": 100.0}
    mp._read_params(link)
    check(mp.params_from == "pixhawk" and be.throttle_pwm(50, mp.params) == 1715,
          f"read: 50 % -> CH3 {be.throttle_pwm(50, mp.params)} µs")
    v = mp.view(link.snapshot())
    check(v["ch3_us"] == 1715 and v["esc_expected_us"] == 1475 and v["ready"], f"status view: {v['ch3_us']} µs, ESC {v['esc_expected_us']} µs")

    print("Drone finds through live collect")
    link = FakeLink()
    link.s.update(armed=True, flight_mode="MANUAL")
    mp, st, ev = make(link)
    old = be.MOTOR
    be.MOTOR = mp
    try:
        with tempfile.TemporaryDirectory() as tmp:
            live = live_collect.LiveCollect(link, None, {"max_distance_m": 500, "live_merge_m": 1.0}, Path(tmp))
            res = live.add_targets([{"id": "drone-1", "lat": 28.6, "lng": 77.2, "object_class": "bottle"}])
            check(res["added"] == ["drone-1"] and mp.on and link.sent[-1] == ({3: 1525}, None),
                  "new drone find -> motor on")
            until = mp.until
            time.sleep(0.05)
            live.add_targets([{"id": "drone-1", "lat": 28.6, "lng": 77.2}])
            check(mp.until == until, "the same find sent again -> no new signal")
            live.add_targets([{"id": "drone-1b", "lat": 28.600001, "lng": 77.2}])
            check(mp.until == until, "a find merged into the same plastic -> no new signal")
            live.operator("hold")
            check(not mp.on and link.sent[-1] == ({3: 0}, None), "STOP in the app (Hold) -> released")
            live.add_targets([{"id": "drone-2", "lat": 28.601, "lng": 77.2}])
            check(mp.on, "another new find -> on again")
            live.pause("paused from the app", hold=False)
            check(not mp.on, "Pause -> released")
    finally:
        be.MOTOR = old
    print("All motor-push checks passed.")


if __name__ == "__main__":
    main()
