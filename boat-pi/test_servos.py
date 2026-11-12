"""
The two extra servos (servos.py), worked from the transmitter or the app.

Part 1 (in-process, NO transmitter: game controller only): the Pixhawk set-up
check and fix (SERVO6/7_FUNCTION → RCIN6/7), refused while armed and never
taking an output that has another job; both servos start "off" and hold; a
toggle moves the real output; the sticks still drive while the servos are held;
a channel with a switch function (RCn_OPTION) is flagged.

Part 2 (in-process, WITH a transmitter): the switch moves the servo with the Pi
sending nothing; the app takes one servo (toggling from where the switch has
it) without touching the sticks or the other servo; it keeps holding past the
override timeout; "give back" returns it to the switch at once; the app going
away gives it back on its own.

Part 3 (the real backend over HTTP): /api/servos/setup, /api/servo,
/api/servo/release, telemetry "servos", and the simulator's transmitter switch.

Run:  py test_servos.py
"""

import json
import os
import subprocess
import sys
import tempfile
import time

import httpx

import drive as drive_mod
import mav_link
import servos as servos_mod
from config import DEFAULTS
from sim_vehicle import SimBoat

HOME = (17.4239, 78.4738)


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def wait_for(fn, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(0.05)
    check(False, f"{what} (timed out)")


def part1():
    print("Part 1 — no transmitter: the app's controller has the servos")
    sim = SimBoat(*HOME, "tcpin:127.0.0.1:5861", sim_rate=1.0, no_transmitter=True,
                  params={"FS_THR_ENABLE": 0, "FS_GCS_ENABLE": 1, "FS_ACTION": 2})
    sim.start()
    link = mav_link.BoatLink("tcp:127.0.0.1:5861", 115200)
    link.start()
    cfg = dict(DEFAULTS, rc_source="gamepad", collector_servo=2)
    drive = drive_mod.DriveManager(link, cfg)
    sv = servos_mod.ServoManager(link, cfg)
    drive.servos = sv
    try:
        wait_for(lambda: link.fc_connected, 20, "link")
        rep = sv.check_setup()
        check(not rep["ok"] and all(r["fixable"] for r in rep["servos"]),
              f"set-up check: outputs 6 and 7 unused → fixable ({len(rep['problems'])} problems)")
        done, msg, rep = sv.setup()
        check(done and sim.params["SERVO6_FUNCTION"] == 56 and sim.params["SERVO7_FUNCTION"] == 57,
              f"set-up: {msg}")
        check(sv.check_setup()["ok"], "check now passes")

        drive.start()
        sv.start()
        wait_for(lambda: sim._output_pwm(6) == 1100 and sim._output_pwm(7) == 1100, 3, "servos at their start")
        check(True, "both servos start in the off position (1100 µs) and are held by the Pi")
        check(sim.rc["steer"] == 1500 and sim.rc["thr"] == 1500, "sticks still neutral alongside them")

        t0 = time.time()
        check(sv.set(0) == "Servo 1 on.", "D-pad left → servo 1 toggled")
        wait_for(lambda: sim._output_pwm(6) == 1900, 1, "output 6 moves")
        check(sim._output_pwm(7) == 1100, f"output 6 → 1900 µs in {time.time() - t0:.2f} s; servo 2 unchanged")

        link.arm(True)
        link.set_mode("MANUAL")
        drive.connected(True)
        end = time.time() + 1.0
        while time.time() < end:
            drive.input(0, 1.0)
            time.sleep(0.05)
        check(sim.rc["thr"] > 1600 and sim._output_pwm(6) == 1900,
              f"driving (throttle {sim.rc['thr']} µs) keeps servo 1 where it was")
        sv.set(1, True)
        wait_for(lambda: sim._output_pwm(7) == 1900, 1, "servo 2 on while armed")
        check(True, "servo 2 moves while armed and driving")
        drive.brake()
        time.sleep(0.3)
        check(sim._output_pwm(6) == 1900 and sim._output_pwm(7) == 1900, "brake stops the boat but leaves the servos")
        check("always has" in sv.release(None), "give-back is a no-op without a transmitter")

        done, msg, _ = sv.setup()
        check(not done and "Disarm" in msg, f"set-up refused while armed: {msg}")
        link.arm(False)

        sim.params["RC7_OPTION"] = 7.0
        rep = sv.check_setup()
        check(not rep["ok"] and any("RC7_OPTION" in p for p in rep["problems"]), "a switch function on channel 7 is flagged")
        sim.params["RC7_OPTION"] = 0.0
        cfg["servo1_output"] = 1                       # the rudder servo
        rep = sv.check_setup()
        check(any("already does something else" in p for p in rep["problems"]), "an output with another job is flagged…")
        done, _, _ = sv.setup()
        check(not done and sim.params["SERVO1_FUNCTION"] == 26, "…and never taken over (the rudder stays the rudder)")
        cfg["servo1_output"] = 2                       # the roller
        check(any("intake roller" in p for p in sv.check_setup()["problems"]), "the roller's output is refused")
        cfg["servo1_output"] = 6
    finally:
        sv.stop()
        drive.stop()
        link.stop()
        sim.stop()


def part2():
    print("Part 2 — with a transmitter: the switch, or the app until it gives it back")
    sim = SimBoat(*HOME, "tcpin:127.0.0.1:5862", sim_rate=1.0, no_transmitter=False,
                  params={"SERVO6_FUNCTION": 56, "SERVO7_FUNCTION": 57})
    sim.start()
    link = mav_link.BoatLink("tcp:127.0.0.1:5862", 115200)
    link.start()
    present = {"on": True}
    cfg = dict(DEFAULTS, rc_source="transmitter")
    drive = drive_mod.DriveManager(link, cfg)
    sv = servos_mod.ServoManager(link, cfg, app_present=lambda: present["on"])
    drive.servos = sv
    try:
        wait_for(lambda: link.fc_connected, 20, "link")
        drive.start()
        sv.start()
        check(sv.check_setup()["ok"], "Pixhawk already set up (RCIN6 / RCIN7)")
        sim.tx[6] = 1900
        wait_for(lambda: sv.status()["servos"][0]["on"] is True, 3, "switch seen")
        check(not sim.rc_over and sv.status()["servos"][0]["by"] == "transmitter",
              "transmitter switch moves servo 1 with the Pi sending nothing")

        sv.set(0)                                      # toggle: the switch has it on → off
        wait_for(lambda: sim._output_pwm(6) == 1100, 1, "app moves servo 1")
        check(set(sim.rc_over) == {6}, f"the app overrides channel 6 only (overrides: {sorted(sim.rc_over)})")
        check(sv.status()["servos"][0]["by"] == "app", "telemetry: servo 1 held by the app")
        sim.tx[7] = 1900
        time.sleep(0.4)
        check(sim._output_pwm(7) == 1900, "servo 2 still follows its switch")
        time.sleep(3.5)                                # longer than RC_OVERRIDE_TIME (3 s)
        check(sim._output_pwm(6) == 1100, "the app keeps holding servo 1 past the override timeout")

        msg = sv.release(0)
        time.sleep(0.1)
        check(sim._output_pwm(6) == 1900 and 6 not in sim.rc_over, f"give back → switch position at once: {msg}")

        sv.set(1, False)
        wait_for(lambda: sim._output_pwm(7) == 1100, 1, "app takes servo 2")
        present["on"] = False                          # the app closes
        wait_for(lambda: sim._output_pwm(7) == 1900, 2, "auto give-back")
        check(not sv.held[1] and any("app went away" in e["text"] for e in sv.events),
              "app gone → servo 2 goes back to its switch")
    finally:
        sv.stop()
        drive.stop()
        link.stop()
        sim.stop()


def part3():
    print("Part 3 — the backend over HTTP")
    here = os.path.dirname(os.path.abspath(__file__))
    port = 8871
    env = dict(os.environ, BOAT_RC_SOURCE="transmitter", BOAT_SIM_TCP_PORT="5871", PYTHONUNBUFFERED="1",
               PYTHONIOENCODING="utf-8", BOAT_CAMERA_SOURCE="off", BOAT_SIM_PARAMS=json.dumps({}))
    log = open(os.path.join(tempfile.gettempdir(), "test_servos_backend.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--sim", "--port", str(port), "--host", "127.0.0.1"],
                            cwd=here, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=20)
    try:
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 40, "backend + simulated Pixhawk")
        r = c.get("/api/servos/setup").json()
        check(not r["ok"], f"set-up check over HTTP: {r['problems'][0][:70]}…")
        r = c.post("/api/servos/setup").json()
        check(r["success"] and r["report"]["ok"], f"set-up over HTTP: {r['message']}")
        servo = lambda i: c.get("/api/telemetry").json()["servos"]["servos"][i]
        check(servo(0)["by"] == "transmitter" and servo(0)["name"] == "Servo 1", "telemetry lists the servos")
        r = c.post("/api/sim/switch", json={"channel": 7, "us": 1900}).json()
        check(r["success"], r["message"])
        wait_for(lambda: servo(1)["on"] is True and servo(1)["us"] == 1900, 3, "switch in telemetry")
        check(True, "telemetry shows servo 2 on from the transmitter (1900 µs)")
        r = c.post("/api/servo", json={"servo": 1}).json()
        check(r["success"] and r["message"] == "Servo 1 on.", f"POST /api/servo toggle: {r['message']}")
        wait_for(lambda: servo(0)["us"] == 1900 and servo(0)["by"] == "app", 3, "app has servo 1")
        check(True, "servo 1 on, held by the app")
        r = c.post("/api/servo", json={"servo": 3}).json()
        check(r.get("success") is not True, "servo 3 rejected")
        r = c.post("/api/servo/release", json={}).json()
        check(r["success"] and "transmitter has it" in r["message"], f"give back: {r['message']}")
        wait_for(lambda: servo(0)["by"] == "transmitter" and servo(0)["us"] == 1100, 3, "back to the switch")
        check(True, "servo 1 back on its switch (1100 µs)")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    part1()
    part2()
    part3()
    print("ALL SERVO CHECKS PASSED")
