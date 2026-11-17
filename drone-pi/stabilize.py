"""
Video stabilisation for the phone camera (VARUNA Cam's H.264), on the laptop
backend: steadies the picture and takes out the drone's vibration and jitter.

    phone H.264 ─► ffmpeg decode ─► track + smooth + warp ─► x264 encode ─► app

  * Tracking: corner features on a small grey copy of each frame, followed into
    the next with optical flow; the frame-to-frame motion (shift and rotation)
    comes from them, with outliers (a bird, the water) voted out (RANSAC).
  * Smoothing: the camera's path is averaged over a window centred on each
    frame, so the frame waits for stabilize_delay_ms of later frames first.
    That lag is what makes it smooth without lagging behind a real turn: a
    one-sided (live) filter can only follow a turn late. Shake faster than
    about 2 Hz, including prop vibration, is taken out.
  * Warping: each frame is moved by (smooth path − real path) and zoomed in by
    stabilize_crop_pct, so the moving edges stay outside the picture. A
    correction bigger than that margin is held at the margin.

Vibration faster than one frame (rolling-shutter "jello") can't be undone from
the pictures: mount the phone on foam or dampers.

The capture time of each frame (VARUNA Cam's SEI stamp) is put back on the
re-encoded frame, so the delay can still be measured end to end. If ffmpeg or
OpenCV is missing or fails, the camera goes on without stabilisation.
"""

import logging
import re
import subprocess
import queue
import threading
import time
from collections import deque

log = logging.getLogger("drone.stabilize")

try:
    import cv2
    import numpy as np
except ImportError:          # the Pi image may not have OpenCV: no stabilisation there
    cv2 = None
    np = None

SEI_MARK = re.compile(rb"VARUNA-CAM-TIME!t=(\d+)")
SEI_UUID = b"VARUNA-CAM-TIME!"
AUD = b"\x00\x00\x00\x01\x09\xf0"   # access-unit delimiter: "a new frame starts here"
MAX_BEHIND_S = 0.8                # further behind than this …
BEHIND_FOR_S = 2.0                # … for this long: give up stabilising
TRACK_W = 320                 # width of the grey copy used for tracking
MAX_ROT = np.deg2rad(4.0) if np is not None else 0.07


def available():
    return cv2 is not None


def sei_stamp(ms):
    """VARUNA Cam's SEI time stamp, as it sends it (digits only: no emulation bytes)."""
    text = b"t=%d" % ms
    payload = SEI_UUID + text
    return b"\x00\x00\x00\x01\x06\x05" + bytes([len(payload)]) + payload + b"\x80"


class Stabilizer:
    """Feed it the phone's H.264 frames with offer(); it calls on_frame(data,
    keyframe, sps) with stabilised H.264 frames, like H264Splitter does."""

    def __init__(self, ffmpeg, width, height, fps, cfg, on_frame, splitter_cls):
        self.ffmpeg = ffmpeg
        self.w, self.h = width - width % 2, height - height % 2
        self.fps = max(1, fps)
        self.cfg = cfg
        self.on_frame = on_frame
        self.stop = threading.Event()
        self.failed = False
        self.frames_out = 0
        self.process_ms = 0.0
        self._stamps = deque()            # capture-time stamps, in frame order
        self._out_stamps = deque()        # … of the frames sent to the encoder
        self._inq = deque()               # H.264 frames waiting for the decoder
        self._in_cv = threading.Condition()
        self._need_key = True
        self.in_fps = float(self.fps)     # the rate frames really come in at (the phone's may be lower)
        self._last_in = None
        self._gap = 1.0 / self.fps
        self._arrived = {}                # capture stamp -> when it came in here
        self.behind_ms = 0.0              # how far the stabilised video runs behind the phone's
        self._behind_since = None
        # Small reads, one thread, no probing: each frame comes out as soon as it
        # is in (ffmpeg's defaults hold back ~16 frames: a second or more).
        dec_cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-blocksize", "512", "-flags", "low_delay",
                   "-threads", "1", "-probesize", "32", "-analyzeduration", "0", "-f", "h264", "-i", "pipe:0",
                   "-vf", f"scale={self.w}:{self.h}", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"]
        kbps = 8000                       # to the app on this laptop: plenty, so the re-encode stays sharp
        enc_cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p",
                   "-s", f"{self.w}x{self.h}", "-framerate", str(self.fps), "-i", "pipe:0",
                   "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
                   "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k", "-bufsize", f"{kbps // 2}k",
                   "-x264-params", f"keyint={self.fps}:min-keyint={self.fps}:scenecut=0:repeat-headers=1",
                   "-bf", "0", "-f", "h264", "-flush_packets", "1", "pipe:1"]
        flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        self.dec = subprocess.Popen(dec_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, bufsize=0, creationflags=flags)
        self.enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, bufsize=0, creationflags=flags)
        self.splitter = splitter_cls(self._encoded)
        for target, name in ((self._feed, "stab-feed"), (self._process, "stab-process"),
                             (self._read_encoded, "stab-out")):
            threading.Thread(target=target, name=name, daemon=True).start()
        log.info("Stabilising the phone video at %dx%d (look-ahead %d ms, crop %d %%)", self.w, self.h,
                 self._delay_frames() * 1000 // self.fps, self._crop_pct())

    # ------------------------------------------------------------------ settings
    def _delay_frames(self):
        """The look-ahead in frames, from the rate frames really arrive at: a
        phone sending 8 fps instead of 30 would otherwise wait 4x as long."""
        ms = int(self.cfg.get("stabilize_delay_ms", 160))
        return max(0, min(60, round(ms * self.in_fps / 1000)))

    def _crop_pct(self):
        return max(0, min(25, int(self.cfg.get("stabilize_crop_pct", 12))))

    # ------------------------------------------------------------------ in
    def offer(self, data, keyframe, sps=None):
        """A frame from the phone. False if the stabiliser has stopped working."""
        if self.failed:
            return False
        now = time.perf_counter()
        if self._last_in is not None:
            gap = now - self._last_in
            if 0.0 <= gap < 1.0:
                # Average the gaps, not 1/gap: the phone's frames come in bursts
                # (10 ms, 190 ms, …), and 1/gap would read 30 fps for a 10 fps phone.
                self._gap = 0.9 * self._gap + 0.1 * gap
                self.in_fps = min(60.0, 1.0 / max(self._gap, 1 / 60.0))
        self._last_in = now
        m = SEI_MARK.search(data, 0, 256)
        if m:
            self._arrived[int(m.group(1))] = now
            if len(self._arrived) > 8 * self.fps:
                for k in list(self._arrived)[:len(self._arrived) // 2]:
                    del self._arrived[k]
        with self._in_cv:
            if len(self._inq) > self.fps:          # the decoder fell a second behind: skip ahead
                self._inq.clear()
                self._need_key = True
            if self._need_key:
                if not keyframe:
                    return True
                self._need_key = False
            self._inq.append(data)
            self._in_cv.notify()
        return True

    def _feed(self):
        try:
            while not self.stop.is_set():
                with self._in_cv:
                    while not self._inq and not self.stop.is_set():
                        self._in_cv.wait(1.0)
                    if self.stop.is_set():
                        return
                    data = self._inq.popleft()
                m = SEI_MARK.search(data, 0, 256)
                with self._in_cv:
                    self._stamps.append(int(m.group(1)) if m else None)
                    if len(self._stamps) > 4 * self.fps:   # lost track of which is which: start over
                        self._stamps.clear()
                # An access-unit delimiter after the frame tells the decoder it is
                # complete, so it decodes it now instead of when the next one comes.
                self.dec.stdin.write(data + AUD)
        except (OSError, ValueError) as exc:
            self._fail(f"decoder input: {exc}")

    # ------------------------------------------------------------------ process
    def _read_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.dec.stdout.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return bytes(buf)

    def _process(self):
        w, h = self.w, self.h
        size = w * h * 3 // 2
        tw = TRACK_W
        th = max(2, round(h * tw / w))
        scale = w / tw
        prev = None
        traj = np.zeros(3)                 # accumulated x, y (pixels), angle (radians)
        frames = deque()                   # (yuv bytes, stamp, trajectory)
        path = deque()                     # trajectories, for the smoothing window
        try:
            while not self.stop.is_set():
                raw = self._read_exact(size)
                if raw is None:
                    if not self.stop.is_set():
                        self._fail("the decoder stopped")
                    return
                t0 = time.perf_counter()
                with self._in_cv:
                    stamp = self._stamps.popleft() if self._stamps else None
                y = np.frombuffer(raw, np.uint8, w * h).reshape(h, w)
                small = cv2.resize(y, (tw, th), interpolation=cv2.INTER_AREA)
                if prev is not None:
                    traj = traj + self._motion(prev, small, scale)
                prev = small
                frames.append((raw, stamp, traj.copy()))
                path.append(traj.copy())
                ahead = self._delay_frames()
                while len(frames) > ahead:
                    i = len(path) - len(frames)        # index of the frame to send, in path
                    raw_i, stamp_i, traj_i = frames.popleft()
                    self._send(self._warp(raw_i, self._correction(path, i, ahead, traj_i)), stamp_i)
                keep = 3 * max(ahead, 4) + 1
                while len(path) > keep + len(frames):
                    path.popleft()
                self.process_ms = 0.9 * self.process_ms + 0.1 * (time.perf_counter() - t0) * 1000
        except Exception as exc:               # never let a bad frame take the video down
            self._fail(f"processing: {exc}")

    def _motion(self, prev, cur, scale):
        """Shift (pixels at full size) and rotation from prev to cur; zero if it can't tell."""
        pts = cv2.goodFeaturesToTrack(prev, maxCorners=150, qualityLevel=0.01, minDistance=8, blockSize=7)
        if pts is None or len(pts) < 8:
            return np.zeros(3)
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
        ok = st.reshape(-1) == 1
        if ok.sum() < 8:
            return np.zeros(3)
        m, inliers = cv2.estimateAffinePartial2D(pts[ok], nxt[ok], method=cv2.RANSAC,
                                                 ransacReprojThreshold=2.0)
        if m is None or inliers is None or inliers.sum() < 6:
            return np.zeros(3)
        da = np.arctan2(m[1, 0], m[0, 0])
        # The shift of the picture's centre: m's own shift is about the top-left
        # corner, where any roll would also read as a big sideways move.
        c = np.array([prev.shape[1] / 2.0, prev.shape[0] / 2.0])
        shift = m[:, :2] @ c + m[:, 2] - c
        return np.array([shift[0] * scale, shift[1] * scale, da])

    def _correction(self, path, i, ahead, traj_i):
        """(smoothed path − real path) at frame i, held inside the crop margin."""
        radius = max(ahead, 1)
        lo, hi = max(0, i - radius), min(len(path), i + radius + 1)
        window = np.array([path[k] for k in range(lo, hi)])
        sigma = max(1.0, radius / 2.0)
        wts = np.exp(-0.5 * ((np.arange(lo, hi) - i) / sigma) ** 2)
        smooth = (window * wts[:, None]).sum(axis=0) / wts.sum()
        corr = smooth - traj_i
        margin = self._crop_pct() / 100.0 / 2.0
        corr[0] = np.clip(corr[0], -margin * self.w, margin * self.w)
        corr[1] = np.clip(corr[1], -margin * self.h, margin * self.h)
        corr[2] = np.clip(corr[2], -MAX_ROT, MAX_ROT)
        return corr

    def _warp(self, raw, corr):
        w, h = self.w, self.h
        zoom = 1.0 + self._crop_pct() / 100.0
        # Turn by the correction about the centre (getRotationMatrix2D counts angles
        # the other way round from the measured motion), zoom in to hide the
        # edges, and move by the correction.
        m = cv2.getRotationMatrix2D((w / 2, h / 2), -np.rad2deg(corr[2]), zoom)
        m[:, 2] += m[:, :2] @ corr[:2]
        yuv = np.frombuffer(raw, np.uint8)
        y = yuv[:w * h].reshape(h, w)
        u = yuv[w * h:w * h * 5 // 4].reshape(h // 2, w // 2)
        v = yuv[w * h * 5 // 4:].reshape(h // 2, w // 2)
        mc = m.copy()
        mc[:, 2] /= 2                      # the colour planes are half size
        out = np.empty_like(yuv)
        out[:w * h] = cv2.warpAffine(y, m, (w, h), flags=cv2.INTER_LINEAR,
                                     borderMode=cv2.BORDER_REPLICATE).reshape(-1)
        out[w * h:w * h * 5 // 4] = cv2.warpAffine(u, mc, (w // 2, h // 2), flags=cv2.INTER_LINEAR,
                                                   borderMode=cv2.BORDER_REPLICATE).reshape(-1)
        out[w * h * 5 // 4:] = cv2.warpAffine(v, mc, (w // 2, h // 2), flags=cv2.INTER_LINEAR,
                                              borderMode=cv2.BORDER_REPLICATE).reshape(-1)
        return out.tobytes()

    # ------------------------------------------------------------------ out
    def _send(self, yuv, stamp):
        with self._in_cv:
            self._out_stamps.append(stamp)
        try:
            self.enc.stdin.write(yuv)
        except (OSError, ValueError) as exc:
            self._fail(f"encoder input: {exc}")

    def _read_encoded(self):
        # The encoder writes each frame in one go: when its output goes quiet
        # for a few ms the frame is complete, and goes out now rather than when
        # the next frame starts (a frame's time later).
        q = queue.Queue()

        def pump():
            try:
                while True:
                    c = self.enc.stdout.read(65536)
                    q.put(c)
                    if not c:
                        return
            except (OSError, ValueError):
                q.put(b"")
        threading.Thread(target=pump, name="stab-enc-read", daemon=True).start()
        flush = getattr(self.splitter, "flush", None)
        try:
            while not self.stop.is_set():
                try:
                    chunk = q.get(timeout=0.004)
                except queue.Empty:
                    if flush is not None:
                        flush()
                    chunk = q.get()
                if not chunk:
                    if not self.stop.is_set():
                        self._fail("the encoder stopped")
                    return
                self.splitter.feed(chunk)
        except (OSError, ValueError) as exc:
            self._fail(f"encoder output: {exc}")

    def _encoded(self, data, keyframe, sps):
        with self._in_cv:
            stamp = self._out_stamps.popleft() if self._out_stamps else None
        if stamp is not None:
            data = sei_stamp(stamp) + data
            came = self._arrived.pop(stamp, None)
            if came is not None:
                self._check_behind(time.perf_counter() - came)
                if self.failed:
                    return
        self.frames_out += 1
        self.on_frame(data, keyframe, sps)

    def _check_behind(self, lag_s):
        """A computer busy with other work (AI detection in the browser) can't
        keep up with decoding and re-encoding: the video would fall seconds
        behind. Then the phone's own video goes on, without stabilisation."""
        self.behind_ms = 0.8 * self.behind_ms + 0.2 * lag_s * 1000
        now = time.perf_counter()
        if self.behind_ms < MAX_BEHIND_S * 1000:
            self._behind_since = None
        elif self._behind_since is None:
            self._behind_since = now
        elif now - self._behind_since > BEHIND_FOR_S:
            self._fail(f"this computer is too busy: it fell {self.behind_ms / 1000:.1f} s behind")

    # ------------------------------------------------------------------ stop
    def _fail(self, why):
        if not self.failed and not self.stop.is_set():
            log.warning("Stabilisation stopped (%s); the video goes on without it", why)
        self.failed = True
        self.close()

    def close(self):
        self.stop.set()
        with self._in_cv:
            self._in_cv.notify_all()
        for p in (self.dec, self.enc):
            try:
                p.kill()
            except Exception:
                pass

