"""
End-to-end test of the drone backend against the REAL ArduCopter firmware,
running in ArduPilot's SITL simulator, with the test camera.

Start SITL first (Windows build from firmware.ardupilot.org/Tools/MissionPlanner/sitl):
    ArduCopter.elf --model quad --speedup 3 --defaults copter.parm -I1 --home 17.4239,78.4738,10,0 --serial0 tcp:0
then:
    python test_e2e.py [--sitl tcp:127.0.0.1:5770]
Exit code 0 = everything passed. Needs: pip install httpx websockets
"""

import argparse
import asyncio
import json
import math
import os
import subprocess
import sys
import time

import httpx
import websockets

PORT = 8041
BASE = f"http://127.0.0.1:{PORT}"
HOME = (17.4239, 78.4738)
HERE = os.path.dirname(os.path.abspath(__file__))


def offset(n, e):
    return (HOME[0] + math.degrees(n / 6371000.0),
            HOME[1] + math.degrees(e / (6371000.0 * math.cos(math.radians(HOME[0])))))


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def wait_for(fn, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    check(False, f"{what} (timed out)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sitl", default="tcp:127.0.0.1:5770")
    args = ap.parse_args()
    data_dir = os.path.join(HERE, "data")
    os.makedirs(data_dir, exist_ok=True)
    for f in ("current_mission.json", "missions.json"):
        try:
            os.remove(os.path.join(data_dir, f))
        except OSError:
            pass
    log_path = os.path.join(data_dir, "test_e2e.log")
    log_file = open(log_path, "w", encoding="utf-8")
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    proc = subprocess.Popen([sys.executable, "main.py", "--connection", args.sitl, "--camera", "test",
                             "--port", str(PORT), "--host", "127.0.0.1"],
                            cwd=HERE, env=env, stdout=log_file, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=BASE, timeout=60)
    t = lambda: c.get("/api/telemetry").json()  # noqa: E731
    try:
        def up():
            try:
                return c.get("/api/ping").json().get("vehicle") == "drone"
            except httpx.HTTPError:
                return False
        wait_for(up, 30, "backend answers /api/ping as the drone")
        check(True, "backend answers /api/ping as the drone")

        # ---------------------------------------------------------- camera
        # H.264 (the default) runs the camera at stream_fps (15); MJPEG at 30.
        st = wait_for(lambda: (lambda s: s if s["measured_fps"] >= 12 else None)(c.get("/api/camera/status").json()),
                      20, "camera streaming")
        h264 = st["codec"] == "h264"
        min_fps = 12 if h264 else 20
        check(st["resolution"] == "1280x720", f"camera at {st['resolution']}, {st['measured_fps']} fps, {st['codec']}")
        if h264:
            with httpx.stream("GET", BASE + "/api/camera/h264", timeout=10) as r:
                buf = b""
                for chunk in r.iter_bytes():
                    buf += chunk
                    if len(buf) >= 13 and len(buf) >= 13 + int.from_bytes(buf[:4], "big"):
                        break
            check(buf[4] & 1 == 1 and buf[13:17] == b"\x00\x00\x00\x01" and st["h264_codec"].startswith("avc1."),
                  f"/api/camera/h264 starts at a keyframe ({st['h264_codec']})")
        snap = c.get("/api/camera/snapshot")
        body = snap.content
        check(snap.status_code == 200 and body[:2] == b"\xff\xd8" and body[-2:] == b"\xff\xd9" and b"\xff\xc4" in body,
              f"snapshot is a complete JPEG with Huffman tables ({len(body) // 1024} KB)")
        frames, t0 = 0, time.time()
        with httpx.stream("GET", BASE + "/video_feed", timeout=10) as r:
            ctype = r.headers["content-type"]
            buf = b""
            for chunk in r.iter_bytes():
                buf += chunk
                if time.time() - t0 > 3:
                    break
            frames = buf.count(b"--frame")
        fps = frames / (time.time() - t0)
        check(ctype.startswith("multipart/x-mixed-replace") and fps >= min_fps, f"/video_feed streams MJPEG at {fps:.1f} fps")

        # ---------------------------------------------------------- health / config / misc
        h = wait_for(lambda: (lambda d: d if d["pixhawk_connected"] else None)(c.get("/api/health").json()), 60, "Pixhawk")
        check(h["camera_connected"], "health: Pixhawk and camera connected")
        d = wait_for(lambda: (lambda x: x if x["home"] and x["gps_fix"] >= 3 else None)(t()), 90, "GPS + home")
        check(d["landed_state"] == "on_ground" and not d["armed"], f"on the ground, disarmed, mode {d['flight_mode']}")
        pi = c.get("/api/system/pi?processes=true").json()
        check("ram_percent" in pi and "cpu_per_core" in pi and "processes" in pi, "system metrics")
        cfgs = c.get("/api/config").json()
        check(cfgs["stream_fps"]["value"] == 30 and cfgs["max_altitude_m"]["max"] == 120, "live-tuning schema")
        r = c.post("/api/config", json={"max_altitude_m": 999}).json()
        check(r["success"] is False and "max_altitude_m" in r["errors"], f"out-of-range tuning rejected: {r['errors']}")
        r = c.post("/api/config", json={"takeoff_alt_m": 12}).json()
        check(r["success"] and c.get("/api/config").json()["takeoff_alt_m"]["value"] == 12, "tuning applied live")
        check(c.post("/api/config/save").json()["success"], "tuning saved to disk")
        with open(os.path.join(HERE, "drone_config.json"), encoding="utf-8") as f:
            saved = json.load(f)
        check(saved.get("takeoff_alt_m") == 12 and not {"mav_connection", "camera_source", "http_port"} & set(saved),
              f"saved settings hold the tuning but not the test's command-line overrides: {sorted(saved)}")
        check(c.post("/api/auth/verify_pin", json={"password": "x"}).json()["success"], "PIN check (no PIN set)")
        check(c.get("/api/ai/detections").json() == {"detections": []}, "AI detections endpoint")
        check(c.post("/api/mavlink/mode", json={"mode": "JUMP"}).json()["success"] is False, "unknown mode rejected")
        check(c.post("/api/mavlink/takeoff", json={"altitude": 500}).json()["success"] is False, "take-off above the limit rejected")

        def start_retrying(path, body=None):
            for _ in range(24):          # the EKF may still be settling after a SITL restart
                r = c.post(path, json=body) if body is not None else c.post(path)
                r = r.json()
                msg = r["message"]
                settling = msg.startswith("Arming failed") or any(
                    k in msg for k in ("Estimate", "PreArm", "EKF", "Need ", "waiting", "GPS", "inconsistent"))
                if r["success"] or not settling:
                    return r
                time.sleep(5)
            return r

        # ---------------------------------------------------------- take-off / RTL
        r = start_retrying("/api/mavlink/takeoff", {"altitude": 12})
        check(r["success"], f"take-off: {r['message']}")
        wait_for(lambda: t()["altitude"] >= 11, 60, "climb to 12 m")
        check(True, "climbed to 12 m in GUIDED")
        r = c.post("/api/mavlink/rtl").json()
        check(r["success"] and t()["flight_mode"] == "RTL", f"RTL: {r['message']}")
        wait_for(lambda: not t()["armed"], 120, "landed and disarmed after RTL")
        check(True, "RTL brought it home, landed and disarmed")

        # ---------------------------------------------------------- mission ending with a land
        pts = [offset(50, 20), offset(80, -30)]
        wps = [{"id": 1, "lat": pts[0][0], "lng": pts[0][1], "alt": 15, "speed": 20, "action": "waypoint"},
               {"id": 2, "lat": pts[1][0], "lng": pts[1][1], "alt": 15, "speed": 20, "action": "land"}]
        r = c.post("/api/mission/upload", json={"name": "Land test", "waypoints": wps}).json()
        check(r["success"], f"upload (waypoint + land): {r['message']}")
        r = start_retrying("/api/mission/start")
        check(r["success"], f"start: {r['message']}")
        st = wait_for(lambda: (lambda m: m if m["state"] == "completed" else None)(c.get("/api/mission/status").json()),
                      240, "land mission completed")
        d = t()
        dist = math.hypot((d["lat"] - pts[1][0]) * 111320, (d["lng"] - pts[1][1]) * 111320 * math.cos(math.radians(HOME[0])))
        check(st["reached"] == ["1", "2"] and not d["armed"] and dist < 3,
              f"flew both points and landed on the land point ({dist:.1f} m off), disarmed")

        # ---------------------------------------------------------- emergency stop mid-mission
        far = [offset(150, 150), offset(250, -100)]
        wps = [{"id": i, "lat": p[0], "lng": p[1], "alt": 20, "speed": 15, "action": "waypoint"} for i, p in enumerate(far, 1)]
        check(c.post("/api/mission/upload", json={"name": "Stop test", "waypoints": wps}).json()["success"], "upload 2nd mission")
        check(start_retrying("/api/mission/start")["success"], "start 2nd mission")
        wait_for(lambda: t()["altitude"] > 10, 60, "airborne")
        r = c.post("/api/mavlink/stop").json()
        check(r["success"] and t()["flight_mode"] == "LAND", f"emergency stop: {r['message']}")
        check(c.get("/api/mission/status").json()["state"] == "landing", "mission state: landing")
        wait_for(lambda: not t()["armed"], 120, "landed after emergency stop")
        check(c.get("/api/mission/status").json()["state"] == "completed", "landed in place and disarmed")

        # ---------------------------------------------------------- link-loss failsafe
        c.post("/api/config", json={"operator_lost_action": "rtl", "operator_lost_s": 6})
        check(c.post("/api/mission/upload", json={"name": "Failsafe", "waypoints": wps}).json()["success"], "upload failsafe mission")
        check(start_retrying("/api/mission/start")["success"], "start failsafe mission")
        wait_for(lambda: t()["altitude"] > 10, 60, "airborne")
        time.sleep(14)                          # the app goes silent
        d = t()
        check(d["flight_mode"] == "RTL", f"app silent 14 s → drone switched itself to {d['flight_mode']}")
        c.post("/api/config", json={"operator_lost_action": "none"})
        wait_for(lambda: not t()["armed"], 150, "home and landed")
        check(True, "came home and landed")

        # ---------------------------------------------------------- history / websocket
        lst = c.get("/api/mission/list").json()
        check(len(lst) >= 3 and all("status" in m and "location" in m for m in lst), "mission history for the Home screen")
        check(len(c.get("/api/telemetry/history?limit=100").json()) > 10, "flight trail recorded")

        async def ws_test():
            async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/ws") as ws:
                a = json.loads(await asyncio.wait_for(ws.recv(), 5))
                b = json.loads(await asyncio.wait_for(ws.recv(), 5))
                return a, b
        a, b = asyncio.run(ws_test())
        check(a["vehicle"] == "drone" and b["t"] >= a["t"] and "camera" in a, "WebSocket pushes live drone telemetry")

        # ---------------------------------------------------------- link preference (relinks, so last)
        r = c.post("/api/mavlink/prefer", json={"mode": "telem2"}).json()
        check(r["success"] and c.get("/api/mavlink/prefer").json()["mode"] == "telem2", "link preference saved")
        c.post("/api/mavlink/prefer", json={"mode": "auto"})
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 40, "Pixhawk back after relink")
        check(True, "link reconnects after a preference change")
        print("\nALL DRONE BACKEND TESTS PASSED")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log_file.close()
        with open(log_path, encoding="utf-8", errors="replace") as f:
            out = f.read()
        errors = [line for line in out.splitlines() if "Traceback" in line or " ERROR " in line]
        if errors:
            print("\nBackend log errors:\n" + "\n".join(errors[:20]))


if __name__ == "__main__":
    main()
