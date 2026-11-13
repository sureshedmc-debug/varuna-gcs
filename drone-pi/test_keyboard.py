"""
Keyboard flight (Control tab) against the REAL ArduCopter firmware in SITL.

Start SITL first (Windows build from firmware.ardupilot.org/Tools/MissionPlanner/sitl):
    ArduCopter.elf -M quad -O 17.4239,78.4738,10,0 -s 1 --defaults copter.parm -I0
then:
    python test_keyboard.py
The test holds SITL's first port (tcp:5760, SITL quits when that closes) and
runs the drone backend on its second port (tcp:5762), so it can kill the
backend — like a crashed Pi — and still see what the Pixhawk does.
Exit code 0 = everything passed. Needs: pip install httpx websockets
"""

import asyncio
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import websockets
from pymavlink import mavutil

PORT = 8042
BASE = f"http://127.0.0.1:{PORT}"
HERE = os.path.dirname(os.path.abspath(__file__))
W = {"mode": None, "armed": None, "alt": 0.0, "speed": 0.0, "hdg": 0.0}


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def wait_for(fn, timeout, what, every=0.2):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(every)
    check(False, f"{what} (timed out)")


def watcher(m, modes):
    while True:
        msg = m.recv_match(blocking=True, timeout=0.5)
        if not msg or msg.get_srcSystem() != 1 or msg.get_srcComponent() != 1:
            continue
        t = msg.get_type()
        if t == "HEARTBEAT":
            W["mode"] = modes.get(msg.custom_mode, msg.custom_mode)
            W["armed"] = bool(msg.base_mode & 128)
        elif t == "GLOBAL_POSITION_INT":
            W["alt"] = msg.relative_alt / 1000.0
            W["speed"] = math.hypot(msg.vx, msg.vy) / 100.0
            W["hdg"] = msg.hdg / 100.0


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    m = mavutil.mavlink_connection("tcp:127.0.0.1:5760", source_system=251)
    m.wait_heartbeat(timeout=30)
    m.mav.request_data_stream_send(1, 1, 0, 5, 1)
    threading.Thread(target=watcher, args=(m, {v: k for k, v in m.mode_mapping().items()}), daemon=True).start()

    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", DRONE_CAMERA_SOURCE="off",
               DRONE_KB_LOST_S="6", DRONE_KB_LOST_ACTION="rtl")
    log = open(os.path.join(tempfile.gettempdir(), "test_keyboard_backend.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--connection", "tcp:127.0.0.1:5762", "--port", str(PORT)],
                            cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=BASE, timeout=30)

    async def keys(secs, **k):
        """Hold keys for `secs` over /api/control (20 packets a second), then let go."""
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/control") as ws:
            end = time.time() + secs
            while time.time() < end:
                await ws.send(json.dumps({"x": 0, "y": 0, "z": 0, "r": 0, **k}))
                await asyncio.sleep(0.05)
            return c.get("/api/telemetry").json()

    try:
        wait_for(lambda: c.get("/api/health").json().get("pixhawk_connected"), 60, "backend sees the Pixhawk")
        wait_for(lambda: c.get("/api/telemetry").json()["gps_fix"] >= 3, 120, "GPS fix")
        safety = c.get("/api/pixhawk/safety").json()
        check("values" in safety and "FS_GCS_ENABLE" in safety["values"], f"safety check reads the Pixhawk: {safety['values']}")

        r = c.post("/api/control/take").json()
        check(not r["success"] and "Take off first" in r["message"], f"on the ground: keyboard flight refused ({r['message']})")

        for _ in range(20):                       # the EKF needs a little while after the GPS fix
            r = c.post("/api/mavlink/takeoff", json={"altitude": 10}).json()
            if r["success"]:
                break
            time.sleep(4)
        check(r["success"], f"take-off: {r['message']}")
        wait_for(lambda: W["alt"] > 9.0, 60, "at 10 m")
        time.sleep(2)

        r = c.post("/api/control/take").json()
        check(r["success"] and W["mode"] == "GUIDED", f"keyboard flight on: {r['message']}")
        t = c.get("/api/telemetry").json()
        check(t["keyboard"]["active"], "telemetry shows keyboard flight active")

        hdg0 = W["hdg"]
        t = asyncio.run(keys(5, x=1))
        check(abs(W["speed"] - 2.0) < 0.4, f"W held 5 s → {W['speed']:.2f} m/s (limit 2.0)")
        sent = t["keyboard"]["sent"]
        course = math.degrees(math.atan2(sent["ve"], sent["vn"])) % 360
        check(abs((course - hdg0 + 180) % 360 - 180) < 10, f"…along the heading ({course:.0f}° vs nose {hdg0:.0f}°)")

        asyncio.run(keys(4))
        check(W["speed"] < 0.4 and W["mode"] == "GUIDED", f"keys released → hover ({W['speed']:.2f} m/s)")

        h = W["hdg"]
        asyncio.run(keys(2, r=1))
        time.sleep(1)
        turned = (W["hdg"] - h + 540) % 360 - 180
        check(turned > 40, f"→ held 2 s → turned right {turned:.0f}° (45°/s)")

        nose = W["hdg"]
        t = asyncio.run(keys(3, x=1))
        sent = t["keyboard"]["sent"]
        course = math.degrees(math.atan2(sent["ve"], sent["vn"])) % 360
        check(abs((course - nose + 180) % 360 - 180) < 10, f"after the turn, W flies where the nose points ({course:.0f}° vs {nose:.0f}°)")
        asyncio.run(keys(3))

        a = W["alt"]
        asyncio.run(keys(3, z=1))
        time.sleep(1)
        check(W["alt"] - a > 1.2, f"↑ held 3 s → climbed {W['alt'] - a:.1f} m (0.8 m/s)")

        r = c.post("/api/config", json={"kb_min_alt_m": W["alt"] - 1.5}).json()
        floor = W["alt"] - 1.5
        t = asyncio.run(keys(9, z=-1))
        time.sleep(1)
        check(abs(W["alt"] - floor) < 0.35, f"↓ held 9 s stops at the lowest keyboard height ({W['alt']:.1f} m, floor {floor:.1f} m)")
        check("lowest keyboard height" in (t["keyboard"]["limit"] or ""), f"…and says why: {t['keyboard']['limit']}")
        c.post("/api/config", json={"kb_min_alt_m": 3})

        async def close_mid_move():
            async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/control") as ws:
                for _ in range(80):
                    await ws.send(json.dumps({"x": 1, "y": 0, "z": 0, "r": 0}))
                    await asyncio.sleep(0.05)
                fast = W["speed"]
            await asyncio.sleep(2.5)
            return fast
        fast = asyncio.run(close_mid_move())
        check(fast > 1.5 and W["speed"] < 0.5, f"socket closed while flying at {fast:.1f} m/s → hover ({W['speed']:.2f} m/s 2.5 s later)")

        # Nothing from the app for kb_lost_s (6 s here) → RTL.
        wait_for(lambda: W["mode"] == "RTL", 12, "RTL after the app went quiet")
        ev = c.get("/api/telemetry").json()["keyboard"]["events"]
        check(any("No keys from the app" in e["text"] for e in ev), "app quiet while flying by keyboard → RTL")

        # A mode button ends keyboard flight at once.
        c.post("/api/mavlink/mode", json={"mode": "LOITER"})
        wait_for(lambda: W["mode"] == "LOITER", 6, "LOITER")
        r = c.post("/api/control/take").json()
        check(r["success"] and W["mode"] == "GUIDED", "keyboard flight taken again")
        c.post("/api/mavlink/mode", json={"mode": "LOITER"})
        time.sleep(1.5)
        t = c.get("/api/telemetry").json()
        check(not t["keyboard"]["active"] and W["mode"] == "LOITER", "a mode button (LOITER) ends keyboard flight")

        # The Pi dies while flying forward by keyboard.
        c.post("/api/control/take")

        async def fly_then_die():
            async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/control") as ws:
                for _ in range(80):
                    await ws.send(json.dumps({"x": 1, "y": 0, "z": 0, "r": 0}))
                    await asyncio.sleep(0.05)
                fast = W["speed"]
                proc.kill()
                return fast, time.time()
        fast, t_dead = asyncio.run(fly_then_die())
        wait_for(lambda: W["speed"] < 0.5, 8, "the Pixhawk stops by itself")
        check(True, f"Pi died while flying at {fast:.1f} m/s → the Pixhawk stopped by itself after "
                    f"{time.time() - t_dead:.1f} s (mode {W['mode']}, still in the air at {W['alt']:.1f} m)")
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(10)
    print("\nKEYBOARD FLIGHT TESTS PASSED")


if __name__ == "__main__":
    main()
