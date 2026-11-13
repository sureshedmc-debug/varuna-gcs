"""
Driving the boat with a game controller instead of an RC transmitter.

Part 1 (in-process: simulated Pixhawk with NO transmitter + the boat's link and
drive manager), set up as the real boat is: radio failsafe off, the Pi's
heartbeat failsafe on (FS_GCS_ENABLE 1, FS_GCS_TIMEOUT 3, FS_ACTION Hold).
It arms with no transmitter; MANUAL driving follows the sticks with the
throttle limit; a closed controller socket centres the sticks at once; a silent
controller link puts the boat in HOLD; Pixhawk parameters can be read and set;
if the boat Pi dies mid-throttle (the last stick value stays in force, as on a
Pixhawk with no receiver), the heartbeat failsafe stops the boat; with a
transmitter nothing is sent.

Part 2 (the real backend over HTTP): the /api/drive WebSocket the app uses,
telemetry, and the failsafe check endpoints.

Run:  python test_gamepad.py
"""

import json
import math
import os
import subprocess
import sys
import tempfile
import time

import httpx

import drive as drive_mod
import mav_link
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
        time.sleep(0.1)
    check(False, f"{what} (timed out)")


def moved(sim, start):
    n = math.radians(sim.lat - start[0]) * 6371000.0
    e = math.radians(sim.lng - start[1]) * 6371000.0 * math.cos(math.radians(start[0]))
    return math.hypot(n, e)


def part1():
    print("Part 1 — no transmitter, simulated Pixhawk")
    sim = SimBoat(*HOME, "tcpin:127.0.0.1:5841", sim_rate=1.0, no_transmitter=True,
                  params={"FS_THR_ENABLE": 0, "FS_GCS_ENABLE": 1, "FS_GCS_TIMEOUT": 3, "FS_ACTION": 2})
    sim.start()
    link = mav_link.BoatLink("tcp:127.0.0.1:5841", 115200)
    link.start()
    cfg = dict(DEFAULTS, rc_source="gamepad", gamepad_max_throttle=0.5)
    drive = drive_mod.DriveManager(link, cfg)
    try:
        wait_for(lambda: link.fc_connected, 20, "link")
        drive.start()
        wait_for(lambda: sim.rc["t"] > 0, 5, "the Pi's overrides")
        check(sim.rc["thr"] == 1500 and sim.rc["steer"] == 1500, "the Pi sends neutral (1500 µs) when nobody drives")
        check(link.arm(True).startswith("Armed"), "arms with no transmitter (radio failsafe off)")
        drive.input(0, 0.5)
        half = drive.pwm()[1]
        drive.input(0, 0)
        check(half == 1562, f"throttle curve: half stick at a 50% limit → {half} µs (1562 with expo 0.5, 1600 linear)")
        link.set_mode("MANUAL")

        drive.connected(True)
        start = (sim.lat, sim.lng)
        end = time.time() + 3
        while time.time() < end:
            drive.input(0, 1.0, "Xbox Wireless Controller")
            time.sleep(0.05)
        check(abs(sim.speed - 1.0) < 0.15, f"full stick at a 50% limit → {sim.speed:.2f} m/s of 2.0 (throttle {sim.rc['thr']} µs)")
        check(moved(sim, start) > 2, f"the boat drove {moved(sim, start):.1f} m")
        h0 = sim.heading
        end = time.time() + 1.5
        while time.time() < end:
            drive.input(1.0, 1.0)
            time.sleep(0.05)
        turned = (sim.heading - h0 + 540) % 360 - 180
        check(turned > 40, f"right stick turns it right ({turned:.0f}°)")
        rud, mot = sim._output_pwm(1), sim._output_pwm(3)
        check(rud > 1800 and 1300 < mot < 2000, f"one motor + rudder: rudder servo (out 1) {rud} µs, motor (out 3) {mot} µs")
        end = time.time() + 1.0
        while time.time() < end:
            drive.input(-1.0, 0)
            time.sleep(0.05)
        rud, mot = sim._output_pwm(1), sim._output_pwm(3)
        check(rud < 1200 and mot == 950 and sim.speed == 0.0, f"stopped, stick left: rudder {rud} µs, motor stopped at {mot} µs")
        h0 = sim.heading
        time.sleep(0.5)
        check(abs((sim.heading - h0 + 540) % 360 - 180) < 1, "a rudder doesn't turn a boat that isn't moving")
        end = time.time() + 1.0
        while time.time() < end:
            drive.input(0, -1.0)
            time.sleep(0.05)
        check(sim.speed == 0.0 and sim._output_pwm(3) == 950, "throttle stick back → no reverse (forward-only ESC stays stopped)")

        drive.connected(False)                     # the app closed the controller socket
        wait_for(lambda: sim.rc["thr"] == 1500 and sim.speed == 0.0, 1.0, "centred on socket close")
        check(True, "controller socket closed → sticks centred at once, boat stops")
        check(link.snapshot()["flight_mode"] == "MANUAL" and link.snapshot()["armed"], "…still armed in MANUAL")

        drive.connected(True)
        end = time.time() + 1.5
        while time.time() < end:
            drive.input(0, 0.8)
            time.sleep(0.05)
        t_quiet = time.time()                      # the PC goes quiet, socket still "open"
        wait_for(lambda: sim.speed == 0.0, 1.5, "stop after the input timeout")
        check(time.time() - t_quiet < 1.5, f"controller silent → stopped after {time.time() - t_quiet:.1f} s")
        wait_for(lambda: link.snapshot()["flight_mode"] == "HOLD", 6, "HOLD after the controller link is lost")
        check(any("Controller link lost" in e["text"] for e in drive.events),
              f"controller link lost while driving → HOLD after {time.time() - t_quiet:.1f} s")

        check(link.get_param("FS_ACTION") == 2.0, "reads Pixhawk parameters (FS_ACTION = 2)")
        check(link.set_param("FS_ACTION", 1) == 1.0 and link.get_param("FS_ACTION") == 1.0, "sets a parameter and confirms it")
        link.set_param("FS_ACTION", 2)

        # The boat Pi dies mid-throttle: no more overrides and no more heartbeats.
        # The last stick value stays in force (no receiver), so the boat keeps
        # going until the Pixhawk's heartbeat failsafe holds it.
        link.set_mode("MANUAL")
        end = time.time() + 1.5
        while time.time() < end:
            drive.input(0, 1.0)
            time.sleep(0.05)
        drive.stop()
        link.stop()
        t_dead = time.time()
        check(sim.speed > 0.5, f"Pi dead: the boat is still driving on the last stick value ({sim.speed:.1f} m/s)")
        wait_for(lambda: sim.mode == mav_link.ROVER_MODES["HOLD"], 8, "Pixhawk heartbeat failsafe")
        took = time.time() - t_dead
        check(sim.gcs_failsafe and took < 5.5, f"Pi dead → the heartbeat failsafe holds the boat after {took:.1f} s")
        wait_for(lambda: sim.speed == 0.0, 2, "stopped in HOLD")
        check(True, "…and it stops")
    finally:
        link.stop()
        sim.stop()

    # With a transmitter the Pi must not send any stick values.
    sim = SimBoat(*HOME, "tcpin:127.0.0.1:5842")
    sim.start()
    link = mav_link.BoatLink("tcp:127.0.0.1:5842", 115200)
    link.start()
    drive = drive_mod.DriveManager(link, dict(DEFAULTS, rc_source="transmitter"))
    try:
        wait_for(lambda: link.fc_connected, 20, "link")
        drive.start()
        drive.connected(True)
        drive.input(0, 1.0)
        time.sleep(1.5)
        check(sim.rc["t"] == 0.0, "with a transmitter: no RC override is ever sent")
        drive.stop()
    finally:
        link.stop()
        sim.stop()


def part2():
    import asyncio

    import websockets

    print("Part 2 — the backend's /api/drive socket and failsafe endpoints")
    here = os.path.dirname(os.path.abspath(__file__))
    port = 8851
    board = os.path.join(tempfile.gettempdir(), "test_gamepad_board_mv.txt")
    with open(board, "w") as f:
        f.write("5100")                            # battery in
    env = dict(os.environ, BOAT_RC_SOURCE="gamepad", BOAT_SIM_TCP_PORT="5843", PYTHONUNBUFFERED="1",
               BOAT_SIM_BOARD_FILE=board,
               PYTHONIOENCODING="utf-8", BOAT_CAMERA_SOURCE="off",
               BOAT_SIM_PARAMS=json.dumps({"FS_THR_ENABLE": 0, "FS_ACTION": 0}))   # a badly set-up Pixhawk
    log = open(os.path.join(tempfile.gettempdir(), "test_gamepad_backend.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--sim", "--port", str(port), "--host", "127.0.0.1"],
                            cwd=here, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=20)
    try:
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 40, "backend + simulated Pixhawk")
        t = c.get("/api/telemetry").json()
        check(t["drive"]["source"] == "gamepad", "telemetry reports driving by game controller")
        check(c.get("/api/boat/info").json()["rc_source"] == "gamepad", "/api/boat/info reports it too")
        fs = c.get("/api/pixhawk/failsafe").json()
        check(not fs["ok"] and len(fs["problems"]) == 2, f"failsafe check flags FS_GCS_ENABLE=0 and FS_ACTION=0: {fs['problems']}")
        r = c.post("/api/pixhawk/failsafe/fix").json()
        check(r["success"] and r["report"]["ok"], f"failsafe fix: {r['message']}")
        fs = c.get("/api/pixhawk/failsafe").json()
        check(fs["ok"] and fs["action"] == "hold (stop)", f"failsafe now: {fs['values']}")
        # ESC calibration (automatic): refused with the battery in; with it out, the
        # motor's output (3, the one middle motor) goes to full signal, and when the
        # battery goes in the Pi waits, sets minimum, and puts the motor back with the
        # range 1000–2000. The rudder servo on output 1 is never touched.
        esc = lambda step, **kw: c.post("/api/pixhawk/esc_calibration", json={"step": step, **kw}, timeout=60).json()
        status = lambda: c.get("/api/pixhawk/esc_calibration").json()
        wait_for(lambda: status()["board_v"], 10, "board voltage from POWER_STATUS")
        r = esc("auto")
        check(not r["success"] and "battery looks connected" in r["message"], f"refused with the battery in: {r['message'][:70]}")
        with open(board, "w") as f:
            f.write("4200")                        # battery unplugged: Pixhawk on USB
        wait_for(lambda: status()["battery_in"] is False, 5, "battery out seen")
        r = esc("auto", outputs=[1])
        check(not r["success"] and "isn't a motor" in r["message"], f"the steering servo is refused: {r['message']}")
        r = esc("auto")
        p = c.get("/api/pixhawk/params?names=SERVO1_FUNCTION,SERVO3_FUNCTION").json()["values"]
        check(r["success"] and p == {"SERVO1_FUNCTION": 26.0, "SERVO3_FUNCTION": 0.0},
              "battery out → the motor's output 3 freed at full signal, the rudder servo (1) untouched")
        check(not c.post("/api/mavlink/arm", json={"arm": True}).json()["success"], "arming is refused during an ESC calibration")
        time.sleep(1.5)
        check(status()["phase"] == "waiting", "…waiting for the battery")
        t_in = time.time()
        with open(board, "w") as f:
            f.write("5100")                        # battery plugged in
        wait_for(lambda: status()["phase"] == "low", 8, "minimum after the battery goes in")
        took = time.time() - t_in
        check(3.9 <= took <= 6.0, f"minimum sent {took:.1f} s after the battery went in (top held ~4 s)")
        wait_for(lambda: status()["phase"] == "done", 10, "calibration done")
        p = c.get("/api/pixhawk/params?names=SERVO3_FUNCTION,SERVO3_MIN,SERVO3_TRIM,SERVO3_MAX").json()["values"]
        check(p == {"SERVO3_FUNCTION": 70.0, "SERVO3_MIN": 1000.0, "SERVO3_TRIM": 1000.0, "SERVO3_MAX": 2000.0},
              f"done: motor back on output 3, range 1000–2000, stopped at 1000 — {status()['message']}")
        p = c.get("/api/pixhawk/params?names=SERVO1_FUNCTION,SERVO1_MIN,SERVO1_TRIM,SERVO1_MAX").json()["values"]
        check(p == {"SERVO1_FUNCTION": 26.0, "SERVO1_MIN": 1100.0, "SERVO1_TRIM": 1500.0, "SERVO1_MAX": 1900.0},
              "…the rudder servo keeps its centre (1500) and range")
        # Cancel while waiting: the thruster goes straight back.
        with open(board, "w") as f:
            f.write("4200")
        wait_for(lambda: status()["battery_in"] is False, 5, "battery out seen")
        check(esc("auto")["success"], "second run started")
        check(esc("cancel")["success"], "cancel")
        wait_for(lambda: not status()["active"], 5, "cancelled")
        p = c.get("/api/pixhawk/params?names=SERVO3_FUNCTION").json()["values"]
        check(p["SERVO3_FUNCTION"] == 70.0 and status()["phase"] == "cancelled", "cancel → motor back on output 3")
        with open(board, "w") as f:
            f.write("5100")

        # Motor matching: spin the motor at an exact signal, save where it starts.
        r = c.post("/api/pixhawk/motor_test", json={"motor": "motor", "pwm": 1150, "seconds": 2}).json()
        check(r["success"], f"motor test: {r['message']}")
        check(not c.post("/api/pixhawk/motor_test", json={"motor": "motor", "pwm": 1900}).json().get("success", False),
              "motor test above 1500 µs is refused")
        r = c.post("/api/pixhawk/motor_test", json={"motor": "left", "pwm": 1150}).json()
        check(not r["success"], f"no left motor on this boat → refused: {r['message']}")
        r = c.post("/api/pixhawk/motor_start", json={"motor": "motor", "pwm": 1130}).json()
        m = c.get("/api/pixhawk/motors").json()["motors"]
        check(r["success"] and m["motor"] == {"output": 3, "stop": 1115.0, "max": 2000.0} and m["left"] is None,
              f"motor start saved: the motor (output 3) stopped at 1115 µs, starts at 1130 — {m}")
        # The older twin-motor boat still works.
        c.post("/api/pixhawk/params", json={"values": {"SERVO1_FUNCTION": 73, "SERVO3_FUNCTION": 74}})
        m = c.get("/api/pixhawk/motors").json()["motors"]
        check(m["left"]["output"] == 1 and m["right"]["output"] == 3 and m["motor"] is None, "twin motors: left 1, right 3")
        c.post("/api/pixhawk/params", json={"values": {"SERVO1_FUNCTION": 26, "SERVO3_FUNCTION": 70}})

        r = c.post("/api/mavlink/arm", json={"arm": True}).json()
        check(r["success"], f"arm through the API with no transmitter: {r['message']}")
        r = c.post("/api/mavlink/mode", json={"mode": "MANUAL"}).json()
        check(r["success"], "MANUAL")

        async def drive_for(secs, s, t_):
            async with websockets.connect(f"ws://127.0.0.1:{port}/api/drive") as ws:
                end = time.time() + secs
                while time.time() < end:
                    await ws.send(json.dumps({"s": s, "t": t_, "pad": "Test Pad"}))
                    await asyncio.sleep(0.05)
                return c.get("/api/telemetry").json()

        t = asyncio.run(drive_for(3, 0, 1))
        check(t["drive"]["linked"] and t["drive"]["pad"] == "Test Pad", "the drive socket is linked, controller named")
        check(t["groundspeed"] > 0.8, f"driving through /api/drive: {t['groundspeed']:.2f} m/s")
        wait_for(lambda: c.get("/api/telemetry").json()["groundspeed"] == 0, 2, "stop after the socket closes")
        check(True, "socket closed → boat stops")
        r = c.post("/api/vision/config", json={"gamepad_max_throttle": 0.3}).json()
        check(r.get("success") is not False and c.get("/api/telemetry").json()["drive"]["max_throttle"] == 0.3,
              "max throttle is a live setting (0.3)")
        t = asyncio.run(drive_for(2.5, 0, 1))
        check(abs(t["groundspeed"] - 0.6) < 0.15, f"…and limits the speed: {t['groundspeed']:.2f} m/s")

        # Instant brake (L1 + R1): sent over the drive socket while driving.
        async def brake_while_driving():
            async with websockets.connect(f"ws://127.0.0.1:{port}/api/drive") as ws:
                for _ in range(40):
                    await ws.send(json.dumps({"s": 0, "t": 1, "pad": "Test Pad"}))
                    await asyncio.sleep(0.05)
                t0 = time.time()
                await ws.send(json.dumps({"brake": True}))
                while c.get("/api/telemetry").json()["armed"] and time.time() - t0 < 3:
                    await ws.send(json.dumps({"s": 0, "t": 1, "pad": "Test Pad"}))   # stick still pushed
                    await asyncio.sleep(0.02)
                return time.time() - t0

        took = asyncio.run(brake_while_driving())
        check(took < 1.0, f"brake over the drive socket disarmed in {took:.2f} s")
        wait_for(lambda: c.get("/api/telemetry").json()["flight_mode"] == "HOLD", 4, "HOLD after the brake")
        check(c.get("/api/telemetry").json()["collector"]["on"] is False, "roller off after the brake")
        check(c.post("/api/mavlink/arm", json={"arm": True}).json()["success"], "re-arm after the brake")
        t0 = time.time()
        r = c.post("/api/mavlink/brake").json()
        took = time.time() - t0
        t = c.get("/api/telemetry").json()
        check(r["success"] and not t["armed"] and t["flight_mode"] == "HOLD",
              f"brake over HTTP: {r['message']} ({took:.2f} s)")
    finally:
        proc.terminate()
        proc.wait(10)


if __name__ == "__main__":
    part1()
    part2()
    print("\nGAME CONTROLLER TESTS PASSED")
