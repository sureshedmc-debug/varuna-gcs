"""
End-to-end test: starts the boat backend with the simulated Pixhawk, then drives
a full plastic-collection mission through the HTTP API exactly as the VARUNA app
does. Run:  python test_e2e.py      (exit code 0 = everything passed)
"""

import asyncio
import json
import math
import os
import subprocess
import sys
import time

import httpx
import websockets

PORT = 8011
BASE = f"http://127.0.0.1:{PORT}"
HOME = (17.4239, 78.4738)


def offset(lat, lng, north_m, east_m):
    return (lat + math.degrees(north_m / 6371000.0),
            lng + math.degrees(east_m / (6371000.0 * math.cos(math.radians(lat)))))


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what)
    if not cond:
        raise SystemExit(1)


def wait_for(fn, timeout, what):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.25)
    check(False, f"{what} (timed out)")


def main():
    env = dict(os.environ, BOAT_SIM_RATE="8", BOAT_SIM_TCP_PORT="5771",
               PYTHONUNBUFFERED="1")
    data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    for f in ("current_mission.json", "missions.json"):
        try:
            os.remove(os.path.join(data_dir, f))
        except OSError:
            pass
    # The server log goes to a file: an unread pipe fills up and blocks the server.
    log_path = os.path.join(data_dir, "test_e2e.log")
    os.makedirs(data_dir, exist_ok=True)
    log_file = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--sim", "--port", str(PORT), "--host", "127.0.0.1"],
                            cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
                            stdout=log_file, stderr=subprocess.STDOUT, text=True)
    try:
        c = httpx.Client(base_url=BASE, timeout=40)

        def up():
            try:
                return c.get("/api/ping").json().get("status") == "ok"
            except httpx.HTTPError:
                return False

        wait_for(up, 20, "backend answers /api/ping")
        check(True, "backend answers /api/ping")
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 15, "Pixhawk heartbeat")
        check(True, "simulated Pixhawk connected")
        t = wait_for(lambda: (lambda d: d if d["lat"] and d["home"] else None)(c.get("/api/telemetry").json()), 15, "GPS + home")
        check(abs(t["lat"] - HOME[0]) < 1e-4, f"telemetry position {t['lat']:.6f}, {t['lng']:.6f}")
        check(t["flight_mode"] == "HOLD" and t["armed"] is False, "boat starts disarmed in HOLD")

        # ---- validation
        r = c.post("/api/mission/upload", json={"name": "x", "waypoints": []}).json()
        check(r["success"] is False and "at least one" in r["message"], f"empty mission rejected: {r['message']}")
        far = offset(*HOME, 5000, 0)
        r = c.post("/api/mission/upload", json={"name": "x", "waypoints": [{"lat": far[0], "lng": far[1]}]}).json()
        check(r["success"] is False and "safety limit" in r["message"], f"far target rejected: {r['message']}")
        r = c.post("/api/mission/start").json()
        check(r["success"] is False, f"start without a mission rejected: {r['message']}")
        r = c.post("/api/mavlink/mode", json={"mode": "FLY"}).json()
        check(r["success"] is False, f"unknown mode rejected: {r['message']}")

        # ---- arm / disarm / mode
        r = c.post("/api/mavlink/arm", json={"arm": True}).json()
        check(r["success"] and c.get("/api/telemetry").json()["armed"], f"arm: {r['message']}")
        r = c.post("/api/mavlink/arm", json={"arm": False}).json()
        check(r["success"] and not c.get("/api/telemetry").json()["armed"], f"disarm: {r['message']}")
        r = c.post("/api/mavlink/mode", json={"mode": "MANUAL"}).json()
        check(r["success"] and c.get("/api/telemetry").json()["flight_mode"] == "MANUAL", f"mode MANUAL: {r['message']}")

        # ---- upload a 3-item collection
        pts = [offset(*HOME, 12, 4), offset(*HOME, 20, -8), offset(*HOME, 6, -14)]
        wps = [{"id": f"s{i}", "lat": p[0], "lng": p[1]} for i, p in enumerate(pts, 1)]
        r = c.post("/api/mission/upload", json={"name": "Test collection", "waypoints": wps, "hold_s": 4, "speed_mps": 1.5}).json()
        check(r["success"], f"upload: {r['message']}")
        check(r["mission"]["state"] == "uploaded" and r["mission"]["total"] == 3, "mission recorded as uploaded with 3 items")

        # ---- start and watch it collect
        r = c.post("/api/mission/start").json()
        check(r["success"], f"start: {r['message']}")
        t = c.get("/api/telemetry").json()
        check(t["armed"] and t["flight_mode"] == "AUTO", "boat armed and in AUTO")

        seen_running = wait_for(lambda: c.get("/api/mission/status").json()["state"] == "running", 5, "state running")
        check(bool(seen_running), "mission state: running")
        # The speed item comes before the first waypoint; starting must not skip it.
        fast = wait_for(lambda: c.get("/api/telemetry").json()["groundspeed"] > 1.3, 15, "cruise at 1.5 m/s")
        check(bool(fast), "boat cruises at the mission speed (1.5 m/s) — the speed item ran")

        # pause + resume in the middle
        wait_for(lambda: c.get("/api/mission/status").json()["reached_count"] >= 1, 40, "first item reached")
        r = c.post("/api/mission/upload", json={"name": "y", "waypoints": wps}).json()
        check(r["success"] is False and "still running" in r["message"], f"upload while the mission runs rejected: {r['message']}")
        r = c.post("/api/mission/pause").json()
        check(r["success"] and c.get("/api/telemetry").json()["flight_mode"] == "HOLD", f"pause: {r['message']}")
        check(c.get("/api/mission/status").json()["state"] == "paused", "mission state: paused")
        r = c.post("/api/mission/start").json()
        check(r["success"] and "resumed" in r["message"].lower(), f"resume: {r['message']}")

        st = wait_for(lambda: (lambda s: s if s["state"] == "completed" else None)(c.get("/api/mission/status").json()), 90, "mission completed")
        check(st["reached"] == ["s1", "s2", "s3"], f"all items reached in order: {st['reached']}")
        t = c.get("/api/telemetry").json()
        home_d = math.hypot((t["lat"] - HOME[0]) * 111320, (t["lng"] - HOME[1]) * 111320 * math.cos(math.radians(HOME[0])))
        check(home_d < 3, f"boat returned home ({home_d:.1f} m away) in {t['flight_mode']}")
        check(any("Mission Complete" in m["text"] for m in t["messages"]), "Pixhawk reported 'Mission Complete'")

        # ---- RTL + emergency stop
        r = c.post("/api/mavlink/rtl").json()
        check(r["success"], f"rtl: {r['message']}")
        r = c.post("/api/mavlink/stop").json()
        t = c.get("/api/telemetry").json()
        check(r["success"] and not t["armed"] and t["flight_mode"] == "HOLD", f"emergency stop: {r['message']}")

        # ---- history, list, clear, websocket
        lst = c.get("/api/mission/list").json()
        check(len(lst) == 1 and lst[0]["waypoint_count"] == 3, "mission history lists the upload")
        check(len(c.get("/api/telemetry/history?limit=50").json()) > 5, "position trail recorded")
        r = c.post("/api/mission/clear").json()
        check(r["success"] and c.get("/api/mission/status").json()["state"] == "none", f"clear: {r['message']}")

        async def ws_test():
            async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/ws") as ws:
                first = json.loads(await asyncio.wait_for(ws.recv(), 5))
                second = json.loads(await asyncio.wait_for(ws.recv(), 5))
                return first, second
        a, b = asyncio.run(ws_test())
        check(a["vehicle"] == "boat" and b["t"] >= a["t"], "WebSocket pushes live boat telemetry")
        pi = c.get("/api/system/pi").json()
        check("ram_percent" in pi and "cpu_per_core" in pi, "system metrics endpoint")
        print("\nALL BOAT BACKEND TESTS PASSED")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        log_file.close()
        with open(log_path, encoding="utf-8", errors="replace") as f:
            out = f.read()
        errors = [l for l in out.splitlines() if "Traceback" in l or " ERROR " in l]
        if errors:
            print("\nBackend log errors:\n" + "\n".join(errors))
            print(out[-4000:])


if __name__ == "__main__":
    main()
