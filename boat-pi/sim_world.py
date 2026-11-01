"""
Simulated world for the boat camera (laptop testing with --sim).

It places a floating plastic item near every collection point of an uploaded
mission (1–2.5 m off the GPS point, like real GPS error), lets you drop a duck
in front of the boat, and renders what the boat's forward-down camera would
see: water with ripples that move as the boat moves, the items, the duck, and
the intake ramp at the bottom of the picture. When the boat drives over an
item, the item slides up the ramp across the counting line — real motion the
app's catch counter picks up.

`detections(frame_time)` returns where each item and duck is in a given
frame, so the app (in SIM mode) can stand in for the AI models, which don't
recognise drawn shapes.

Needs Pillow (laptop only — the real boat Pi never imports this module).
"""

import io
import math
import random
import threading
import time
from collections import OrderedDict, deque

from camera_model import CameraModel, dist_m, offset, to_boat, to_world

PLASTIC = [("plastic bottle", 0.28, (235, 240, 245)), ("plastic bag", 0.40, (245, 245, 240)),
           ("plastic cup", 0.12, (230, 90, 70)), ("plastic container", 0.30, (90, 160, 230)),
           ("other plastic", 0.22, (240, 200, 60))]
RAMP_RIDE_S = 1.6


class SimWorld:
    def __init__(self, boat, cfg):
        self.boat = boat                       # sim_vehicle.SimBoat
        self.cfg = cfg
        self.objects = []
        self.ducks = []
        self.lock = threading.Lock()
        self.collected = deque(maxlen=100)
        self._seq = 0

    def seed_for_mission(self, waypoints, seed=None):
        rnd = random.Random(seed)
        with self.lock:
            self.objects = []
            for w in waypoints:
                ang = rnd.uniform(0, 2 * math.pi)
                d = rnd.uniform(1.2, 2.5)
                lat, lng = offset(w["lat"], w["lng"], d * math.cos(ang), d * math.sin(ang))
                label, size, color = PLASTIC[rnd.randrange(len(PLASTIC))]
                self._seq += 1
                self.objects.append({"id": f"o{self._seq}", "lat": lat, "lng": lng, "label": label,
                                     "size": size, "color": color, "state": "floating", "ramp_t": 0.0,
                                     "rot": rnd.uniform(-0.6, 0.6)})

    def add_objects_near(self, points, seed=None):
        """Live collect: a floating item near each new plastic position the app
        sends. Like the real thing, it isn't exactly where the drone placed it."""
        rnd = random.Random(seed)
        with self.lock:
            for w in points:
                ang = rnd.uniform(0, 2 * math.pi)
                d = rnd.uniform(0.8, 2.0)
                lat, lng = offset(w["lat"], w["lng"], d * math.cos(ang), d * math.sin(ang))
                label, size, color = PLASTIC[rnd.randrange(len(PLASTIC))]
                self._seq += 1
                self.objects.append({"id": f"o{self._seq}", "lat": lat, "lng": lng, "label": label,
                                     "size": size, "color": color, "state": "floating", "ramp_t": 0.0,
                                     "rot": rnd.uniform(-0.6, 0.6)})

    def spawn_duck(self, ahead_m=5.0, right_m=-0.6):
        """A duck `ahead_m` in front of the boat, swimming across its path."""
        b = self.boat
        lat, lng = to_world(b.lat, b.lng, b.heading, ahead_m, right_m)
        with self.lock:
            self._seq += 1
            self.ducks.append({"id": f"d{self._seq}", "lat": lat, "lng": lng,
                               "heading": (b.heading + 90) % 360, "speed": 0.12,
                               "until": time.time() + 40 / b.rate})   # 40 s of sim time, like its swim speed
        return ahead_m

    def step(self, dt):
        """Move ducks, and pull items the boat drives over onto the ramp."""
        b = self.boat
        now = time.time()
        with self.lock:
            for d in self.ducks:
                d["lat"], d["lng"] = to_world(d["lat"], d["lng"], d["heading"], d["speed"] * dt * b.rate, 0)
            self.ducks = [d for d in self.ducks if now < d["until"]]
            for o in self.objects:
                if o["state"] == "floating":
                    fwd, right = to_boat(b.lat, b.lng, b.heading, o["lat"], o["lng"])
                    if -0.3 <= fwd <= 0.9 and abs(right) <= 0.45:
                        o["state"], o["ramp_t"] = "ramp", now
                elif o["state"] == "ramp" and now - o["ramp_t"] > RAMP_RIDE_S:
                    o["state"] = "collected"
                    self.collected.append({"id": o["id"], "label": o["label"], "t": now})

    # ------------------------------------------------------------------ what the camera sees
    def scene(self, pose, w, h):
        """Everything visible from `pose`, in pixels: (items, ducks, ramp_items)."""
        cam = CameraModel.from_cfg(self.cfg, w, h)
        ramp_y = self.cfg["ramp_top"] * h
        lat, lng, hdg = pose
        items, ducks, ramp = [], [], []
        now = time.time()
        with self.lock:
            objs = list(self.objects)
            dks = list(self.ducks)
        for o in objs:
            if o["state"] == "floating":
                fwd, right = to_boat(lat, lng, hdg, o["lat"], o["lng"])
                p = cam.ground_to_pixel(fwd, right) if fwd > 0.2 else None
                if not p or not (0 <= p[0] <= w and 0 <= p[1] <= ramp_y):
                    continue
                px = o["size"] / cam.ground_scale(fwd)
                bw = max(4.0, px * (1.0 if "bag" in o["label"] else 1.0))
                bh = max(3.0, px * (0.45 if "bottle" in o["label"] else 0.7))
                items.append({**o, "x": p[0], "y": p[1], "bw": bw, "bh": bh})
            elif o["state"] == "ramp":
                k = min(1.0, (now - o["ramp_t"]) / RAMP_RIDE_S)
                ramp.append({**o, "x": w / 2, "y": ramp_y + 6 + k * (h - ramp_y - 6), "bw": w * 0.09, "bh": w * 0.05})
        for d in dks:
            fwd, right = to_boat(lat, lng, hdg, d["lat"], d["lng"])
            p = cam.ground_to_pixel(fwd, right) if fwd > 0.2 else None
            if not p or not (0 <= p[0] <= w and 0 <= p[1] <= ramp_y):
                continue
            px = 0.35 / cam.ground_scale(fwd)
            ducks.append({**d, "x": p[0], "y": p[1], "bw": max(6.0, px * 1.3), "bh": max(5.0, px)})
        return items, ducks, ramp

    def detections(self, pose, w, h):
        items, ducks, ramp = self.scene(pose, w, h)
        rnd = random.Random(int(time.time() * 4))
        box = lambda o: {"x1": round(o["x"] - o["bw"] / 2, 1), "y1": round(o["y"] - o["bh"] / 2, 1),
                         "x2": round(o["x"] + o["bw"] / 2, 1), "y2": round(o["y"] + o["bh"] / 2, 1)}
        return {
            "targets": [{**box(o), "label": o["label"], "score": round(rnd.uniform(0.55, 0.9), 2), "id": o["id"]}
                        for o in items],
            "hazards": [{**box(d), "label": "bird", "score": round(rnd.uniform(0.6, 0.92), 2)} for d in ducks],
            "ramp": [{**box(o), "label": o["label"], "id": o["id"]} for o in ramp],
        }

    def render(self, pose, w, h):
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (w, h))
        dr = ImageDraw.Draw(img)
        ramp_y = int(self.cfg["ramp_top"] * h)
        for y in range(ramp_y):                       # water: darker far away, lighter near
            k = y / max(1, ramp_y)
            dr.line([(0, y), (w, y)], fill=(int(18 + 22 * k), int(52 + 40 * k), int(70 + 45 * k)))
        cam = CameraModel.from_cfg(self.cfg, w, h)
        lat, lng, hdg = pose
        # Ripples fixed to the water, every 1.5 m: they slide past as the boat moves.
        north0 = math.floor(math.radians(lat) * 6371000 / 1.5)
        east0 = math.floor(math.radians(lng) * 6371000 * math.cos(math.radians(lat)) / 1.5)
        for i in range(-12, 13):
            for j in range(-12, 13):
                n_m = (north0 + i) * 1.5 - math.radians(lat) * 6371000
                e_m = (east0 + j) * 1.5 - math.radians(lng) * 6371000 * math.cos(math.radians(lat))
                rad = math.radians(hdg)
                fwd = n_m * math.cos(rad) + e_m * math.sin(rad)
                right = -n_m * math.sin(rad) + e_m * math.cos(rad)
                if fwd < 0.3:
                    continue
                p = cam.ground_to_pixel(fwd, right)
                if not p or not (0 <= p[1] < ramp_y - 2):
                    continue
                L = 0.5 / cam.ground_scale(fwd)
                dr.line([(p[0] - L, p[1]), (p[0] + L, p[1])], fill=(70, 115, 135), width=1)
        items, ducks, ramp = self.scene(pose, w, h)
        for o in sorted(items, key=lambda o: o["y"]):
            x0, y0, x1, y1 = o["x"] - o["bw"] / 2, o["y"] - o["bh"] / 2, o["x"] + o["bw"] / 2, o["y"] + o["bh"] / 2
            if "bag" in o["label"]:
                dr.ellipse([x0, y0, x1, y1], fill=o["color"], outline=(200, 200, 200))
            else:
                dr.rounded_rectangle([x0, y0, x1, y1], radius=max(1, int(o["bh"] / 3)), fill=o["color"])
                if "bottle" in o["label"]:
                    dr.rectangle([x1 - o["bw"] * 0.15, y0 + o["bh"] * 0.25, x1, y1 - o["bh"] * 0.25], fill=(30, 90, 200))
        for d in ducks:
            x0, y0, x1, y1 = d["x"] - d["bw"] / 2, d["y"] - d["bh"] / 2, d["x"] + d["bw"] / 2, d["y"] + d["bh"] / 2
            dr.ellipse([x0, y0 + d["bh"] * 0.3, x1, y1], fill=(120, 85, 50))
            r = d["bh"] * 0.3
            dr.ellipse([x1 - 2 * r, y0, x1, y0 + 2 * r], fill=(30, 110, 60))
            dr.polygon([(x1, y0 + r * 0.8), (x1 + r, y0 + r), (x1, y0 + r * 1.3)], fill=(240, 170, 40))
        # Intake ramp
        dr.polygon([(w * 0.18, ramp_y), (w * 0.82, ramp_y), (w, h), (0, h)], fill=(58, 62, 68))
        for k in (0.3, 0.5, 0.7):
            dr.line([(w * (0.18 + 0.64 * k), ramp_y), (w * k, h)], fill=(80, 85, 92), width=2)
        for o in ramp:
            x0, y0, x1, y1 = o["x"] - o["bw"] / 2, o["y"] - o["bh"] / 2, o["x"] + o["bw"] / 2, o["y"] + o["bh"] / 2
            dr.rounded_rectangle([x0, y0, x1, y1], radius=4, fill=o["color"])
        dr.text((8, h - 16), "VARUNA SIMULATOR", fill=(150, 160, 170))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return buf.getvalue()


class SimCamera:
    """Renders SimWorld frames with the CameraManager interface main.py uses."""

    def __init__(self, world, cfg):
        self.world = world
        self.cfg = cfg
        self.w, self.h = cfg["camera_width"], cfg["camera_height"]
        self._cond = threading.Condition()
        self._stop = threading.Event()
        self._thread = None
        self.frame = None
        self.frame_time = 0.0
        self.frame_seq = 0
        self.frames_captured = 0
        self._stamps = deque(maxlen=60)
        self.poses = OrderedDict()             # frame time → pose it was rendered from

    def start(self):
        self._thread = threading.Thread(target=self._run, name="sim-camera", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _run(self):
        period = 1.0 / max(1, min(15, self.cfg["camera_fps"]))
        last = time.time()
        while not self._stop.is_set():
            now = time.time()
            self.world.step(now - last)
            last = now
            b = self.world.boat
            pose = (b.lat, b.lng, b.heading)
            try:
                jpeg = self.world.render(pose, self.w, self.h)
            except Exception:
                time.sleep(0.5)
                continue
            t = time.time()
            with self._cond:
                self.frame, self.frame_time = jpeg, t
                self.frame_seq += 1
                self.frames_captured += 1
                self._stamps.append(t)
                self.poses[round(t, 3)] = pose
                while len(self.poses) > 200:
                    self.poses.popitem(last=False)
                self._cond.notify_all()
            self._stop.wait(max(0.0, period - (time.time() - now)))

    def pose_for(self, frame_time):
        with self._cond:                      # the camera thread adds/removes entries
            if not self.poses:
                return None
            key = min(self.poses, key=lambda k: abs(k - frame_time))
            return self.poses[key] if abs(key - frame_time) < 1.0 else None

    def wait_frame(self, after_seq, timeout=2.0):
        with self._cond:
            if self.frame_seq <= after_seq:
                self._cond.wait(timeout)
            if self.frame_seq > after_seq and self.frame is not None:
                return self.frame_seq, self.frame, self.frame_time
            return after_seq, None, 0.0

    def snapshot(self):
        return self.frame if self.connected else None

    @property
    def connected(self):
        return self.frame is not None and self._stamps and time.time() - self._stamps[-1] < 3.0

    def measured_fps(self):
        now = time.time()
        st = [t for t in self._stamps if now - t < 3.0]
        if len(st) < 2:
            return 0.0
        return round((len(st) - 1) / max(st[-1] - st[0], 1.0), 1)

    def get_status(self):
        c = bool(self.connected)
        return {"camera_connected": c, "status_text": "STREAMING" if c else "STARTING",
                "measured_fps": self.measured_fps(), "target": f"{self.w}x{self.h} @ {self.cfg['camera_fps']} fps",
                "resolution": f"{self.w}x{self.h}", "pipeline": "simulator", "source": "sim", "device": None,
                "frames_captured": self.frames_captured, "frame_bytes": len(self.frame) if self.frame else 0,
                "last_error": None}
