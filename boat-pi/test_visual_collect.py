"""
Drone-to-boat visual collection, end to end in the simulator: the real
backend (python main.py --sim) with the simulated Pixhawk, river and camera.

The test plays the drone + app: it sends each detection record the way the
app does (id, position, object_class, confidence, timestamp and the drone's
crop of the item as reference_image), and a thread plays the app's AI on the
boat video (reads /video_feed, asks the simulated world what is in each
frame, posts it to /api/vision/observe, and a catch item when something rides
up the ramp). It then follows each target through its workflow states.

  A  happy path + decoy: drone detects -> target sent -> GPS navigation ->
     camera finds the SAME plastic (a different item lies closer to the GPS
     point and must be ignored) -> visual approach -> collection ->
     verification -> COLLECTED
  B  failed pick-up: the item slips aside once -> verification sees it still
     there -> retry -> COLLECTED with retry_count 1
  C  only a different item near the point -> NOT_FOUND (the decoy is left)
  D  slips aside every time -> RETRY_REQUIRED; /api/live/retry -> COLLECTED
  E  GPS fix lost while navigating -> HOLD; fix back -> carries on -> COLLECTED
  F  camera link lost while searching -> GPS fallback -> COLLECTED, unverified
  G  the APP does the matching (its scores come with the boxes, the Pi's own
     matcher is off): two cups, only the app's score tells them apart

Run:  python test_visual_collect.py          (needs httpx and Pillow)
      python test_visual_collect.py B D      (only those parts)
"""

import base64
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

import httpx

PORT = 8863
BASE = f"http://127.0.0.1:{PORT}"
FLOW = ["DETECTED", "SENT", "NAVIGATING", "SEARCHING", "MATCHED", "APPROACHING", "COLLECTING",
        "VERIFYING", "COLLECTED"]


def offset(lat, lng, north_m, east_m):
    return (lat + math.degrees(north_m / 6371000.0),
            lng + math.degrees(east_m / (6371000.0 * math.cos(math.radians(lat)))))


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
        time.sleep(0.25)
    check(False, f"{what} (timed out; last: {last})")


def in_order(states, wanted):
    """Every state of `wanted` appears in `states`, in that order."""
    i = 0
    for st in states:
        if i < len(wanted) and st == wanted[i]:
            i += 1
    return i == len(wanted)


class Eyes(threading.Thread):
    """The app's AI on the boat video: frames -> /api/vision/observe (+ catch items)."""

    def __init__(self):
        super().__init__(daemon=True)
        self.stop = threading.Event()
        self.ramp_seen = set()
        self.oracle = None      # sim object id -> match score: plays the app's matcher (part G)
        self.homing_id = None   # what the boat's observe reply says it is homing onto

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
                            body = {"frame_time": ft, "frame_w": w, "frame_h": h,
                                    "targets": det["targets"], "hazards": []}
                            if self.oracle is not None:
                                body["matcher"] = "app-cv"          # like the app: it does the matching
                                if self.homing_id:
                                    for b in body["targets"]:
                                        b["match"] = self.oracle.get(b["id"], 0.2)
                                    body["match_for"] = self.homing_id
                            res = c.post("/api/vision/observe", json=body).json()
                            self.homing_id = res.get("homing_id")
                            for item in det["ramp"]:
                                if item["id"] not in self.ramp_seen and item["y1"] > ramp_y + (h - ramp_y) * 0.4:
                                    self.ramp_seen.add(item["id"])
                                    c.post("/api/catch/item", json={"label": item["label"], "score": 0.8,
                                                                    "frame_time": ft})
            except httpx.HTTPError:
                time.sleep(0.5)


def main():
    parts = set(a.upper() for a in sys.argv[1:]) or set("ABCDEFG")
    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, BOAT_SIM_TCP_PORT="5863", BOAT_SIM_RATE="3", PYTHONUNBUFFERED="1",
               PYTHONIOENCODING="utf-8")
    log_path = os.path.join(tempfile.gettempdir(), "test_visual_collect_backend.log")
    log = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "main.py", "--sim", "--port", str(PORT), "--host", "127.0.0.1"],
                            cwd=here, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=BASE, timeout=30)
    eyes = None
    n = [0]
    try:
        wait_for(lambda: c.get("/api/health").json()["pixhawk_connected"], 40, "backend + simulated Pixhawk")
        wait_for(lambda: c.get("/api/telemetry").json()["lat"] is not None, 20, "GPS position")
        tele = lambda: c.get("/api/telemetry").json()
        boat = lambda: (lambda t: (t["lat"], t["lng"]))(tele())
        target = lambda tid: c.get("/api/live/target", params={"id": tid}).json()
        obj = lambda oid: next(o for o in c.get("/api/sim/objects").json()["objects"] if o["id"] == oid)
        taken = lambda oid: obj(oid)["state"] in ("ramp", "collected")      # riding up the ramp, or in the bin

        r = c.post("/api/vision/config", json={
            "collector_servo": 2, "collector_kind": "roller", "homing_enabled": True, "live_dwell_s": 1.5, "homing_search_s": 20,
            "match_threshold": 0.55, "collect_max_retries": 2, "verify_look_s": 6, "verify_view_m": 4,
            "gps_lost_hold_s": 2}).json()
        check(r["success"], "settings: camera homing on, match threshold 0.55, 2 retries, GPS hold after 2 s")
        c.post("/api/live/clear")
        r = c.post("/api/sim/world", json={"auto_place": False, "dodge_next": 0, "gps_ok": True}).json()
        check(r["success"], "simulator: items placed by the test")

        def reference(label):
            return base64.b64encode(c.get("/api/sim/reference", params={"label": label}).content).decode()

        def send(label, north, east, ref_label=None):
            """The drone detects plastic `north`/`east` m from the boat; the app sends the record."""
            n[0] += 1
            tid = f"drone-{n[0]}.{int(time.time() * 1000)}"
            lat, lng = offset(*boat(), north, east)
            rec = {"id": tid, "latitude": lat, "longitude": lng, "object_class": label, "confidence": 0.83,
                   "timestamp": time.time() * 1000 - 4000, "source": "drone", "status": "SENT",
                   "reference_image": reference(ref_label or label)}
            r = c.post("/api/live/targets", json={"targets": [rec]}).json()
            check(r["success"] and r["added"] == [tid], f"target {tid.split('.')[0]} ({label}) sent to the boat")
            return tid, (lat, lng)

        def place(point, label, north=0.0, east=0.0, dodge=0):
            lat, lng = offset(*point, north, east)
            return c.post("/api/sim/place", json={"lat": lat, "lng": lng, "label": label, "dodge": dodge}).json()["object"]

        def until(tid, states, timeout=120):
            return wait_for(lambda: (lambda t: t if t["state"] in states else None)(target(tid)), timeout,
                            f"{tid.split('.')[0]} reaches {'/'.join(states)}")

        eyes = Eyes()
        eyes.start()
        r = c.post("/api/live/start", json={"when_empty": "wait"}).json()
        check(r["success"], "live collect started")

        # ---------------------------------------------------------------- A
        if "A" in parts:
          print("A - happy path, with a decoy closer to the GPS point")
          tid, pt = send("plastic cup", 22, 0)
          t = target(tid)
          check(t["state"] in ("SENT", "NAVIGATING") and t["has_reference"] and t["object_class"] == "plastic cup"
                and t["timestamp"] and t["retry_count"] == 0,
                "the boat keeps the record: class, confidence, timestamp, reference image, retry_count 0")
          check(c.get("/api/live/reference", params={"id": tid}).content[:2] == b"\xff\xd8",
                "the drone's reference image is stored on the boat")
          real = place(pt, "plastic cup", east=1.6)
          decoy = place(pt, "plastic bottle", east=-1.0)       # closer to the point, a different item
          until(tid, FLOW[3:] + ["NOT_FOUND", "RETRY_REQUIRED"], 60)
          check(True, "GPS navigation reached the approach radius: camera search")
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"])
          states = [h["state"] for h in t["history"]]
          print("        history:", " -> ".join(states))
          check(t["state"] == "COLLECTED" and in_order(states, FLOW), "every workflow state, in order, ends COLLECTED")
          check(t["match_score"] is not None and t["match_score"] >= 0.55,
                f"matched the drone's item (score {t['match_score']})")
          check(t["verified"] is True, "verified: counted on the ramp")
          check(taken(real["id"]), "the real cup is in the bin")
          check(obj(decoy["id"])["state"] == "floating", "the decoy bottle was left on the water")

        # ---------------------------------------------------------------- B
        if "B" in parts:
          print("B - failed pick-up, retried")
          tid, pt = send("plastic container", 0, 16)
          item = place(pt, "plastic container", north=1.2, dodge=1)
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 150)
          states = [h["state"] for h in t["history"]]
          print("        history:", " -> ".join(states))
          check(t["state"] == "COLLECTED" and t["retry_count"] == 1, "COLLECTED on the second try (retry_count 1)")
          check(in_order(states, ["COLLECTING", "VERIFYING", "SEARCHING", "MATCHED", "COLLECTING", "COLLECTED"]),
                "verification saw it still there and sent the boat back")
          check(taken(item["id"]), "the container is in the bin")

        # ---------------------------------------------------------------- C
        if "C" in parts:
          print("C - only a different item near the point")
          tid, pt = send("plastic cup", -16, 0)
          decoy = place(pt, "plastic container", east=1.2)
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 120)
          print("        history:", " -> ".join(h["state"] for h in t["history"]), "|", t["history"][-1].get("note"))
          check(t["state"] == "NOT_FOUND" and t["status"] == "missed", "NOT_FOUND (the app sees it as missed)")
          check("MATCHED" not in [h["state"] for h in t["history"]],
                "the other item was never taken for the drone's (the sweep may still sweep it up: it is plastic too)")

        # ---------------------------------------------------------------- D
        if "D" in parts:
          print("D - slips aside every time")
          c.post("/api/vision/config", json={"collect_max_retries": 1})
          tid, pt = send("plastic bag", 0, -16)
          item = place(pt, "plastic bag", north=1.0, dodge=2)
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 150)
          print("        history:", " -> ".join(h["state"] for h in t["history"]))
          check(t["state"] == "RETRY_REQUIRED" and t["retry_count"] == 2,
                "RETRY_REQUIRED after the allowed retry failed too")
          r = c.post("/api/live/retry", json={"id": tid}).json()
          check(r["success"] and target(tid)["state"] in ("SENT", "NAVIGATING"), "operator retry: back in the queue")
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 150)
          check(t["state"] == "COLLECTED" and taken(item["id"]), "collected on the operator's retry")
          c.post("/api/vision/config", json={"collect_max_retries": 2})

        # ---------------------------------------------------------------- E
        if "E" in parts:
          print("E - GPS fix lost on the way")
          tid, pt = send("plastic bottle", 25, 0)
          item = place(pt, "plastic bottle", east=1.0)
          until(tid, ["NAVIGATING"], 20)
          time.sleep(1.5)
          c.post("/api/sim/world", json={"gps_ok": False})
          wait_for(lambda: tele()["flight_mode"] == "HOLD", 15, "HOLD while the GPS has no fix")
          check(c.get("/api/live/status").json()["phase"] == "gps_lost", "live collect waits for the GPS")
          c.post("/api/sim/world", json={"gps_ok": True})
          wait_for(lambda: tele()["flight_mode"] == "GUIDED", 15, "GUIDED again once the fix is back")
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 120)
          notes = [h.get("note") or "" for h in t["history"]]
          check(t["state"] == "COLLECTED" and any("GPS lost" in x for x in notes) and any("GPS back" in x for x in notes),
                "carried on and COLLECTED (GPS loss and recovery are in the history)")

        # ---------------------------------------------------------------- F
        if "F" in parts:
          print("F - camera link lost while searching")
          tid, pt = send("plastic cup", -22, 0)
          until(tid, ["SEARCHING"], 60)                         # nothing on the water yet: it keeps searching
          eyes.stop.set()
          place(pt, "plastic cup", east=0.0)
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 90)
          notes = [h.get("note") or "" for h in t["history"]]
          check(t["state"] == "COLLECTED" and t["how"] == "gps" and t["verified"] is False
                and any("camera link" in x for x in notes),
                "fell back to GPS: driven through, COLLECTED but marked unverified")

        # ---------------------------------------------------------------- G
        if "G" in parts:
          print("G - the app matches (the Pi's own matcher off)")
          if eyes.stop.is_set():
              eyes = Eyes()
              eyes.start()
          c.post("/api/vision/config", json={"match_method": "none"})
          tid, pt = send("plastic cup", 22, 0)
          real = place(pt, "plastic cup", east=1.6)
          twin = place(pt, "plastic cup", east=-1.0)          # the same kind, closer to the point
          eyes.oracle = {real["id"]: 0.91, twin["id"]: 0.31}
          t = until(tid, ["COLLECTED", "NOT_FOUND", "RETRY_REQUIRED"], 120)
          match_note = next((h.get("note") or "" for h in t["history"] if h["state"] == "MATCHED"), "")
          print("        matched:", match_note)
          check(t["state"] == "COLLECTED" and t["match_score"] == 0.91 and "app-cv" in match_note,
                "the boat went by the app's match score (0.91)")
          check(taken(real["id"]) and obj(twin["id"])["state"] == "floating",
                "it collected the cup the app matched, not the closer twin")
          eyes.oracle = None
          c.post("/api/vision/config", json={"match_method": "colour"})

        st = c.get("/api/live/status").json()
        print("        states:", st["states"])
        if parts == set("ABCDEFG"):
            check(st["states"].get("COLLECTED") == 6 and st["states"].get("NOT_FOUND") == 1, "summary counts by state")
        c.post("/api/live/stop", json={"rtl": False})
        print("\nALL PASSED")
    finally:
        if eyes:
            eyes.stop.set()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print(f"(backend log: {log_path})")


if __name__ == "__main__":
    main()
