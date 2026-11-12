"""
The intake roller on a relay module (collector.py, collector_relay_gpio): the
pinctrl commands for on / off, off at start and at shutdown, R1 toggling,
off on disarm, and an active-high module. pinctrl itself is faked, so this
runs anywhere.

Run:  python test_relay.py
"""

import subprocess
import sys

import collector as col

calls = []


def fake_run(cmd, **kw):
    calls.append(cmd[1:])
    return subprocess.CompletedProcess(cmd, 0, "", "")


class FakeLink:
    def __init__(self):
        self.s = {"fc_connected": True, "armed": False, "flight_mode": "MANUAL", "lat": None, "lng": None,
                  "mission_seq": 0}

    def snapshot(self):
        return dict(self.s)

    def command_long(self, *a, **kw):
        raise AssertionError("a relay roller must not send DO_SET_SERVO")


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what)
    if not cond:
        sys.exit(1)


def main():
    col.subprocess.run = fake_run
    print("Relay roller")
    link = FakeLink()
    cfg = {"collector_kind": "roller", "collector_servo": 2, "collector_pwm_on": 1800, "collector_pwm_off": 1500,
           "collector_relay_gpio": 17, "collector_relay_active_low": True, "live_roller_on_m": 5}
    c = col.Collector(link, cfg)
    c._tick()
    check(calls == [["set", "17", "ip", "pn"]], f"off at start: pin released ({calls})")
    c._tick()
    check(len(calls) == 1, "not sent again every step")
    link.s["armed"] = True
    c._tick()
    calls.clear()
    c.toggle()
    check(c.on and calls == [["set", "17", "op", "dl"]], "R1 → on: pin driven low (active-low module)")
    check(c.summary()["relay_gpio"] == 17, "telemetry names the relay pin")
    calls.clear()
    link.s["armed"] = False
    c._tick()
    check(not c.on and calls == [["set", "17", "ip", "pn"]], "disarm → off")
    calls.clear()
    c.stop()
    check(calls == [["set", "17", "ip", "pn"]], "service stopping → off")

    calls.clear()
    cfg["collector_relay_active_low"] = False
    c = col.Collector(link, cfg)
    c._tick()
    link.s["armed"] = True
    c._tick()
    c.set(True)
    check(calls == [["set", "17", "op", "dl"], ["set", "17", "op", "dh"]], f"active-high module: off low, on high ({calls})")

    col.subprocess.run = lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "pinctrl: no access")
    try:
        c.set(False)
        check(False, "a failed pinctrl raises")
    except col.LinkError as exc:
        check("GPIO17" in str(exc), f"a failed pinctrl is reported: {exc}")
    print("\nRELAY TESTS PASSED")


if __name__ == "__main__":
    main()
