"""
The phone on the drone as its GPS and attitude source.

With no telemetry link on the drone, the VARUNA Cam app on the phone streams
its GPS position and camera attitude (http://<phone>:8080/location/stream, one
JSON line about 20 times a second). This module reads that stream and gives:

  * snapshot()       the latest position for the app's telemetry (lat, lng,
                     height above take-off, speed, heading, satellites, accuracy)
  * pose_at_phone()  where the drone was and which way the camera looked when a
                     video frame was taken, by the phone's own clock (the frame's
                     capture stamp), so detections are placed from that moment
  * recent_track()   the trail for the map

The phone sends the camera's attitude as a straight-down drone camera would
have it (heading = the way the top of the picture faces, pitch/roll = tilt from
looking straight down), so the app's ground projection needs no mounting setup.
"""

import json
import logging
import math
import threading
import time
import urllib.parse
import urllib.request
from collections import deque

log = logging.getLogger("drone.phone_gps")

KEEP_S = 30                 # history kept for matching frames
STALE_S = 3.0               # no line for this long: the phone is gone
FIX_MAX_AGE_S = 5.0         # an older GPS fix is no position
NETWORK_MAX_AGE_S = 60.0    # a coarse fix (Wi-Fi/cell, indoors) comes every ~20 s: hold it
COARSE_ACC_M = 30.0         # a fix less sure than this is coarse, whatever the phone calls it
EXTRAPOLATE_MAX_S = 2.0     # carry a fix forward along its velocity at most this long (GPS: 1 fix a second, sometimes one missed)
ATT_MAX_GAP_S = 0.5
OFFSET_WINDOW_S = 10        # clock offset: the smallest (arrival - phone time) seen in this long


def _interp_angle(a, b, f):
    return (a + ((b - a + 180) % 360 - 180) * f) % 360


def _move(lat, lng, north_m, east_m):
    dlat = north_m / 111_320.0
    dlng = east_m / (111_320.0 * max(0.01, math.cos(math.radians(lat))))
    return lat + dlat, lng + dlng


def _dist_m(lat1, lng1, lat2, lng2):
    n = (lat2 - lat1) * 111_320.0
    e = (lng2 - lng1) * 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(n, e)


class PhoneGPS:
    def __init__(self, cfg):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.latest = None              # the last line, as sent
        self.last_rx = 0.0              # time.time() it arrived
        self.error = ""
        self.url = ""
        self._att = deque(maxlen=20 * KEEP_S)    # (phone s, roll, pitch, hdg)
        self._alt = deque(maxlen=20 * KEEP_S)    # (phone s, rel_alt)
        self._fixes = deque(maxlen=10 * KEEP_S)  # (phone s, lat, lng, spd, crs)
        self._fix_info = {}             # the last fix's kind (gps/network) and accuracy
        self._offsets = deque()                  # (arrival, arrival - phone s)
        self.offset = None                       # laptop clock - phone clock, s
        self.track = deque(maxlen=900)
        self._resp = None

    # ------------------------------------------------------------------ connection
    def start(self):
        self._thread = threading.Thread(target=self._run, name="phone-gps", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        r = self._resp
        if r is not None:
            try:
                r.close()
            except Exception:
                pass

    def stream_url(self):
        """The phone's location stream, from the camera address (same phone)."""
        explicit = (self.cfg.get("phone_gps_url", "") or "").strip()
        if explicit:
            return explicit
        cam = (self.cfg.get("camera_url", "") or "").strip()
        if not cam:
            return ""
        u = urllib.parse.urlparse(cam)
        if not u.hostname:
            return ""
        return f"{u.scheme or 'http'}://{u.hostname}:{u.port or 8080}/location/stream"

    def _run(self):
        while not self._stop.is_set():
            if self.cfg.get("position_source", "auto") == "pixhawk":
                self.error = "position_source is pixhawk"
                self._stop.wait(2)
                continue
            url = self.stream_url()
            self.url = url
            if not url:
                self.error = "no camera_url set, so no phone to read the GPS from"
                self._stop.wait(2)
                continue
            try:
                with urllib.request.urlopen(url, timeout=5) as r:
                    self._resp = r
                    self.error = ""
                    log.info("Reading the phone's GPS from %s", url)
                    for line in r:
                        if self._stop.is_set():
                            return
                        line = line.strip()
                        if line:
                            try:
                                self.ingest(json.loads(line), time.time())
                            except ValueError:
                                continue
                self.error = "the phone closed the location stream"
            except Exception as exc:          # phone off, old VARUNA Cam without GPS, Wi-Fi gone
                msg = str(exc)
                if "404" in msg:
                    msg = "this VARUNA Cam has no GPS stream: install VARUNA Cam 2.2.0 or newer"
                if msg != self.error:
                    log.warning("Phone GPS: %s", msg)
                self.error = msg
            finally:
                self._resp = None
            self._stop.wait(1.0)

    # ------------------------------------------------------------------ samples
    def ingest(self, s, arrival):
        """One line from the phone (also used by the tests)."""
        t = s.get("t")
        if not isinstance(t, (int, float)):
            return
        ts = t / 1000.0
        with self._lock:
            self.latest = s
            self.last_rx = arrival
            # The phone's clock against this computer's: the quickest line shows
            # it best (its delay on the Wi-Fi was smallest).
            self._offsets.append((arrival, arrival - ts))
            while self._offsets and arrival - self._offsets[0][0] > OFFSET_WINDOW_S:
                self._offsets.popleft()
            self.offset = min(o for _, o in self._offsets)
            if all(k in s for k in ("hdg", "pitch", "roll")):
                self._att.append((ts, float(s["roll"]), float(s["pitch"]), float(s["hdg"])))
            if s.get("rel_alt") is not None:
                self._alt.append((ts, float(s["rel_alt"])))
            if s.get("lat") is not None and s.get("lng") is not None:
                fix_t = ts - (s.get("fix_age") or 0) / 1000.0
                self._fix_info = {"fix": s.get("fix"), "acc": s.get("acc")}
                if not self._fixes or fix_t - self._fixes[-1][0] > 0.05:
                    self._fixes.append((fix_t, float(s["lat"]), float(s["lng"]),
                                        s.get("spd"), s.get("crs")))
                    last = self.track[-1] if self.track else None
                    if last is None or arrival - last["t"] >= 0.5 or \
                            _dist_m(last["lat"], last["lng"], s["lat"], s["lng"]) > 1.0:
                        self.track.append({"t": round(arrival, 1), "lat": s["lat"], "lng": s["lng"],
                                           "alt": round(self._rel_alt(s) or 0.0, 1)})

    @property
    def connected(self):
        return self.latest is not None and time.time() - self.last_rx < STALE_S

    @property
    def has_fix(self):
        with self._lock:
            return self.connected and bool(self._fixes) and \
                self._phone_now() - self._fixes[-1][0] < self._max_age()

    def _coarse(self):
        acc = self._fix_info.get("acc")
        return self._fix_info.get("fix") != "gps" or acc is None or float(acc) > COARSE_ACC_M

    def _max_age(self):
        return NETWORK_MAX_AGE_S if self._coarse() else FIX_MAX_AGE_S

    def _phone_now(self):
        return time.time() - (self.offset or 0.0)

    def _rel_alt(self, s):
        fixed = float(self.cfg.get("phone_fixed_alt_m", 0) or 0)
        if fixed > 0:
            return fixed
        return s.get("rel_alt")

    # ------------------------------------------------------------------ poses
    def _position_at(self, ts):
        """(lat, lng) at phone time ts: between two fixes, or carried forward
        from the last one along its velocity; None if no fix is close."""
        fx = self._fixes
        if not fx:
            return None
        if ts >= fx[-1][0]:
            t0, lat, lng, spd, crs = fx[-1]
            dt = ts - t0
            if dt > self._max_age():
                return None
            dt = min(dt, EXTRAPOLATE_MAX_S)
            vn = ve = 0.0
            if self._coarse():
                pass                              # a coarse fix: no movement to read from it
            elif spd is not None and crs is not None and spd >= 0:
                vn = spd * math.cos(math.radians(crs))
                ve = spd * math.sin(math.radians(crs))
            elif len(fx) >= 2 and 0 < t0 - fx[-2][0] < 2.5:
                p = fx[-2]
                span = t0 - p[0]
                vn = (lat - p[1]) * 111_320.0 / span
                ve = (lng - p[2]) * 111_320.0 * math.cos(math.radians(lat)) / span
                if math.hypot(vn, ve) < 0.5:      # standing still: GPS wander, not movement
                    vn = ve = 0.0
            return _move(lat, lng, vn * dt, ve * dt)
        if ts <= fx[0][0]:
            return (fx[0][1], fx[0][2]) if fx[0][0] - ts < 1.0 else None
        for i in range(len(fx) - 1, 0, -1):
            a, b = fx[i - 1], fx[i]
            if a[0] <= ts <= b[0]:
                f = (ts - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
                return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f
        return None

    @staticmethod
    def _series_at(series, ts, angles=()):
        if not series:
            return None
        if ts >= series[-1][0]:
            return series[-1][1:] if ts - series[-1][0] <= ATT_MAX_GAP_S else None
        if ts <= series[0][0]:
            return series[0][1:] if series[0][0] - ts <= ATT_MAX_GAP_S else None
        for i in range(len(series) - 1, 0, -1):
            a, b = series[i - 1], series[i]
            if a[0] <= ts <= b[0]:
                f = (ts - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
                return tuple(_interp_angle(a[k], b[k], f) if k in angles else a[k] + (b[k] - a[k]) * f
                             for k in range(1, len(a)))
        return None

    def _smoothed_att(self, ts, radius_s):
        """Attitude averaged around ts the way stabilisation smooths the picture
        (Gaussian, sigma = radius / 2): the stabilised frame shows the camera's
        smoothed aim, not its shake."""
        sigma = radius_s / 2.0
        sw = sr = sp = hs = hc = 0.0
        for t, roll, pitch, hdg in reversed(self._att):
            if t < ts - radius_s:
                break
            if t > ts + radius_s:
                continue
            w = math.exp(-0.5 * ((t - ts) / sigma) ** 2)
            sw += w
            sr += w * roll
            sp += w * pitch
            hs += w * math.sin(math.radians(hdg))
            hc += w * math.cos(math.radians(hdg))
        if sw <= 0:
            return None
        return sr / sw, sp / sw, math.degrees(math.atan2(hs, hc)) % 360

    def pose_at_phone(self, ts, zoom=1.0, smooth_s=0.0):
        """Pose when the phone's clock read ts (s): the app's frame pose, with
        cam=True (attitude is the camera's own) and the picture's field of view.
        smooth_s: the stabiliser's look-ahead, to match its smoothed picture."""
        with self._lock:
            pos = self._position_at(ts)
            att = (self._smoothed_att(ts, smooth_s) if smooth_s > 0 else None)                 or self._series_at(self._att, ts, angles=(3,))
            alt = self._series_at(self._alt, ts)
            s = self.latest or {}
        fixed = float(self.cfg.get("phone_fixed_alt_m", 0) or 0)
        out = {
            "lat": round(pos[0], 7) if pos else None,
            "lng": round(pos[1], 7) if pos else None,
            "alt": round(fixed, 2) if fixed > 0 else (round(alt[0], 2) if alt else None),
            "hdg": round(att[2], 1) if att else None,
            "roll": round(att[0], 2) if att else None,
            "pitch": round(att[1], 2) if att else None,
            "cam": True,
            "src": "phone",
        }
        fov = s.get("fov")
        if fov:
            # Stabilisation zooms in: the picture the app sees is narrower.
            out["fov"] = round(math.degrees(2 * math.atan(math.tan(math.radians(fov) / 2) / max(1.0, zoom))), 2)
        acc = s.get("acc") if s.get("acc") is not None else self._fix_info.get("acc")
        if acc is not None:
            out["acc"] = acc
        return out

    def pose_at(self, t, zoom=1.0, smooth_s=0.0):
        """Pose at this computer's time t."""
        return self.pose_at_phone(t - (self.offset or 0.0), zoom, smooth_s)

    # ------------------------------------------------------------------ for the app
    def snapshot(self):
        with self._lock:
            s = dict(self.latest or {})
        fresh = self.connected
        pose = self.pose_at_phone(self._phone_now()) if fresh else {}
        has_fix = fresh and pose.get("lat") is not None
        return {
            "connected": fresh,
            "lat": pose.get("lat") if has_fix else None,
            "lng": pose.get("lng") if has_fix else None,
            "rel_alt": self._rel_alt(s) if fresh else None,
            "alt_src": "fixed" if float(self.cfg.get("phone_fixed_alt_m", 0) or 0) > 0 else s.get("alt_src"),
            "alt_msl": s.get("alt_msl") if fresh else None,
            "speed": s.get("spd") if has_fix else None,
            "course": s.get("crs") if has_fix else None,
            "heading": pose.get("hdg"),
            "roll": pose.get("roll"),
            "pitch": pose.get("pitch"),
            "accuracy": (s.get("acc") or self._fix_info.get("acc")) if has_fix else None,
            "fix": (s.get("fix") or self._fix_info.get("fix")) if has_fix else None,
            "satellites": s.get("sats"),
            "satellites_seen": s.get("sats_seen"),
            "home_lat": s.get("home_lat"),
            "home_lng": s.get("home_lng"),
            "fov": s.get("fov"),
            "problem": s.get("problem") or (self.error if not fresh else ""),
            "url": self.url,
            "age_s": round(time.time() - self.last_rx, 2) if self.latest else None,
        }

    def recent_track(self, limit=300):
        return list(self.track)[-limit:]

    def set_home(self):
        """Makes the phone's current position the take-off point (height 0)."""
        url = self.stream_url().replace("/location/stream", "/location/home")
        if not url:
            raise OSError("no phone address")
        with urllib.request.urlopen(url, timeout=4) as r:
            return json.loads(r.read() or b"{}")
