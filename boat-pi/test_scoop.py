"""
The tipping scoop on a digital servo (collector.py, collector_kind "scoop"):
starts at its 0 position, R1 sends it to its extreme and R1 again brings it
back to 0, nothing moves it by itself (live collect / missions near items,
disarm, emergency stop), and no relay is ever touched. The Pixhawk is faked,
so this runs anywhere.

Run:  python test_scoop.py
"""

import sys

import collector as col


class FakeLink:
    def __init__(self):
        self.sent = []
        self.s = {"fc_connected": True, "armed": False, "flight_mode": "MANUAL", "lat": None, "lng": None,
                  "mission_seq": 0}

    def snapshot(self):
        return dict(self.s)

    def command_long(self, cmd, params, **kw):
        assert cmd == 183, cmd
        self.sent.append(tuple(params[:2]))
        return 0


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what)
    if not cond:
        sys.exit(1)


def no_relay(*a, **kw):
    raise AssertionError("the scoop must never switch a relay")


def main():
    col.subprocess.run = no_relay
    print("Tipping scoop")
    link = FakeLink()
    # A relay pin left over from the old belt must not matter for the scoop.
    cfg = {"collector_kind": "scoop", "collector_servo": 2, "scoop_pwm_zero": 1000, "scoop_pwm_extreme": 2000,
           "collector_pwm_on": 1800, "collector_pwm_off": 1500, "collector_relay_gpio": 17,
           "collector_relay_active_low": True, "live_roller_on_m": 5}
    c = col.Collector(link, cfg)
    c._tick()
    check(link.sent == [(2, 1000)], f"connect → output 2 at the 0 position, 1000 µs ({link.sent})")
    check(c.summary()["kind"] == "scoop" and c.summary()["relay_gpio"] is None, "summary: scoop, no relay")

    for n in range(3):
        msg = c.toggle()
        check(c.on and link.sent[-1] == (2, 2000), f"R1 → extreme, 2000 µs: {msg}")
        msg = c.toggle()
        check(not c.on and link.sent[-1] == (2, 1000), f"R1 again → back to 0, 1000 µs: {msg}")

    c.toggle()
    n = len(link.sent)
    c.auto(False)
    c.auto(True)
    c.auto(False)
    check(len(link.sent) == n and c.on, "live collect / missions never move the scoop")

    link.s["armed"] = True
    c._tick()
    link.s["armed"] = False
    c._tick()
    check(len(link.sent) == n and c.on, "disarming leaves the scoop where it is")
    c.set(False, "safety")
    check(len(link.sent) == n and c.on, "emergency stop / brake leaves the scoop where it is")

    cfg["scoop_pwm_extreme"] = 2400
    c.toggle()
    c.toggle()
    check(link.sent[-1] == (2, 2400) and c.on, "a new extreme (2400 µs) is used on the next R1")

    cfg["collector_servo"] = 0
    msg = c.toggle()
    check(len(link.sent) == n + 2 and "nothing moved" in msg, f"no output set → nothing sent: {msg}")
    print("All scoop checks passed.")


if __name__ == "__main__":
    main()
