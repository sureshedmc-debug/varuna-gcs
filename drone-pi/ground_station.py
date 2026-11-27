"""
VARUNA ground station (runs on the PC, not the Pi).

The drone's Raspberry Pi sends two UDP streams over Tailscale (or the Wi-Fi):

  port 5000  the camera's hardware-encoded H.264 as RTP (camera.py RtpSender)
  port 5001  the Pixhawk's GPS as JSON, one datagram per fix (mav_link.py)

This program says hello to the Pi on both ports (that is how the Pi knows
where to send), and:

  1. A frame-grabber thread receives the RTP, rebuilds each frame, decodes it
     (PyAV / FFmpeg, low-delay, slice threads only) and puts it in ONE slot,
     overwriting the last: no queue ever builds up, the detector always gets
     the newest picture. A lost packet drops frames only until the next IDR
     (every 15 frames = 0.5 s). Equivalent to appsink drop=true sync=false.
  2. A GPS thread keeps the last 60 s of fixes (thread-safe) and answers
     "where was the drone at Pi-time t" by interpolating between fixes.
  3. The main thread runs the plastic model (public/models/plastic.onnx, the
     app's "TACO groups" model) with onnxruntime, choosing CUDA, then DirectML,
     then the CPU, whichever this PC's onnxruntime has.
  4. Every plastic detection is tagged with the drone's lat / lng / alt at the
     moment that frame was taken (each frame carries its capture time), logged
     to drone-pi/data/ground_station_detections.jsonl, and forwarded in the
     background to the boat (POST /api/live/targets: the boat's new-find signal
     runs its motor + buzzer) and to the drone backend (POST /api/ai/report,
     shown in the app). One find per spot: the same plastic seen again within
     DEDUP_M and DEDUP_S is logged but not sent again.

Run:   py -3 drone-pi\\ground_station.py                 (finds varuna-drone by itself)
       py -3 drone-pi\\ground_station.py --pi 192.168.1.50 --show
Needs: pip install numpy onnxruntime av opencv-python
       (onnxruntime-directml instead of onnxruntime for the GPU on Windows,
        onnxruntime-gpu for an NVIDIA card)
"""

import argparse
import base64
import collections
import json
import logging
import math
import os
import queue
import socket
import struct
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

VIDEO_PORT = 5000
GPS_PORT = 5001
RTP_HELLO = b"VARUNA_RTP_HELLO"          # must match camera.py
GPS_HELLO = b"VARUNA_GPS_HELLO"          # must match mav_link.py
HELLO_EVERY_S = 0.5                      # the Pi forgets a PC 5 s after its last hello
PI_CANDIDATES = ("varuna-drone", "varuna-drone.local", "raspberrypi.local")   # Tailscale first
SWITCH_AFTER_S = 3.0                     # nothing from this Pi address: try the next one
GPS_KEEP_S = 60.0
GPS_MAX_GAP_S = 1.5                      # a fix further than this from the frame's time isn't trusted
DEDUP_M = 3.0
DEDUP_S = 30.0
DEFAULT_CONF = 0.35

log = logging.getLogger("ground")


# ============================================================== RTP → H.264 frames
class RtpH264Depacketizer:
    """RTP packets (RFC 6184: single NAL, STAP-A, FU-A) → Annex-B access units.

    feed() returns a list of finished frames: (annexb_bytes, keyframe, capture_us)
    where capture_us is the Pi's capture time from the header extension (or None).
    After a lost packet, frames are dropped until the next IDR: a decoder fed a
    frame with a hole shows garbage until then anyway."""

    def __init__(self):
        self.expect_seq = None
        self.ts = None
        self.nals = []
        self.fu = None                   # FU-A being rebuilt
        self.capture_us = None
        self.broken = True               # wait for an IDR to start
        self.lost = 0
        self.packets = 0

    def feed(self, pkt):
        out = []
        if len(pkt) < 12 or pkt[0] >> 6 != 2:
            return out
        self.packets += 1
        b0, b1, seq, ts = pkt[0], pkt[1], *struct.unpack("!HI", pkt[2:8])
        marker = bool(b1 & 0x80)
        off = 12 + 4 * (b0 & 0x0F)
        ext_us = None
        if b0 & 0x10:                    # header extension
            if len(pkt) < off + 4:
                return out
            prof, words = struct.unpack("!HH", pkt[off:off + 4])
            ext = pkt[off + 4:off + 4 + 4 * words]
            off += 4 + 4 * words
            if prof == 0xBEDE:
                i = 0
                while i < len(ext):
                    if ext[i] == 0:
                        i += 1
                        continue
                    eid, ln = ext[i] >> 4, (ext[i] & 0x0F) + 1
                    if eid == 1 and ln == 8:
                        ext_us = struct.unpack("!Q", ext[i + 1:i + 9])[0]
                    i += 1 + ln
        payload = pkt[off:]
        if b0 & 0x20 and payload:        # padding
            payload = payload[:-payload[-1]]
        if self.expect_seq is not None and seq != self.expect_seq:
            self.lost += (seq - self.expect_seq) & 0xFFFF
            self.broken = True
            self.fu = None
        self.expect_seq = (seq + 1) & 0xFFFF
        if self.ts is not None and ts != self.ts and self.nals:
            fr = self._finish()          # a frame whose marker packet was lost
            if fr:
                out.append(fr)
        self.ts = ts
        if ext_us is not None:
            self.capture_us = ext_us
        if not payload:
            return out
        kind = payload[0] & 0x1F
        if kind == 28:                   # FU-A
            if len(payload) < 2:
                return out
            fu_hdr = payload[1]
            if fu_hdr & 0x80:
                self.fu = bytearray([(payload[0] & 0xE0) | (fu_hdr & 0x1F)]) + payload[2:]
            elif self.fu is not None:
                self.fu += payload[2:]
            if fu_hdr & 0x40 and self.fu is not None:
                self.nals.append(bytes(self.fu))
                self.fu = None
        elif kind == 24:                 # STAP-A
            i = 1
            while i + 2 <= len(payload):
                n = struct.unpack("!H", payload[i:i + 2])[0]
                self.nals.append(payload[i + 2:i + 2 + n])
                i += 2 + n
        elif 1 <= kind <= 23:
            self.nals.append(payload)
        if marker:
            fr = self._finish()
            if fr:
                out.append(fr)
        return out

    def _finish(self):
        nals, cap = self.nals, self.capture_us
        self.nals, self.capture_us, self.fu = [], None, None
        kinds = {n[0] & 0x1F for n in nals if n}
        key = 5 in kinds
        if self.broken:
            # Start again only at an IDR whose SPS/PPS the decoder has (now or before).
            if not key or (7 not in kinds and not getattr(self, "_have_sps", False)):
                return None
            self.broken = False
        if 7 in kinds:
            self._have_sps = True
        if not (kinds & {1, 5}):
            return None
        return b"".join(b"\x00\x00\x00\x01" + n for n in nals), key, cap


class LatestFrame:
    """One slot, always the newest decoded picture (no queue, nothing waits)."""

    def __init__(self):
        self._cond = threading.Condition()
        self.frame = None                # BGR numpy array
        self.capture_us = None
        self.received = 0.0
        self.seq = 0

    def put(self, img, capture_us, received):
        with self._cond:
            self.frame, self.capture_us, self.received = img, capture_us, received
            self.seq += 1
            self._cond.notify_all()

    def wait_newer(self, seq, timeout=1.0):
        with self._cond:
            if self.seq <= seq:
                self._cond.wait(timeout)
            if self.seq > seq and self.frame is not None:
                return self.seq, self.frame, self.capture_us, self.received
            return seq, None, None, None


class PiAddress:
    """Which address reaches the Pi: Tailscale name first, then the LAN names.
    Sticks to the one that answers; moves on when it goes quiet."""

    def __init__(self, names):
        self.names = list(names)
        self.i = 0
        self.ip = None
        self._resolved_at = 0.0
        self.heard_at = time.time()
        self.lock = threading.Lock()

    def get(self):
        now = time.time()
        with self.lock:
            if now - self.heard_at > SWITCH_AFTER_S and len(self.names) > 1 and self.ip is not None:
                self.i = (self.i + 1) % len(self.names)
                self.ip = None
                self.heard_at = now
            if self.ip is None and now - self._resolved_at > 1.0:
                self._resolved_at = now
                for k in range(len(self.names)):
                    name = self.names[(self.i + k) % len(self.names)]
                    try:
                        self.ip = socket.gethostbyname(name)
                        self.i = (self.i + k) % len(self.names)
                        log.info("Pi: trying %s (%s)", name, self.ip)
                        break
                    except OSError:
                        continue
            return self.ip

    def heard(self, ip):
        with self.lock:
            self.heard_at = time.time()
            if self.ip != ip:
                self.ip = ip             # whatever address the stream really comes from


def open_udp(port, rcvbuf=4 << 20):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
    except OSError:
        pass
    if sys.platform == "win32":
        try:                             # an ICMP "port unreachable" must not break recvfrom
            s.ioctl(socket.SIO_UDP_CONNRESET, False)
        except (AttributeError, OSError):
            pass
    s.bind(("0.0.0.0", port))
    s.settimeout(0.2)
    return s


class FrameGrabber(threading.Thread):
    """UDP RTP → frames → decoder → LatestFrame. Says hello to the Pi."""

    def __init__(self, pi, port, slot, decode=True, pi_port=None):
        super().__init__(name="frame-grabber", daemon=True)
        self.pi, self.port, self.slot, self.decode = pi, port, slot, decode
        self.pi_port = pi_port or port      # where the Pi listens for the hello (normally the same port)
        self.dep = RtpH264Depacketizer()
        self.frames = 0
        self.decoded = 0
        self.errors = 0
        self.last_rx = 0.0
        self.stop = threading.Event()
        self._codec = None

    def _decoder(self):
        import av
        ctx = av.CodecContext.create("h264", "r")
        try:
            ctx.thread_type = "SLICE"    # frame threads would hold frames back
        except Exception:
            pass
        try:
            ctx.options = {"flags": "low_delay", "flags2": "fast"}
        except Exception:
            pass
        return ctx

    def run(self):
        sock = open_udp(self.port)
        hello_at = 0.0
        while not self.stop.is_set():
            now = time.time()
            if now - hello_at >= HELLO_EVERY_S:
                hello_at = now
                ip = self.pi.get()
                if ip:
                    try:
                        sock.sendto(RTP_HELLO, (ip, self.pi_port))
                    except OSError:
                        pass
            try:
                pkt, addr = sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError:
                continue
            self.last_rx = time.time()
            self.pi.heard(addr[0])
            for data, key, cap in self.dep.feed(pkt):
                self.frames += 1
                if not self.decode:
                    self.slot.put(data, cap, self.last_rx)
                    continue
                self._decode(data, cap)

    def _decode(self, data, cap):
        import av
        if self._codec is None:
            self._codec = self._decoder()
        try:
            for fr in self._codec.decode(av.Packet(data)):
                img = fr.to_ndarray(format="bgr24")
                self.decoded += 1
                self.slot.put(img, cap, self.last_rx)
        except Exception as exc:         # noqa: BLE001 - a bad frame: wait for the next IDR
            self.errors += 1
            self.dep.broken = True
            if self.errors < 5 or self.errors % 100 == 0:
                log.warning("decode: %s", exc)


# ============================================================== GPS
class GpsTrack(threading.Thread):
    """The drone's fixes from UDP 5001, thread-safe lookups by Pi time."""

    def __init__(self, pi, port, pi_port=None):
        super().__init__(name="gps", daemon=True)
        self.pi, self.port = pi, port
        self.pi_port = pi_port or port
        self.fixes = collections.deque()     # (pi_t, msg)
        self.lock = threading.Lock()
        self.offset = None                   # pc_time - pi_time (min over recent: clock offset + one-way delay)
        self._offsets = collections.deque(maxlen=200)
        self.count = 0
        self.last_rx = 0.0
        self.stop = threading.Event()

    def run(self):
        sock = open_udp(self.port, 1 << 20)
        hello_at = 0.0
        while not self.stop.is_set():
            now = time.time()
            if now - hello_at >= HELLO_EVERY_S:
                hello_at = now
                ip = self.pi.get()
                if ip:
                    try:
                        sock.sendto(GPS_HELLO, (ip, self.pi_port))
                    except OSError:
                        pass
            try:
                data, addr = sock.recvfrom(4096)
            except (socket.timeout, OSError):
                continue
            try:
                msg = json.loads(data)
            except ValueError:
                continue
            if msg.get("type") != "gps" or msg.get("lat") is None:
                continue
            self.ingest(msg, time.time())

    def ingest(self, msg, rx):
        t = float(msg.get("t") or rx)
        with self.lock:
            self.fixes.append((t, msg))
            while self.fixes and t - self.fixes[0][0] > GPS_KEEP_S:
                self.fixes.popleft()
            self._offsets.append(rx - t)
            self.offset = min(self._offsets)
            self.count += 1
            self.last_rx = rx

    def latest(self):
        with self.lock:
            return dict(self.fixes[-1][1]) if self.fixes else None

    def at(self, pi_t):
        """{lat, lng, alt, alt_msl, hdg, fix, sats, dt} where the drone was at
        Pi time pi_t, or None if no fix is close enough in time."""
        with self.lock:
            fx = list(self.fixes)
        if not fx:
            return None
        if pi_t is None:
            t, m = fx[-1]
            return _fix(m, m, 0.0, time.time() - (t + (self.offset or 0.0)))
        after = next((i for i, (t, _) in enumerate(fx) if t >= pi_t), None)
        if after is None:                         # newer than every fix: the last one, if recent
            t, m = fx[-1]
            return _fix(m, m, 0.0, pi_t - t) if pi_t - t <= GPS_MAX_GAP_S else None
        if after == 0:
            t, m = fx[0]
            return _fix(m, m, 0.0, t - pi_t) if t - pi_t <= GPS_MAX_GAP_S else None
        (t0, m0), (t1, m1) = fx[after - 1], fx[after]
        k = 0.0 if t1 == t0 else (pi_t - t0) / (t1 - t0)
        return _fix(m0, m1, k, min(pi_t - t0, t1 - pi_t))


def _fix(m0, m1, k, dt):
    def lerp(key):
        a, b = m0.get(key), m1.get(key)
        if a is None or b is None:
            return b if a is None else a
        return a + (b - a) * k
    return {"lat": round(lerp("lat"), 7), "lng": round(lerp("lng"), 7),
            "alt": None if lerp("alt_rel") is None else round(lerp("alt_rel"), 2),
            "alt_msl": None if lerp("alt_msl") is None else round(lerp("alt_msl"), 2),
            "hdg": m1.get("hdg"), "fix": m1.get("fix"), "sats": m1.get("sats"),
            "dt_s": round(abs(dt), 3)}


# ============================================================== detector
def pick_providers(ort, want="auto"):
    have = ort.get_available_providers()
    order = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
    if want != "auto":
        order = [p for p in order if p.lower().startswith(want.lower())] + ["CPUExecutionProvider"]
    return [p for p in order if p in have] or have


class PlasticDetector:
    """YOLO (Ultralytics export, output [1, 4+nc, N], no NMS inside) with onnxruntime."""

    def __init__(self, model, meta=None, conf=DEFAULT_CONF, iou=0.45, provider="auto"):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        meta = meta or {}
        self.names = meta.get("names") or ["plastic"]
        self.target = set(meta.get("target_class_ids") or range(len(self.names)))
        self.size = int(meta.get("imgsz") or 640)
        self.conf, self.iou = conf, iou
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        provs = pick_providers(ort, provider)
        self.sess = ort.InferenceSession(model, so, providers=provs)
        self.provider = self.sess.get_providers()[0]
        self.input = self.sess.get_inputs()[0].name
        self.ms = None

    def __call__(self, img):
        import cv2
        np = self.np
        h, w = img.shape[:2]
        s = self.size
        r = min(s / w, s / h)
        nw, nh = int(round(w * r)), int(round(h * r))
        px, py = (s - nw) // 2, (s - nh) // 2
        canvas = np.full((s, s, 3), 114, dtype=np.uint8)
        canvas[py:py + nh, px:px + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        t0 = time.perf_counter()
        out = self.sess.run(None, {self.input: np.ascontiguousarray(x)})[0]
        ms = (time.perf_counter() - t0) * 1000
        self.ms = ms if self.ms is None else self.ms * 0.8 + ms * 0.2
        p = out[0]
        if p.shape[0] < p.shape[1]:
            p = p.T                                  # [N, 4+nc]
        scores = p[:, 4:]
        cls = scores.argmax(1)
        conf = scores[np.arange(len(cls)), cls]
        keep = conf >= self.conf
        if not keep.any():
            return []
        b, cls, conf = p[keep, :4], cls[keep], conf[keep]
        x1 = (b[:, 0] - b[:, 2] / 2 - px) / r
        y1 = (b[:, 1] - b[:, 3] / 2 - py) / r
        x2 = (b[:, 0] + b[:, 2] / 2 - px) / r
        y2 = (b[:, 1] + b[:, 3] / 2 - py) / r
        boxes = np.stack([x1.clip(0, w), y1.clip(0, h), x2.clip(0, w), y2.clip(0, h)], 1)
        dets = []
        for c in set(cls.tolist()):
            if c not in self.target:
                continue
            m = cls == c
            for i in nms(boxes[m], conf[m], self.iou):
                bx = boxes[m][i]
                dets.append({"cls": int(c), "label": self.names[c] if c < len(self.names) else str(c),
                             "score": round(float(conf[m][i]), 3),
                             "box": [round(float(v), 1) for v in bx]})
        dets.sort(key=lambda d: -d["score"])
        return dets


def nms(boxes, scores, thr):
    import numpy as np
    order = scores.argsort()[::-1]
    keep = []
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = (xx2 - xx1).clip(0) * (yy2 - yy1).clip(0)
        iou = inter / (area[i] + area[order[1:]] - inter + 1e-9)
        order = order[1:][iou < thr]
    return keep


# ============================================================== log + dispatch
def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def post_json(url, body, timeout=2.5):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


class Dispatcher(threading.Thread):
    """Logs every geotagged detection; sends each NEW spot to the boat and the
    drone backend in the background (the detector never waits on the network)."""

    def __init__(self, log_path, boat_url, gcs_url, dedup_m=DEDUP_M, dedup_s=DEDUP_S, post=post_json):
        super().__init__(name="dispatch", daemon=True)
        self.log_path, self.boat_url, self.gcs_url = log_path, boat_url, gcs_url
        self.dedup_m, self.dedup_s, self.post = dedup_m, dedup_s, post
        self.q = queue.Queue(maxsize=64)
        self.sent = []                       # (t, lat, lng) of finds sent recently
        self.stats = {"logged": 0, "boat_ok": 0, "boat_fail": 0, "gcs_ok": 0, "gcs_fail": 0, "dup": 0, "no_fix": 0}
        self.last_boat = None

    def submit(self, rec):
        """Called by the detector loop: log now (cheap), network later."""
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({k: v for k, v in rec.items() if k != "crop_jpeg"}) + "\n")
            self.stats["logged"] += 1
        except OSError as exc:
            log.warning("log: %s", exc)
        try:
            self.q.put_nowait(rec)
        except queue.Full:
            try:
                self.q.get_nowait()          # drop the oldest: the newest find matters most
            except queue.Empty:
                pass
            self.q.put_nowait(rec)

    def is_new_spot(self, rec, now):
        self.sent = [s for s in self.sent if now - s[0] < self.dedup_s]
        for _, la, ln in self.sent:
            if haversine_m(la, ln, rec["lat"], rec["lng"]) <= self.dedup_m:
                return False
        self.sent.append((now, rec["lat"], rec["lng"]))
        return True

    def run(self):
        while True:
            rec = self.q.get()
            self.handle(rec)

    def handle(self, rec):
        now = time.time()
        if rec.get("lat") is None:
            self.stats["no_fix"] += 1
            return
        if not self.is_new_spot(rec, now):
            self.stats["dup"] += 1
            return
        target = {"id": rec["id"], "lat": rec["lat"], "lng": rec["lng"], "source": "drone",
                  "confidence": rec["score"], "object_class": rec["label"],
                  "timestamp": int(rec["t_capture"] * 1000)}
        if rec.get("crop_jpeg"):
            target["reference_image"] = rec["crop_jpeg"]
        if self.boat_url:
            try:
                r = self.post(self.boat_url.rstrip("/") + "/api/live/targets", {"targets": [target]})
                ok = r.get("success", True) is not False
                self.stats["boat_ok" if ok else "boat_fail"] += 1
                self.last_boat = r.get("message")
            except Exception as exc:         # noqa: BLE001
                self.stats["boat_fail"] += 1
                self.last_boat = f"not reachable: {exc}"
        if self.gcs_url:
            try:
                self.post(self.gcs_url.rstrip("/") + "/api/ai/report",
                          {"debrisType": rec["label"], "confidence": rec["score"], "lat": rec["lat"], "lng": rec["lng"]})
                self.stats["gcs_ok"] += 1
            except Exception:                # noqa: BLE001
                self.stats["gcs_fail"] += 1


def crop_jpeg(img, box, max_side=160):
    try:
        import cv2
        x1, y1, x2, y2 = [int(v) for v in box]
        pad = int(0.15 * max(x2 - x1, y2 - y1))
        h, w = img.shape[:2]
        c = img[max(0, y1 - pad):min(h, y2 + pad), max(0, x1 - pad):min(w, x2 + pad)]
        if c.size == 0:
            return None
        k = max_side / max(c.shape[:2])
        if k < 1:
            c = cv2.resize(c, (max(1, int(c.shape[1] * k)), max(1, int(c.shape[0] * k))))
        ok, buf = cv2.imencode(".jpg", c, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode() if ok else None
    except Exception:                        # noqa: BLE001
        return None


def geotag(dets, img, cap_us, gps, now, seq):
    """One record per detection, with the drone's position when the frame was taken."""
    pi_t = cap_us / 1e6 if cap_us else None
    fix = gps.at(pi_t)
    t_cap = pi_t + (gps.offset or 0.0) if pi_t is not None and gps.offset is not None else now
    recs = []
    for k, d in enumerate(dets):
        recs.append({
            "id": f"gs-{int(t_cap * 1000)}-{k}", "t_detect": round(now, 3), "t_capture": round(t_cap, 3),
            "frame": seq, "label": d["label"], "score": d["score"], "box": d["box"],
            "lat": fix["lat"] if fix else None, "lng": fix["lng"] if fix else None,
            "alt": fix["alt"] if fix else None, "alt_msl": fix["alt_msl"] if fix else None,
            "hdg": fix["hdg"] if fix else None, "gps_dt_s": fix["dt_s"] if fix else None,
            "gps_fix": fix["fix"] if fix else None,
            "crop_jpeg": crop_jpeg(img, d["box"]) if k == 0 else None,
        })
    return recs


def default_boat_url():
    if os.environ.get("VARUNA_BOAT_URL"):
        return os.environ["VARUNA_BOAT_URL"]
    try:
        with open(os.path.join(REPO, ".env.local"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("VITE_DEV_BOAT_TARGET="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return "http://localhost:5173/boat"      # the app's dev-server proxy to the boat


# ============================================================== main
def main(argv=None):
    ap = argparse.ArgumentParser(description="VARUNA ground station: drone RTP video + TELEM2 GPS → plastic finds")
    ap.add_argument("--pi", default=None, help="the drone Pi's name/IP (default: varuna-drone, then .local names)")
    ap.add_argument("--video-port", type=int, default=VIDEO_PORT)
    ap.add_argument("--gps-port", type=int, default=GPS_PORT)
    ap.add_argument("--pi-video-port", type=int, default=None, help="the Pi's RTP port, if not the same as --video-port")
    ap.add_argument("--pi-gps-port", type=int, default=None, help="the Pi's GPS port, if not the same as --gps-port")
    ap.add_argument("--model", default=os.path.join(REPO, "public", "models", "plastic.onnx"))
    ap.add_argument("--conf", type=float, default=DEFAULT_CONF, help="minimum score to count as plastic")
    ap.add_argument("--provider", default="auto", help="auto | cuda | dml | cpu")
    ap.add_argument("--boat", default=None, help="boat backend URL (default: .env.local VITE_DEV_BOAT_TARGET); 'off' = don't send")
    ap.add_argument("--gcs", default=None, help="drone backend URL for /api/ai/report (default: http://<pi>:8000); 'off' = don't send")
    ap.add_argument("--log", default=os.path.join(HERE, "data", "ground_station_detections.jsonl"))
    ap.add_argument("--show", action="store_true", help="show the video with boxes (OpenCV window)")
    ap.add_argument("--check", type=float, nargs="?", const=8.0, default=None, metavar="SECONDS",
                    help="only check the UDP links: say hello, wait for RTP video and GPS, report, exit (0 = both arrive)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    names = [a.pi] if a.pi else list(PI_CANDIDATES)
    pi = PiAddress(names)
    if a.check is not None:
        return check_links(pi, a.video_port, a.gps_port, a.check, a.pi_video_port, a.pi_gps_port)
    meta_path = os.path.splitext(a.model)[0] + ".json"
    meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
    det = PlasticDetector(a.model, meta, conf=a.conf, provider=a.provider)
    log.info("Model %s on %s (%d classes, plastic = %s)", os.path.basename(a.model), det.provider,
             len(det.names), ", ".join(det.names[i] for i in sorted(det.target) if i < len(det.names)))

    boat = None if (a.boat or "").lower() == "off" else (a.boat or default_boat_url())
    gcs = None if (a.gcs or "").lower() == "off" else a.gcs
    slot = LatestFrame()
    grab = FrameGrabber(pi, a.video_port, slot, pi_port=a.pi_video_port)
    gps = GpsTrack(pi, a.gps_port, pi_port=a.pi_gps_port)
    os.makedirs(os.path.dirname(a.log), exist_ok=True)
    disp = Dispatcher(a.log, boat, gcs)
    grab.start()
    gps.start()
    disp.start()
    log.info("Waiting for the drone on UDP %d (video) and %d (GPS); boat: %s", a.video_port, a.gps_port, boat or "off")

    seq, shown_at, n_det, frames_done = 0, time.time(), 0, 0
    while True:
        seq, img, cap_us, rx = slot.wait_newer(seq, 1.0)
        now = time.time()
        if gcs is None and (a.gcs or "").lower() != "off" and pi.ip:
            gcs = f"http://{pi.ip}:8000"
            disp.gcs_url = gcs
        if img is not None:
            dets = det(img)
            frames_done += 1
            if dets:
                n_det += len(dets)
                for rec in geotag(dets, img, cap_us, gps, time.time(), seq):
                    disp.submit(rec)
            if a.show:
                show(img, dets, det)
        if now - shown_at >= 2.0:
            age = None
            if cap_us and gps.offset is not None:
                age = (time.time() - (cap_us / 1e6 + gps.offset)) * 1000
            fx = gps.latest()
            log.info("video %s fps rx / %d decoded, lost %d pkts | detect %.0f ms (%s) | frame age %s | GPS %s | finds %d | sent boat %d/%d",
                     round(grab.frames / (now - shown_at), 1), frames_done, grab.dep.lost,
                     det.ms or 0, det.provider.replace("ExecutionProvider", ""),
                     f"~{age:.0f} ms" if age is not None else "?",
                     f"{fx['lat']:.6f},{fx['lng']:.6f} fix {fx.get('fix')}" if fx else "none",
                     n_det, disp.stats["boat_ok"], disp.stats["boat_ok"] + disp.stats["boat_fail"])
            grab.frames, frames_done, shown_at = 0, 0, now


def check_links(pi, video_port, gps_port, seconds, pi_video_port=None, pi_gps_port=None):
    """Say hello on both ports and report what comes back (no model, no decoding)."""
    slot = LatestFrame()
    grab = FrameGrabber(pi, video_port, slot, decode=False, pi_port=pi_video_port)
    gps = GpsTrack(pi, gps_port, pi_port=pi_gps_port)
    grab.start()
    gps.start()
    t0 = time.time()
    while time.time() - t0 < seconds and not (grab.frames >= 15 and gps.count >= 3):
        time.sleep(0.2)
    dt = max(0.001, time.time() - t0)
    video_ok, gps_ok = grab.frames > 0, gps.count > 0
    print(f"Pi address : {pi.ip or 'not found'}")
    print(f"RTP video  : {'OK' if video_ok else 'NOTHING'} on UDP {video_port} - {grab.dep.packets} packets, "
          f"{grab.frames} frames ({grab.frames / dt:.1f} fps), {grab.dep.lost} lost")
    fx = gps.latest()
    print(f"GPS JSON   : {'OK' if gps_ok else 'NOTHING'} on UDP {gps_port} - {gps.count} fixes"
          + (f", last {fx['lat']:.6f},{fx['lng']:.6f} fix {fx.get('fix')} sats {fx.get('sats')}" if fx else ""))
    if not gps_ok:
        print("             (GPS is only sent once the Pixhawk reports a position)")
    return 0 if video_ok and gps_ok else 1


def show(img, dets, det):
    import cv2
    im = img.copy()
    for d in dets:
        x1, y1, x2, y2 = [int(v) for v in d["box"]]
        cv2.rectangle(im, (x1, y1), (x2, y2), (0, 200, 255), 2)
        cv2.putText(im, f"{d['label']} {d['score']:.0%}", (x1, max(12, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
    cv2.imshow("VARUNA ground station", im)
    if cv2.waitKey(1) & 0xFF == 27:
        raise SystemExit(0)


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except KeyboardInterrupt:
        pass
