"""
Live collect, end to end: the real backend (python main.py --sim) driving the
simulated Pixhawk, with plastic positions sent the way the VARUNA app sends
the drone's finds.

Part 0 — the intake roller (collector.py) on a forward/reverse brushed ESC on
output 2: stopped (1500 µs) as soon as the output is set, R1 runs / stops it
(1800 / 1500 µs), and the signal on the output is checked in the simulator.

Part 1 — GPS only (no camera): the queue (added / merged / refused), nearest
item first, the intake roller, a new find while driving, waiting when the
queue is empty, an operator mode change pausing it and Start resuming it, no
planned mission at the same time, skip, disarm pauses it (and stops a roller
run by R1), and "return when empty" bringing the boat home.

Part 3 — a planned mission: the roller runs only near the item the Pixhawk is
heading to, and stops after it.

Part 2 — with the camera: the app's role is played by a thread that reads the
boat's video, asks the simulated world what the camera sees and posts it to
/api/vision/observe (plus a catch item when something rides up the ramp). The
simulated river has the plastic a metre or two from where the "drone" placed
it; the camera homing must take over, find it, drive through it, and the
catch counter must confirm each item ("camera").

Run:  python test_live_collect.py
"""

import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

import httpx

PORT = 8861
BASE = f"http://127.0.0.1:{PORT}"
HOME = (17.4239, 78.4738)


def offset(lat, lng, north_m, east_m):
    return (lat + math.degrees(north_m / 6371000.0),
            lng + math.degrees(east_m / (6371000.0 * math.cos(math.radians(lat)))))


def dist_m(a, b):
    n = math.radians(b[0] - a[0]) * 6371000.0
    e = math.radians(b[1] - a[1]) * 6371000.0 * math.cos(math.radians(a[0]))
    return math.hypot(n, e)


def check(cond, what):
    print(("  PASS  " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def wait_for(fn, timeout, what):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = exc
        time.sleep(0.2)
    check(False, f"{what} (timed out; last: {last})")


class Eyes(threading.Thread):
    """The app's role: the boat's video → what the camera sees → /api/vision/observe (+ catch items)."""

    def __init__(self):
        super().__init__(daemon=True)
        self.stop = threading.Event()
        self.ramp_seen = set()
        self.catch_posts = 0

    def run(self):
        c = httpx.Client(base_url=BASE, timeout=10)
        cfg = c.get("/api/vision/config").json()
        w, h = cfg["camera_width"], cfg["camera_height"]
        ramp_y = cfg["ramp_top"] * h
        while not self.stop.is_set():
            try:
                with httpx.stream("GET", BASE + "/video_feed", timeout=20) as r:
                    buf, last_post = b"", 0.0
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
                            if len(buf) < m.end() + ln:
                                break
                            buf = buf[m.end() + ln:]
                            ft = re.search(r"X-Frame-Time: ([\d.]+)", headers)
                            if not ft or time.time() - last_post < 0.2:
                                continue
                            last_post = time.time()
                            ft = float(ft.group(1))
                            det = c.get("/api/sim/detections", params={"frame_time": ft}).json()
                            c.post("/api/vision/observe", json={"frame_time": ft, "frame_w": w, "frame_h": h,
                                                                "targets": det["targets"], "hazards": []})
                            for item in det["ramp"]:
                                if item["id"] not in self.ramp_seen and item["y1"] > ramp_y + (h - ramp_y) * 0.4:
                                    self.ramp_seen.add(item["id"])
                                    c.post("/api/catch/item", json={"label": item["label"], "score": 0.8, "frame_time": ft})
                                    self.catch_posts += 1
            except httpx.HTTPError:
                time.sleep(0.5)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, BOAT_SIM_TCP_PORT="5861", BOAT_SIM_RATE="3", PYTHONUNBUFFERED="1",
               PYTHONIOENCODING="utf-8")
    log = open(os.path.join(tempfile.gettempdir(), "test_live_collect_backend.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--sim", "--port", str(PORT), "--host", "127.0.0.1"],
                            cwd=here, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=BASE, timeout=30)
    eyes = None
    try:
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 40, "backend + simulated Pixhawk")
        wait_for(lambda: c.get("/api/telemetry").json()["lat"] is not None, 20, "GPS position")
        live = lambda: c.get("/api/live/status").json()
        tele = lambda: c.get("/api/telemetry").json()
        boat = lambda: (lambda t: (t["lat"], t["lng"]))(tele())
        r = c.post("/api/vision/config", json={"live_dwell_s": 1.5, "collector_servo": 2,
                                               "homing_enabled": False}).json()
        check(r["success"], "live-collect settings tuned for the test (roller on output 2, no camera)")
        check(live()["state"] == "off", "live collect starts off")
        c.post("/api/live/clear")

        print("Part 0 — the intake roller")
        servo = lambda: c.get("/api/sim/servo").json()["outputs"].get("2")
        roller = lambda: tele()["collector"]
        wait_for(lambda: servo() == 1500, 5, "stop signal on output 2")
        check(not roller()["on"] and roller()["output"] == 2, "roller output set → ESC gets 1500 µs (stopped) at once")
        r = c.post("/api/collector", json={}).json()
        check(r["success"] and servo() == 1800 and roller()["on"] and roller()["by"] == "operator",
              f"R1 → roller runs (1800 µs): {r['message']}")
        r = c.post("/api/collector", json={}).json()
        check(r["success"] and servo() == 1500 and not roller()["on"], "R1 again → roller stops (1500 µs)")

        print("Part 1 — GPS only")
        A, B = offset(*HOME, 15, 0), offset(*HOME, 0, 25)
        near_a, far = offset(*HOME, 15, 1.0), offset(*HOME, 2500, 0)
        r = c.post("/api/live/targets", json={"targets": [
            {"id": "A", "lat": A[0], "lng": A[1], "source": "drone"},
            {"id": "B", "lat": B[0], "lng": B[1], "source": "drone"},
            {"id": "A2", "lat": near_a[0], "lng": near_a[1], "source": "drone"},
            {"id": "FAR", "lat": far[0], "lng": far[1], "source": "drone"},
        ]}).json()
        check(r["added"] == ["A", "B"], f"queue: A and B added ({r['message']})")
        check(r["merged"] == [{"id": "A2", "into": "A"}], "a find 1 m from A is merged into A")
        check([x["id"] for x in r["rejected"]] == ["FAR"] and "limit" in r["rejected"][0]["reason"],
              f"a find 2.5 km away is refused: {r['rejected'][0]['reason']}")

        r = c.post("/api/live/start", json={"when_empty": "wait"}).json()
        check(r["success"], f"start: {r['message']}")
        t = tele()
        check(t["armed"] and t["flight_mode"] == "GUIDED", "armed and in GUIDED")
        check(not c.post("/api/mission/start").json()["success"], "a planned mission is refused while live collect runs")
        wait_for(lambda: (live()["current"] or {}).get("id") == "A", 5, "heading to A first")
        check(True, "nearest first: A (15 m) before B (25 m)")

        roller_seen = wait_for(lambda: live()["roller"], 30, "roller on near A")
        check(roller_seen and dist_m(boat(), A) <= 5.5 and servo() == 1800,
              f"reaching A: the roller runs by itself (1800 µs, {dist_m(boat(), A):.1f} m from A)")
        wait_for(lambda: next(x for x in live()["targets"] if x["id"] == "A")["status"] == "collected", 30, "A collected")
        st = live()
        check("A" in st["collected"] and "A2" in st["collected"], "A collected — and A2 (merged into it) reported collected too")

        # A new find while the boat heads for B.
        wait_for(lambda: (live()["current"] or {}).get("id") == "B", 10, "heading to B")
        E = offset(*boat(), 6, 0)
        r = c.post("/api/live/targets", json={"targets": [{"id": "E", "lat": E[0], "lng": E[1], "source": "drone"}]}).json()
        check(r["added"] == ["E"], "a new find while driving is added")
        wait_for(lambda: all(x["status"] == "collected" for x in live()["targets"] if x["id"] in ("B", "E")), 60,
                 "B and E collected")
        check(True, "B and the new find E both collected")
        st = wait_for(lambda: (lambda s: s if s["phase"] == "waiting" else None)(live()), 10, "waiting when empty")
        check(not st["roller"] and st["state"] == "running" and servo() == 1500,
              "queue empty → waiting for more, roller stopped (1500 µs)")
        time.sleep(1.5)
        check(tele()["groundspeed"] < 0.1, "…and the boat has stopped where it is")

        # Operator takes over: a mode change pauses live collect.
        c.post("/api/mavlink/mode", json={"mode": "MANUAL"})
        st = wait_for(lambda: (lambda s: s if s["state"] == "paused" else None)(live()), 5, "paused by the operator")
        check("MANUAL" in (st["reason"] or ""), f"operator mode change → paused ({st['reason']})")
        F = offset(*boat(), -10, 5)
        c.post("/api/live/targets", json={"targets": [{"id": "F", "lat": F[0], "lng": F[1]}]})
        time.sleep(2)
        check(next(x for x in live()["targets"] if x["id"] == "F")["status"] == "pending" and tele()["flight_mode"] == "MANUAL",
              "while paused nothing is commanded (F waits, still MANUAL)")
        r = c.post("/api/live/start", json={}).json()
        check(r["success"] and "resumed" in r["message"], f"Start resumes: {r['message']}")
        wait_for(lambda: next(x for x in live()["targets"] if x["id"] == "F")["status"] == "collected", 40, "F collected")
        check(True, "F collected after resuming")

        # Skip.
        G = offset(*boat(), 30, -10)
        c.post("/api/live/targets", json={"targets": [{"id": "G", "lat": G[0], "lng": G[1]}]})
        wait_for(lambda: (live()["current"] or {}).get("id") == "G", 10, "heading to G")
        r = c.post("/api/live/skip", json={"id": "G"}).json()
        g = next(x for x in live()["targets"] if x["id"] == "G")
        check(r["success"] and g["status"] == "missed" and g["how"] == "skipped", "skip → G marked skipped")

        # Disarm pauses it — and stops a roller the operator ran with R1.
        c.post("/api/collector", json={"on": True})
        check(servo() == 1800, "R1 runs the roller while live collect waits")
        c.post("/api/mavlink/arm", json={"arm": False})
        wait_for(lambda: live()["state"] == "paused", 5, "paused on disarm")
        wait_for(lambda: servo() == 1500 and not roller()["on"], 3, "roller stopped on disarm")
        check(roller()["by"] == "safety", "disarm → live collect paused, roller stopped (safety)")

        # Return when empty: nothing new for live_return_after_s → home.
        c.post("/api/vision/config", json={"live_return_after_s": 5})
        r = c.post("/api/live/start", json={"when_empty": "return"}).json()
        check(r["success"] and tele()["armed"], "start again (arms the boat itself), return when empty")
        wait_for(lambda: live()["state"] == "returning", 20, "returning home")
        check(tele()["flight_mode"] == "RTL", "nothing new for 5 s → RTL")
        st = wait_for(lambda: (lambda s: s if s["state"] == "off" else None)(live()), 90, "back home")
        check(st["reason"] == "back home" and dist_m(boat(), HOME) < 3, f"back home → live collect off ({dist_m(boat(), HOME):.1f} m from home)")

        print("Part 2 — with the camera (homing + catch counter)")
        c.post("/api/live/clear")
        c.post("/api/vision/config", json={"homing_enabled": True, "live_return_after_s": 30})
        eyes = Eyes()
        eyes.start()
        wait_for(lambda: tele()["vision"]["link"]["alive"], 15, "camera link alive")
        H, I = offset(*boat(), 18, 6), offset(*boat(), 30, -8)
        r = c.post("/api/live/targets", json={"targets": [{"id": "H", "lat": H[0], "lng": H[1], "source": "drone"},
                                                           {"id": "I", "lat": I[0], "lng": I[1], "source": "drone"}]}).json()
        check(r["added"] == ["H", "I"], "two finds, placed in the simulated river a metre or two off")
        r = c.post("/api/live/start", json={"when_empty": "wait"}).json()
        check(r["success"], "start with the camera running")
        st = wait_for(lambda: (lambda s: s if s["phase"] == "camera" else None)(live()), 60, "camera homing takes over")
        check(True, "near the item, the camera homing takes over")
        check(st["roller"], "…with the intake roller already on")
        wait_for(lambda: all(x["status"] != "pending" and x["status"] != "active"
                             for x in live()["targets"] if x["id"] in ("H", "I")), 150, "H and I done")
        ts = {x["id"]: x for x in live()["targets"]}
        check(ts["H"]["status"] == "collected" and ts["H"]["how"] == "camera",
              f"H collected, confirmed by the catch counter ({ts['H']['status']}/{ts['H']['how']})")
        check(ts["I"]["status"] == "collected" and ts["I"]["how"] == "camera",
              f"I collected, confirmed by the catch counter ({ts['I']['status']}/{ts['I']['how']})")
        check(eyes.catch_posts >= 2, f"{eyes.catch_posts} items rode up the ramp")
        st = wait_for(lambda: (lambda s: s if s["phase"] == "waiting" else None)(live()), 15, "waiting again")
        check(st["state"] == "running" and not st["roller"], "waiting for more, roller off")
        r = c.post("/api/live/stop", json={"rtl": False}).json()
        check(r["success"] and live()["state"] == "off" and tele()["flight_mode"] == "HOLD", "stop → off, boat holding")
        eyes.stop.set()

        print("Part 3 — a planned mission: the roller near the item only")
        c.post("/api/vision/config", json={"homing_enabled": False})
        J = offset(*boat(), 20, 0)
        r = c.post("/api/mission/upload", json={"name": "roller test", "waypoints": [{"id": "J", "lat": J[0], "lng": J[1]}],
                                                "hold_s": 2, "speed_mps": 0.8}).json()
        check(r["success"], "one-item mission uploaded")
        check(c.post("/api/mission/start").json()["success"], "mission started")
        time.sleep(2)
        check(servo() == 1500 and dist_m(boat(), J) > 10, "far from the item: roller stopped")
        wait_for(lambda: roller()["on"], 40, "roller on near the item")
        check(servo() == 1800 and dist_m(boat(), J) <= 5.5 and roller()["by"] == "auto",
              f"reaching the item: roller runs by itself ({dist_m(boat(), J):.1f} m)")
        wait_for(lambda: not roller()["on"], 60, "roller off after the item")
        check(servo() == 1500, "after the item (heading home): roller stopped")
        c.post("/api/mavlink/stop")
        print("\nLIVE COLLECT TESTS PASSED")
    finally:
        if eyes:
            eyes.stop.set()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    main()
