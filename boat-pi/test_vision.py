"""
End-to-end test of the boat camera features with the simulator.

This script plays the VARUNA app's part: it reads the boat's MJPEG stream
(checking each frame carries its capture time), asks the simulator where the
items and ducks are in that frame (standing in for the AI), and posts the
result to /api/vision/observe a few times a second, plus a catch item whenever
something rides up the ramp. Then it checks what the BOAT decides:

  * homing takes over near each item, steers onto it and marks it collected
  * the catch counter and bin count match
  * a water measurement is taken at the first item (simulated turbidity)
  * a duck in front makes the boat HOLD, and it carries on once the duck has gone
  * when the app's vision stops, the boat slows down; when it returns, speed is restored
  * an operator HOLD stands the automation down; Resume brings it back

Run:  python test_vision.py      (needs Pillow, like the simulated camera)
"""

import math
import os
import re
import subprocess
import sys
import threading
import time

import httpx

PORT = 8013
BASE = f"http://127.0.0.1:{PORT}"
HOME = (17.4239, 78.4738)


def offset(lat, lng, north_m, east_m):
    return (lat + math.degrees(north_m / 6371000.0),
            lng + math.degrees(east_m / (6371000.0 * math.cos(math.radians(lat)))))


def dist_m(lat1, lng1, lat2, lng2):
    north = math.radians(lat2 - lat1) * 6371000.0
    east = math.radians(lng2 - lng1) * 6371000.0 * math.cos(math.radians(lat1))
    return math.hypot(north, east)


def heading_off_home(t):
    """Degrees between where the boat points and the direction home (0 = straight at it)."""
    north = math.radians(HOME[0] - t["lat"]) * 6371000.0
    east = math.radians(HOME[1] - t["lng"]) * 6371000.0 * math.cos(math.radians(t["lat"]))
    to_home = math.degrees(math.atan2(east, north)) % 360
    return abs((t["heading"] - to_home + 180) % 360 - 180)


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
        time.sleep(0.25)
    check(False, f"{what} (timed out)")


class Eyes(threading.Thread):
    """The app's role: stream → detections → /api/vision/observe (+ catch items)."""

    def __init__(self):
        super().__init__(daemon=True)
        self.running = threading.Event()
        self.running.set()
        self.stop = threading.Event()
        self.frames = 0
        self.frame_times_ok = True
        self.posted = 0
        self.ramp_seen = set()
        self.zone = None
        self.catch_posts = 0

    def run(self):
        c = httpx.Client(base_url=BASE, timeout=10)
        cfg = c.get("/api/vision/config").json()
        w, h = cfg["camera_width"], cfg["camera_height"]
        self.zone = (cfg["zone_x1"] * w, cfg["zone_x2"] * w, cfg["zone_y1"] * h, cfg["ramp_top"] * h)
        while not self.stop.is_set():
            try:
                with httpx.stream("GET", BASE + "/video_feed", timeout=20) as r:
                    buf = b""
                    last_post = 0.0
                    for chunk in r.iter_bytes():
                        if self.stop.is_set():
                            return
                        buf += chunk
                        while True:
                            m = re.search(rb"--frame\r\n(.*?)\r\n\r\n", buf, re.S)
                            if not m:
                                break
                            headers = m.group(1).decode()
                            ln = int(re.search(r"Content-Length: (\d+)", headers).group(1))
                            start = m.end()
                            if len(buf) < start + ln:
                                break
                            jpeg = buf[start:start + ln]
                            buf = buf[start + ln:]
                            ft = re.search(r"X-Frame-Time: ([\d.]+)", headers)
                            self.frames += 1
                            if not ft or jpeg[:2] != b"\xff\xd8":
                                self.frame_times_ok = False
                                continue
                            if not self.running.is_set() or time.time() - last_post < 0.2:
                                continue
                            last_post = time.time()
                            self.post(c, float(ft.group(1)), w, h)
            except httpx.HTTPError:
                time.sleep(0.5)

    def post(self, c, ft, w, h):
        det = c.get("/api/sim/detections", params={"frame_time": ft}).json()
        x1, x2, y1, y2 = self.zone
        hazards = []
        for hz in det["hazards"]:
            cx, cy = (hz["x1"] + hz["x2"]) / 2, hz["y2"]
            hazards.append({**hz, "in_zone": x1 <= cx <= x2 and y1 <= cy <= y2})
        c.post("/api/vision/observe", json={"frame_time": ft, "frame_w": w, "frame_h": h,
                                            "targets": det["targets"], "hazards": hazards})
        self.posted += 1
        for item in det["ramp"]:
            if item["id"] not in self.ramp_seen and item["y1"] > (y2 + (h - y2) * 0.4):
                self.ramp_seen.add(item["id"])   # crossed the counting line
                c.post("/api/catch/item", json={"label": item["label"], "score": 0.8, "frame_time": ft})
                self.catch_posts += 1


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(here, "data")
    os.makedirs(data_dir, exist_ok=True)
    for f in ("current_mission.json", "missions.json", "catch.jsonl", "wildlife.jsonl", "vision_state.json",
              "water_track.jsonl", "water_readings.json"):
        try:
            os.remove(os.path.join(data_dir, f))
        except OSError:
            pass
    env = dict(os.environ, BOAT_SIM_RATE="3", BOAT_SIM_TCP_PORT="5781", PYTHONUNBUFFERED="1",
               PYTHONIOENCODING="utf-8")
    log = open(os.path.join(data_dir, "test_vision.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--sim", "--port", str(PORT), "--host", "127.0.0.1"],
                            cwd=here, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=BASE, timeout=30)
    eyes = Eyes()
    try:
        wait_for(lambda: c.get("/api/ping").json()["vehicle"] == "boat", 30, "backend")
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 30, "simulated Pixhawk")
        st = wait_for(lambda: (lambda s: s if s["camera_connected"] and s["measured_fps"] >= 5 else None)(
            c.get("/api/camera/status").json()), 20, "camera")
        check(st["source"] == "sim", f"simulated camera streaming {st['resolution']} at {st['measured_fps']} fps")
        water = wait_for(lambda: (lambda s: s if s["connected"] else None)(c.get("/api/water/status").json()),
                         15, "turbidity")
        check(water["ntu"] is not None, f"turbidity sensor reading {water['ntu']} NTU ({water['quality']})")

        eyes.start()
        wait_for(lambda: eyes.posted > 5, 20, "app observations flowing")
        check(eyes.frame_times_ok, f"every MJPEG frame carries X-Frame-Time ({eyes.frames} frames)")
        check(c.get("/api/telemetry").json()["vision"]["link"]["alive"], "boat sees the app's vision link as alive")

        pts = [offset(*HOME, 16, 0), offset(*HOME, 36, 6), offset(*HOME, 56, 0)]
        wps = [{"id": f"p{i + 1}", "lat": la, "lng": lo} for i, (la, lo) in enumerate(pts)]
        r = c.post("/api/mission/upload", json={"name": "Vision test", "waypoints": wps, "hold_s": 2,
                                                "speed_mps": 1.4, "homing": True, "measure_at_first": True}).json()
        check(r["success"], f"upload with homing + water test: {r['message']}")
        r = c.post("/api/mission/start").json()
        check(r["success"], f"start: {r['message']}")

        seen_states = set()

        def homing_state():
            v = c.get("/api/telemetry").json()["vision"]
            seen_states.add(v["homing"]["state"])
            return v

        wait_for(lambda: homing_state()["homing"]["state"] in ("search", "track"), 60, "homing takes over")
        wait_for(lambda: c.get("/api/telemetry").json()["flight_mode"] == "GUIDED", 8, "GUIDED")
        check(True, "homing drives in GUIDED")
        check(c.get("/api/mission/status").json()["state"] == "running", "mission still 'running' while homing")
        first = wait_for(lambda: (lambda m: m if "p1" in m["reached"] else None)(c.get("/api/mission/status").json()),
                         90, "item 1 collected")
        check(first["how"].get("p1") == "camera", f"item 1 collected by camera homing (states seen: {sorted(seen_states)})")
        with open(os.path.join(data_dir, "test_vision.log"), encoding="utf-8", errors="replace") as f:
            tracked = "Homing: plastic in sight" in f.read()
        check(tracked, "homing saw and tracked the item (not just its GPS point)")

        reading = wait_for(lambda: (lambda r: r[0] if r else None)(c.get("/api/water/readings").json()),
                           60, "water reading at the first item")
        check(reading["samples"] >= 5 and reading["reason"] == "first collection point",
              f"water measured at the first item: {reading['ntu']} NTU, {reading['samples']} samples")
        # After homing and the water test the boat must drive on at the MISSION speed:
        # ArduRover resets the speed on every mode change (so does the simulator).
        moving = wait_for(lambda: (lambda t: t if t["flight_mode"] == "AUTO" and t["vision"]["phase"] is None
                                   and t["groundspeed"] > 1.25 else None)(c.get("/api/telemetry").json()), 20,
                          "back at mission speed after homing + water test")
        check(True, f"after homing + water test the boat drives on at the mission speed ({moving['groundspeed']:.2f} m/s)")

        # Wildlife: a duck in front of the boat.
        wait_for(lambda: c.get("/api/telemetry").json()["flight_mode"] in ("AUTO", "GUIDED"), 30, "moving again")
        c.post("/api/sim/duck", params={"ahead_m": 9})
        paused = wait_for(lambda: (lambda v: v if v["wildlife"]["state"] != "clear" else None)(
            c.get("/api/telemetry").json()["vision"]), 20, "wildlife pause")
        wait_for(lambda: c.get("/api/telemetry").json()["flight_mode"] == "HOLD", 8, "HOLD")
        check(True, f"duck ahead → boat HOLDs ({paused['wildlife']['label']})")
        check(c.get("/api/mission/status").json()["state"] == "running", "mission not marked paused during a wildlife hold")
        wait_for(lambda: c.get("/api/telemetry").json()["vision"]["wildlife"]["state"] == "clear", 60, "duck gone")
        mode = c.get("/api/telemetry").json()["flight_mode"]
        check(mode in ("AUTO", "GUIDED"), f"duck gone → boat carries on ({mode})")
        sight = c.get("/api/wildlife?limit=5").json()
        check(sight["pauses_today"] >= 1 and sight["sightings"], f"sighting logged: {sight['sightings'][0]['label']}")

        # Operator override.
        c.post("/api/mavlink/hold")
        time.sleep(1.0)
        v = c.get("/api/telemetry").json()["vision"]
        check(v["operator_paused"] and v["phase"] is None, "operator HOLD stands the automation down")
        time.sleep(2.0)
        check(c.get("/api/telemetry").json()["flight_mode"] == "HOLD", "…and it stays in HOLD (no automation commands)")
        c.post("/api/mission/start")
        wait_for(lambda: c.get("/api/telemetry").json()["flight_mode"] in ("AUTO", "GUIDED"), 15, "resumed")
        check(not c.get("/api/telemetry").json()["vision"]["operator_paused"], "Resume hands control back to the automation")

        # Wildlife while homing: after the pause, homing must carry on with the item.
        # Wait for item 3 by number: item 2 may still be ahead (or skipped by the operator HOLD).
        wait_for(lambda: (lambda hm: hm["state"] == "track" and hm["item"] == 3)(
            c.get("/api/telemetry").json()["vision"]["homing"]), 90, "homing on the last item")
        c.post("/api/sim/duck", params={"ahead_m": 3})
        wait_for(lambda: c.get("/api/telemetry").json()["vision"]["wildlife"]["state"] != "clear", 20, "wildlife pause during homing")
        wait_for(lambda: c.get("/api/telemetry").json()["flight_mode"] == "HOLD", 8, "HOLD (homing)")
        check(True, "duck while homing → boat holds")
        wait_for(lambda: c.get("/api/telemetry").json()["vision"]["wildlife"]["state"] == "clear", 60, "duck gone (homing)")
        time.sleep(1.0)
        t = c.get("/api/telemetry").json()
        check(t["flight_mode"] == "GUIDED" and t["vision"]["homing"]["state"] != "idle" or "p3" in t["mission"]["reached"],
              f"…then homing carries on with the item ({t['flight_mode']}, {t['vision']['homing']['state']})")

        # A duck on the way home, after the last item: the hold must not end the mission
        # (a finished mission disarms the boat — not on the water). Placed only once the
        # boat has turned round at the last item and points at home, with room to spare:
        # a duck dropped mid-turn ends up beside or behind it. (Speed alone is not
        # enough — the boat is back to full speed before it has finished turning.)
        wait_for(lambda: c.get("/api/mission/status").json()["state"] == "returning"
                 and (lambda t: t["flight_mode"] == "AUTO" and t["vision"]["phase"] is None
                      and t["heading"] is not None and heading_off_home(t) <= 10
                      and dist_m(t["lat"], t["lng"], *HOME) >= 20)(c.get("/api/telemetry").json()),
                 120, "driving home")
        c.post("/api/sim/duck", params={"ahead_m": 9})
        wait_for(lambda: c.get("/api/telemetry").json()["vision"]["wildlife"]["state"] != "clear", 20, "duck on the way home")
        ok_states = []
        for _ in range(8):
            t = c.get("/api/telemetry").json()
            ok_states.append(t["armed"] and t["mission"]["state"] in ("returning", "running"))
            time.sleep(0.25)
        check(all(ok_states), "wildlife hold on the way home: still armed, mission not ended early")
        wait_for(lambda: c.get("/api/telemetry").json()["vision"]["wildlife"]["state"] == "clear", 60, "duck gone (home leg)")

        # Vision link lost on the long leg home, well clear of any item: no homing take-over
        # and no waypoint stop can coincide with the slow-down. At 3x the boat covers
        # ~13 m before the 3 s vision timeout fires, then crawls; leave room for both.
        far = wait_for(lambda: (lambda t: t if t["flight_mode"] == "AUTO" and t["vision"]["phase"] is None
                                and t["mission"]["state"] == "returning"
                                and dist_m(t["lat"], t["lng"], *HOME) > 25 else None)(
            c.get("/api/telemetry").json()), 30, "an AUTO leg far from any item")
        eyes.running.clear()
        lost = wait_for(lambda: (lambda v: v if v["lost_action"] else None)(c.get("/api/telemetry").json()["vision"]),
                        15, "vision-lost reaction")
        check(lost["lost_action"] == "slow", "app vision stopped → boat slows down "
              f"(cut {dist_m(far['lat'], far['lng'], *HOME):.0f} m from home)")
        slow = wait_for(lambda: (lambda t: t if 0.2 <= t["groundspeed"] <= 0.45 else None)(
            c.get("/api/telemetry").json()), 5, "slowed down")
        speeds = []
        for _ in range(6):                   # and it stays slow (not a passing sample)
            time.sleep(0.25)
            t = c.get("/api/telemetry").json()
            speeds.append(t["groundspeed"])
        check(all(0.2 <= s <= 0.45 for s in speeds) and t["flight_mode"] == "AUTO",
              f"…to {slow['groundspeed']:.2f} m/s (still moving, {dist_m(t['lat'], t['lng'], *HOME):.0f} m from home)")
        eyes.running.set()
        wait_for(lambda: c.get("/api/telemetry").json()["vision"]["lost_action"] is None, 15, "vision back")
        fast = wait_for(lambda: (lambda t: t if t["groundspeed"] >= 1.25 else None)(
            c.get("/api/telemetry").json()), 10, "speed restored")
        check(True, f"vision back → mission speed restored ({fast['groundspeed']:.2f} m/s)")

        done =wait_for(lambda: (lambda m: m if m["state"] == "completed" else None)(c.get("/api/mission/status").json()),
                        240, "mission completed")
        catch = c.get("/api/catch?limit=10").json()
        how = done["how"]
        cam = sorted(k for k, v in how.items() if v == "camera")
        check(len(done["reached"]) == 3, f"all 3 items collected ({how})")
        check(len(cam) >= 2 and "p3" in cam, f"collected by camera homing: {cam} (p3 despite the wildlife pause)")
        # Only items the app saw ride up the ramp are counted (GPS-only items may not be).
        check(catch["bin"]["count"] == eyes.catch_posts == catch["today"]["total"] >= len(cam),
              f"catch counter: {catch['today']['total']} items {catch['today']['by_label']}, bin {catch['bin']['pct']}%")
        h = c.get("/api/vision/status").json()["homing"]
        check(h["collected"] >= 2 and h["attempts"] >= h["collected"],
              f"homing stats: {h['collected']} collected, {h['missed']} missed of {h['attempts']}")
        trk = c.get("/api/water/track?limit=5000").json()
        check(len(trk) > 10 and max(p["ntu"] for p in trk) > min(p["ntu"] for p in trk),
              f"water clarity logged along the route ({len(trk)} points)")
        r = c.post("/api/catch/empty").json()
        check(r["success"] and r["catch"]["bin"]["count"] == 0, "empty bin")
        r = c.post("/api/vision/config", json={"homing_start_m": 99}).json()
        check(not r["success"] and "homing_start_m" in r["message"], "out-of-range setting rejected")
        r = c.post("/api/vision/config", json={"on_vision_lost": "hold"}).json()
        check(r["success"] and r["config"]["on_vision_lost"] == "hold", "live setting applied")
    finally:
        eyes.stop.set()
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
    print("\nBOAT VISION TESTS PASSED")


if __name__ == "__main__":
    main()
