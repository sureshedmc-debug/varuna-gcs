"""
Driving the boat with a game controller instead of an RC transmitter.

Part 1 (in-process: simulated Pixhawk with NO transmitter + the boat's link and
drive manager): arming works only because the Pi streams RC overrides; MANUAL
driving follows the sticks with the throttle limit; a closed controller socket
centres the sticks at once; a silent controller link puts the boat in HOLD; if
the boat Pi dies, the Pixhawk's own radio failsafe stops the boat; Pixhawk
parameters can be read and set; with a transmitter nothing is sent.

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
    sim = SimBoat(*HOME, "tcpin:127.0.0.1:5841", sim_rate=1.0, no_transmitter=True)
    sim.start()
    link = mav_link.BoatLink("tcp:127.0.0.1:5841", 115200)
    link.start()
    cfg = dict(DEFAULTS, rc_source="gamepad", gamepad_max_throttle=0.5)
    drive = drive_mod.DriveManager(link, cfg)
    try:
        wait_for(lambda: link.fc_connected, 20, "link")
        # Without the Pi's overrides the Pixhawk has no radio: arming is refused.
        try:
            link.arm(True)
            armed_without = True
        except mav_link.LinkError as exc:
            armed_without = False
            why = str(exc)
        check(not armed_without and "Radio failsafe" in why, f"no transmitter, no overrides → arming refused ({why})")

        drive.start()
        wait_for(lambda: not sim.rc_failsafe, 5, "radio failsafe cleared by the Pi's overrides")
        check(True, "the Pi's neutral overrides clear the radio failsafe")
        check(link.arm(True).startswith("Armed"), "arms with no transmitter")
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

        # The boat Pi dies: no more overrides. The Pixhawk's radio failsafe must stop it.
        link.set_mode("MANUAL")
        end = time.time() + 1.5
        while time.time() < end:
            drive.input(0, 1.0)
            time.sleep(0.05)
        drive.stop()
        t_dead = time.time()
        wait_for(lambda: sim.mode == mav_link.ROVER_MODES["HOLD"], 6, "Pixhawk radio failsafe")
        check(sim.rc_failsafe, f"Pi dead → the Pixhawk's radio failsafe holds the boat after {time.time() - t_dead:.1f} s")

        check(link.get_param("FS_ACTION") == 2.0, "reads Pixhawk parameters (FS_ACTION = 2)")
        check(link.set_param("FS_ACTION", 1) == 1.0 and link.get_param("FS_ACTION") == 1.0, "sets a parameter and confirms it")
        link.set_param("FS_ACTION", 2)
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
    env = dict(os.environ, BOAT_RC_SOURCE="gamepad", BOAT_SIM_TCP_PORT="5843", PYTHONUNBUFFERED="1",
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
        check(not fs["ok"] and len(fs["problems"]) == 2, f"failsafe check flags FS_THR_ENABLE=0 and FS_ACTION=0: {fs['problems']}")
        r = c.post("/api/pixhawk/failsafe/fix").json()
        check(r["success"] and r["report"]["ok"], f"failsafe fix: {r['message']}")
        fs = c.get("/api/pixhawk/failsafe").json()
        check(fs["ok"] and fs["action"] == "hold (stop)", f"failsafe now: {fs['values']}")
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
    finally:
        proc.terminate()
        proc.wait(10)


if __name__ == "__main__":
    part1()
    part2()
    print("\nGAME CONTROLLER TESTS PASSED")
