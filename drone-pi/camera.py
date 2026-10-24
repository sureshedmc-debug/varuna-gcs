"""
Drone camera: 1280x720, served to the app as H.264 (camera module) or MJPEG.

One capture process feeds every viewer. It is the lightest way to get 720p
out of a Raspberry Pi 3:

  * Pi camera module (CSI) → rpicam-vid (or libcamera-vid on older OS) with the
    Pi's hardware H.264 encoder (camera_codec = h264, the default): about a
    third of MJPEG's bandwidth and half its CPU. The app decodes it in the
    browser (WebCodecs) from /api/camera/h264. camera_codec = mjpeg makes
    rpicam-vid encode MJPEG instead.
  * USB webcam  → ffmpeg asks the camera for its own MJPEG at 1280x720/30 and
    copies the frames through untouched (no decoding or re-encoding on the Pi).
    If the camera can't do MJPEG at that size, it falls back to raw YUYV that
    ffmpeg encodes (heavier), then to 640x480.
  * test → a generated test picture (laptop testing / no camera), in H.264 or
    MJPEG like the camera module.

With H.264, /video_feed and /api/camera/snapshot still get JPEGs: while
someone watches /video_feed (browsers without WebCodecs) ffmpeg decodes the
stream to JPEGs, and a snapshot decodes the latest keyframe.

camera_source "auto" (the default) uses whichever camera is there: the USB
webcam if one is plugged in, else the camera module. If the one in use fails
or is unplugged it switches to the other by itself, and changing
camera_source or camera_quality live (System → Live tuning in the app)
restarts the capture with the new setting.

An MJPEG process's output is a stream of JPEGs; each frame is cut out at its
start (FFD8) and end (FFD9) markers. An H.264 one is cut into frames at its NAL
units (H264Splitter). The latest frames are kept for every viewer. If the
process dies (camera unplugged), it is restarted every few seconds.
"""

import glob
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque

log = logging.getLogger("drone.camera")

SOI, EOI = b"\xff\xd8", b"\xff\xd9"
STALL_S = 10          # restart a capture process that sends nothing for this long
IDLE_S = 30           # camera off this long after the last viewer left (less heat); back on in ~2 s
START_WAIT_S = 8      # how long a snapshot waits for the camera to come out of standby
ENCODE_LAG_S = 0.1    # camera module: exposure → encoded frame on the pipe (ISP + encoder, roughly)
CSI_CHECK_S = 30      # how long a "camera module there or not" answer is trusted
FAILED_SKIP_S = 60    # auto: after a camera fails every setting, prefer the other one this long
H264_KEEP = 120       # H.264 frames kept for viewers (a few seconds)
JPEG_DEMAND_S = 10    # H.264: keep decoding it to JPEG for /video_feed this long after the last request
START4 = b"\x00\x00\x00\x01"

# Standard JPEG Huffman tables (ITU-T T.81, Annex K.3). Many USB webcams leave
# them out of their MJPEG frames ("AVI1" style); browsers usually cope, but
# image viewers and some decoders don't, so missing tables are put back.
_BITS_DC_L = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
_VALS_DC = list(range(12))
_BITS_DC_C = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
_BITS_AC_L = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D]
_VALS_AC_L = bytes.fromhex(
    "01020300041105122131410613516107227114328191a1082342b1c11552d1f0"
    "2433627282090a161718191a25262728292a3435363738393a43444546474849"
    "4a535455565758595a636465666768696a737475767778797a83848586878889"
    "8a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5"
    "c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8"
    "f9fa")
_BITS_AC_C = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]
_VALS_AC_C = bytes.fromhex(
    "000102031104052131061241510761711322328108144291a1b1c109233352f0"
    "156272d10a162434e125f11718191a262728292a35363738393a434445464748"
    "494a535455565758595a636465666768696a737475767778797a828384858687"
    "88898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3"
    "c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8"
    "f9fa")


def _dht_segment():
    body = b""
    for cls_id, bits, vals in ((0x00, _BITS_DC_L, bytes(_VALS_DC)), (0x01, _BITS_DC_C, bytes(_VALS_DC)),
                               (0x10, _BITS_AC_L, _VALS_AC_L), (0x11, _BITS_AC_C, _VALS_AC_C)):
        assert sum(bits) == len(vals), "corrupt Huffman table"
        body += bytes([cls_id]) + bytes(bits) + vals
    return b"\xff\xc4" + (len(body) + 2).to_bytes(2, "big") + body


DHT = _dht_segment()


def ensure_dht(frame):
    """Insert the standard Huffman tables if the frame has none (before start-of-scan)."""
    sos = frame.find(b"\xff\xda")
    if sos == -1 or frame.find(b"\xff\xc4", 0, sos) != -1:
        return frame
    return frame[:2] + DHT + frame[2:]


def iter_jpegs(stream, stop):
    """JPEG frames from an MJPEG byte stream, cut at their FFD8 / FFD9 markers."""
    buf = bytearray()
    while not stop.is_set():
        chunk = stream.read(65536)
        if not chunk:
            return
        buf += chunk
        while True:
            start = buf.find(SOI)
            if start == -1:
                buf.clear()
                break
            end = buf.find(EOI, start + 2)
            if end == -1:
                if start:
                    del buf[:start]
                if len(buf) > 8_000_000:   # garbage; resync
                    buf.clear()
                break
            frame = bytes(buf[start:end + 2])
            del buf[:end + 2]
            yield frame


def h264_codec_string(sps):
    """The WebCodecs name of the stream ("avc1.PPCCLL") from its SPS NAL unit
    (without start code): profile, constraint flags and level."""
    return "avc1." + bytes(sps[1:4]).hex().upper()


class H264Splitter:
    """Cuts an Annex-B H.264 byte stream into frames (access units) and calls
    on_frame(data, keyframe, sps) for each, data with 4-byte start codes. A
    frame is only known to be complete when the next one starts, so each is
    handed on one frame late."""

    def __init__(self, on_frame):
        self.on_frame = on_frame
        self.buf = bytearray()
        self.scan = 3            # where the search for the next start code resumes
        self.synced = False
        self.nals = []           # the frame being collected
        self.has_slice = False
        self.key = False
        self.sps = None
        self.frames = 0

    def feed(self, chunk):
        buf = self.buf
        buf += chunk
        if not self.synced:
            i = buf.find(b"\x00\x00\x01")
            if i == -1:
                del buf[:max(0, len(buf) - 2)]
                return
            del buf[:i]
            self.synced, self.scan = True, 3
        # buf starts at a 3-byte start code; each one after it ends a NAL unit.
        while True:
            j = buf.find(b"\x00\x00\x01", self.scan)
            if j == -1:
                self.scan = max(3, len(buf) - 3)
                if len(buf) > 8_000_000:              # garbage: resync
                    buf.clear()
                    self.synced = False
                return
            # Trailing zeros belong to the next start code (00 00 00 01) or are padding.
            self._nal(bytes(buf[3:j]).rstrip(b"\x00"))
            del buf[:j]
            self.scan = 3

    def _nal(self, nal):
        if not nal:
            return
        kind = nal[0] & 0x1F
        is_slice = kind in (1, 5)
        # A new frame starts at an SEI / SPS / PPS / AUD, or at a slice that begins
        # a picture (first_mb_in_slice = 0, so its first bit is 1).
        if self.has_slice and (kind in (6, 7, 8, 9) or (is_slice and len(nal) > 1 and nal[1] & 0x80)):
            self._emit()
        if kind == 9:
            return                                    # AUDs are dropped
        if kind == 7:
            self.sps = nal
        self.nals.append(START4 + nal)
        if is_slice:
            self.has_slice = True
            self.key = self.key or kind == 5

    def _emit(self):
        self.frames += 1
        self.on_frame(b"".join(self.nals), self.key, self.sps if self.key else None)
        self.nals, self.has_slice, self.key = [], False, False


# ffmpeg input options for H.264 piped in frame by frame. Small reads (-blocksize)
# and minimal probing get each frame out one frame late; the defaults, or
# -fflags nobuffer, hold back ~16 frames (a second).
FF_H264_IN = ["-blocksize", "512", "-flags", "low_delay", "-threads", "1", "-probesize", "32",
              "-analyzeduration", "0", "-f", "h264", "-i", "pipe:0"]


def h264_to_jpeg(ffmpeg, keyframe, timeout=5):
    """One JPEG from one H.264 keyframe (with its SPS/PPS), or None."""
    try:
        r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0",
                            "-frames:v", "1", "-q:v", "3", "-f", "mjpeg", "pipe:1"],
                           input=keyframe, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.stdout.startswith(SOI) else None


class H264Jpegs:
    """JPEGs decoded from the H.264 stream for /video_feed (browsers without
    WebCodecs). ffmpeg runs only while someone watches it."""

    def __init__(self, ffmpeg, publish):
        self.ffmpeg, self.publish = ffmpeg, publish
        self.wanted_at = 0.0
        self._queue = deque()
        self._skip = True          # decoding must start at a keyframe
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._thread = None

    def want(self):
        self.wanted_at = time.time()
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._queue.clear()
                self._skip = True
                self._thread = threading.Thread(target=self._run, name="camera-jpeg", daemon=True)
                self._thread.start()

    def wanted(self):
        return time.time() - self.wanted_at < JPEG_DEMAND_S

    def offer(self, data, keyframe):
        if not self.wanted():
            return
        with self._lock:
            if len(self._queue) >= 8:          # ffmpeg can't keep up: drop to the next keyframe
                self._queue.clear()
                self._skip = True
            if self._skip and not keyframe:
                return
            self._skip = False
            self._queue.append(data)
        self._event.set()

    def _next(self):
        with self._lock:
            return self._queue.popleft() if self._queue else None

    def _run(self):
        cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error"] + FF_H264_IN + \
              ["-f", "mjpeg", "-q:v", "5", "-flush_packets", "1", "pipe:1"]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, bufsize=0)
        except OSError as exc:
            log.warning("Camera: cannot start ffmpeg to make JPEGs: %s", exc)
            return
        stop = threading.Event()

        def read():
            for jpeg in iter_jpegs(proc.stdout, stop):
                self.publish(jpeg)

        threading.Thread(target=read, name="camera-jpeg-out", daemon=True).start()
        try:
            while self.wanted() and proc.poll() is None:
                if not self._event.wait(1.0):
                    continue
                self._event.clear()
                while (data := self._next()) is not None:
                    proc.stdin.write(data)
        except OSError:
            pass
        finally:
            stop.set()
            try:
                proc.kill()
            except Exception:
                pass


def _is_usb_node(dev):
    """True if /dev/videoN belongs to a USB device. With the camera module
    enabled, /dev/video0 is the Pi's own CSI receiver, not a webcam."""
    sys_dev = f"/sys/class/video4linux/{os.path.basename(dev)}/device"
    if not os.path.exists(sys_dev):
        return True                                        # no sysfs (not Linux): trust the name
    return "/usb" in os.path.realpath(sys_dev)


def find_usb_camera():
    """First USB video capture device, by its stable /dev/v4l/by-id name."""
    for path in sorted(glob.glob("/dev/v4l/by-id/*-video-index0")):
        return os.path.realpath(path)
    # /dev/video10+ are the Pi's codecs and ISP.
    for path in sorted(glob.glob("/dev/video[0-9]"), key=lambda p: int(p[10:])):
        if _is_usb_node(path):
            return path
    return None


def find_csi_tool():
    for name in ("rpicam-vid", "libcamera-vid"):
        p = shutil.which(name)
        if p:
            return p
    return None


_csi_cache = {"at": 0.0, "present": None}


def csi_camera_present(max_age=CSI_CHECK_S):
    """True if a camera module is connected. Asking means starting rpicam-hello,
    so the answer is reused for max_age seconds."""
    if _csi_cache["present"] is not None and time.time() - _csi_cache["at"] < max_age:
        return _csi_cache["present"]
    present = False
    hello = shutil.which("rpicam-hello") or shutil.which("libcamera-hello")
    if hello:
        try:
            out = subprocess.run([hello, "--list-cameras"], capture_output=True, text=True, timeout=15)
            present = "Available cameras" in out.stdout and "No cameras available" not in out.stdout
        except (OSError, subprocess.SubprocessError):
            present = False
    _csi_cache.update(at=time.time(), present=present)
    return present


class CameraManager:
    def __init__(self, cfg):
        self.cfg = cfg
        self._stop = threading.Event()
        self._thread = None
        self._proc = None
        self._cond = threading.Condition()
        self.frame = None
        self.frame_seq = 0
        self.frames_captured = 0
        self._stamps = deque(maxlen=60)
        self.status_text = "STARTING"
        self.last_error = None
        self.source = None
        self.device = None
        self.pipeline = None
        self.resolution = None
        self.started_at = None
        self._setting = None       # the settings the capture was started with (_setting_key)
        self._failed_at = {}       # source → when every setting of it last failed
        self.codec = None          # "h264" or "mjpeg": what the running capture sends
        self._sizes = deque(maxlen=120)                  # (time, bytes) of recent frames
        self._h264 = deque(maxlen=H264_KEEP)             # (seq, keyframe, capture time µs, Annex-B data)
        self.h264_seq = 0
        self.h264_codec = None     # WebCodecs codec name, from the stream's SPS
        self._jpegs = H264Jpegs(cfg["ffmpeg_path"], self._publish_jpeg)
        self._jpeg_at = 0.0
        self._capture_lag = 0.0
        # The camera only runs while someone watches (video streams, snapshots):
        # camera + encoder running nonstop is what heats the Pi. It runs for the
        # first IDLE_S after start, so a missing camera shows up in the status.
        self._demand_at = time.time()
        self._demand = threading.Event()
        self._was_ok = False       # the last capture delivered pictures (standby still counts as connected)

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        # The thread runs even when the camera is "off", so turning it on from
        # the app later needs no restart.
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._kill()
        if self._thread:
            self._thread.join(timeout=3)

    def _kill(self):
        p, self._proc = self._proc, None
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    # ------------------------------------------------------------------ pipelines
    def _attempts(self):
        """Capture commands to try, best first, for the configured source:
        (name, resolution, command, "h264" or "mjpeg")."""
        w, h, fps = self.cfg["camera_width"], self.cfg["camera_height"], self.cfg["camera_fps"]
        q = self.cfg["camera_quality"]
        ff = self.cfg["ffmpeg_path"]
        base = [ff, "-hide_banner", "-loglevel", "error", "-nostdin"]
        out = ["-f", "mjpeg", "-flush_packets", "1", "pipe:1"]
        # ffmpeg's -q:v runs 2 (best) … 31 (worst); map quality 0-100 onto it.
        qv = str(max(2, min(31, round(31 - q * 0.29))))
        # H.264 frames can't be skipped for a slow viewer the way JPEGs can, so the
        # camera itself runs at the stream rate. A keyframe every second lets a
        # viewer join or recover from a lost frame quickly without spending much
        # of the bitrate on keyframes (they are several times bigger).
        h264 = self.cfg["camera_codec"] == "h264"
        sfps = max(1, min(fps, self.cfg["stream_fps"]))
        intra = max(5, sfps)
        kbps = self.cfg["video_bitrate_kbps"]
        source = self.cfg["camera_source"]
        if source == "auto":
            source = self._auto_source()
            if not source:
                return "none", None, []
        if source == "test":
            mjpeg = ("test pattern", f"{w}x{h}",
                     base + ["-re", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}",
                             "-c:v", "mjpeg", "-q:v", qv] + out, "mjpeg")
            if not h264:
                return "test", "testsrc", [mjpeg]
            return "test", "testsrc", [
                ("test pattern H.264", f"{w}x{h}",
                 base + ["-re", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={sfps}", "-c:v", "libx264",
                         "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "high", "-g", str(intra),
                         "-bf", "0", "-b:v", f"{kbps}k", "-x264-params", "repeat-headers=1",
                         "-f", "h264", "-flush_packets", "1", "pipe:1"], "h264"),
                mjpeg,
            ]
        if source == "csi":
            tool = find_csi_tool()
            if not tool:
                return "csi", None, []

            def vid(codec, width, height, extra):
                return [tool, "-t", "0", "-n", "--codec", codec, "--width", str(width), "--height", str(height)] \
                    + extra + ["--flush", "-o", "-"]

            h264_args = ["--framerate", str(sfps), "--bitrate", str(kbps * 1000), "--intra", str(intra),
                         "--inline", "--profile", "high", "--level", "4.1"]
            mjpegs = [
                ("camera module MJPEG", f"{w}x{h}",
                 vid("mjpeg", w, h, ["--framerate", str(fps), "--quality", str(q)]), "mjpeg"),
                ("camera module MJPEG", "640x480", vid("mjpeg", 640, 480, ["--framerate", str(fps)]), "mjpeg"),
            ]
            if not h264:
                return "csi", "camera module", mjpegs
            # If the hardware encoder won't start, MJPEG still works.
            return "csi", "camera module", [
                ("camera module H.264", f"{w}x{h}", vid("h264", w, h, h264_args), "h264"),
                ("camera module H.264", "640x480", vid("h264", 640, 480, h264_args), "h264"),
            ] + mjpegs
        dev = self.cfg["camera_device"]
        dev = find_usb_camera() if dev in ("", "auto") else dev
        if not dev:
            return "usb", None, []
        v4l = base + ["-f", "v4l2", "-thread_queue_size", "64"]
        # USB webcams stay MJPEG: their own JPEGs pass through with no work on the Pi,
        # and the Pi 3's encoder couldn't keep up with re-encoding them as well.
        return "usb", dev, [
            ("USB camera MJPEG (pass-through)", f"{w}x{h}",
             v4l + ["-input_format", "mjpeg", "-video_size", f"{w}x{h}", "-framerate", str(fps), "-i", dev,
                    "-c:v", "copy"] + out, "mjpeg"),
            ("USB camera raw → MJPEG", f"{w}x{h}",
             v4l + ["-input_format", "yuyv422", "-video_size", f"{w}x{h}", "-framerate", str(fps), "-i", dev,
                    "-c:v", "mjpeg", "-q:v", qv] + out, "mjpeg"),
            ("USB camera MJPEG (pass-through)", "640x480",
             v4l + ["-input_format", "mjpeg", "-video_size", "640x480", "-i", dev, "-c:v", "copy"] + out, "mjpeg"),
            ("USB camera raw → MJPEG", "640x480",
             v4l + ["-video_size", "640x480", "-i", dev, "-c:v", "mjpeg", "-q:v", qv] + out, "mjpeg"),
        ]

    def _auto_source(self):
        """auto: the USB webcam if one is plugged in, else the camera module. A
        camera that just failed every setting goes behind the other one."""
        usb = bool(find_usb_camera())
        csi = bool(find_csi_tool()) and csi_camera_present()
        order = ["usb", "csi"]
        if usb and csi and time.time() - self._failed_at.get("usb", 0.0) < FAILED_SKIP_S:
            order.reverse()
        for source in order:
            if usb if source == "usb" else csi:
                return source
        return None

    def _run(self):
        attempt_index = 0
        last = None
        while not self._stop.is_set():
            setting = self.cfg["camera_source"]
            self._setting = self._setting_key()
            if setting == "off":
                self.source = self.device = self.pipeline = self.resolution = self.codec = None
                self.status_text = "OFF"
                self.last_error = "The camera is turned off (camera_source = off)."
                self._stop.wait(2)
                continue
            if self._idle():
                self._standby()
                continue
            source, device, attempts = self._attempts()
            if (setting, source) != last:          # another camera: start from its best setting
                attempt_index, last = 0, (setting, source)
            self.source, self.device = source, device
            if not attempts:
                self._was_ok = False
                self.status_text = "NO CAMERA"
                self.last_error = {
                    "none": "No camera found. Plug in a USB webcam or connect the Pi camera module — whichever is there is used automatically.",
                    "csi": "rpicam-vid / libcamera-vid is not installed, or no camera module is connected.",
                    "usb": "No USB camera found.",
                }.get(source, "No camera found.")
                self._stop.wait(5)
                continue
            name, res, cmd, fmt = attempts[attempt_index % len(attempts)]
            self.codec = fmt
            self._setting = self._setting_key()
            ok = self._capture(name, res, cmd, fmt)
            if self._stop.is_set():
                break
            if self._setting_changed() or self._idle():
                continue                           # settings changed in the app, or nobody watching
            if not ok:
                attempt_index += 1                 # this setting doesn't work: try the next one
                if attempt_index % len(attempts) == 0:
                    self._failed_at[source] = time.time()
                    if source == "csi":
                        _csi_cache["present"] = None   # re-check: maybe it was unplugged
                    self._was_ok = False
                    self.status_text = "ERROR"
                    self._stop.wait(5)             # all failed: wait, then start over
            else:
                _csi_cache["present"] = None       # it was streaming and stopped: re-check, retry
                self._stop.wait(2)

    def touch(self):
        """A viewer wants pictures: keep the camera on (start it if in standby)."""
        self._demand_at = time.time()
        self._demand.set()

    def _idle(self):
        return time.time() - self._demand_at > IDLE_S

    def _standby(self):
        if self.status_text != "STANDBY":
            log.info("Camera: nobody watching for %d s — camera off until someone does", IDLE_S)
            with self._cond:
                self._h264.clear()             # old frames must not reach the next viewer
                self.frame = None
            self.status_text = "STANDBY"
        self._demand.wait(2)
        self._demand.clear()

    def _setting_key(self):
        key = (self.cfg["camera_source"], self.cfg["camera_quality"], self.cfg["camera_codec"])
        if self.codec == "h264":
            key += (self.cfg["video_bitrate_kbps"], self.cfg["stream_fps"])
        return key

    def _setting_changed(self):
        return self._setting_key() != self._setting

    def _capture(self, name, res, cmd, fmt):
        """Run one capture process until it ends. True if it produced frames."""
        log.info("Camera: starting %s at %s", name, res)
        self.pipeline, self.resolution = name, res
        self.status_text = "STARTING"
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        except OSError as exc:
            self.last_error = f"Cannot start {cmd[0]}: {exc}"
            log.warning(self.last_error)
            return False
        proc = self._proc
        errlines = deque(maxlen=6)
        threading.Thread(target=self._drain_stderr, args=(proc, errlines), daemon=True).start()
        self.started_at = time.time()
        # A capture process can hang without exiting (camera unplugged mid-stream):
        # the read below would then block forever and the video never come back.
        threading.Thread(target=self._watchdog, args=(proc,), daemon=True).start()
        stream = proc.stdout
        if fmt == "h264":
            with self._cond:
                self._h264.clear()             # frames of an earlier stream can't be mixed in
            # A frame is complete only when the next one starts arriving (one frame
            # period later), and it reached the pipe ENCODE_LAG_S after its exposure.
            self._capture_lag = 1.0 / max(1, min(self.cfg["camera_fps"], self.cfg["stream_fps"])) + ENCODE_LAG_S
            splitter = H264Splitter(self._publish_h264)
            while not self._stop.is_set():
                chunk = stream.read(65536)
                if not chunk:
                    break
                splitter.feed(chunk)
            got = splitter.frames
        else:
            got = 0
            for frame in iter_jpegs(stream, self._stop):
                self._publish(ensure_dht(frame))
                got += 1
        self._kill()
        if errlines:
            self.last_error = " ".join(errlines)[-300:]
        if got:
            log.warning("Camera stream ended after %d frames: %s", got, self.last_error or "process exited")
            self.status_text = "RECONNECTING"
        else:
            log.warning("Camera: %s at %s failed: %s", name, res, self.last_error or "no frames")
        return got > 0

    def _watchdog(self, proc):
        """Kill the capture process if it stops delivering frames (STALL_S), so
        _capture's blocking read returns and the camera is restarted."""
        while proc.poll() is None and not self._stop.is_set():
            time.sleep(1)
            if self._idle():
                try:
                    proc.kill()
                except Exception:
                    pass
                return
            if self._setting_changed():
                log.info("Camera: settings changed to %s — restarting the capture", self._setting_key())
                try:
                    proc.kill()
                except Exception:
                    pass
                return
            last = self._stamps[-1] if self._stamps else 0.0
            if time.time() - max(last, self.started_at or 0.0) > STALL_S:
                log.warning("Camera: no frames for %d s — restarting the capture", STALL_S)
                self.last_error = f"The camera stopped sending pictures for {STALL_S} s (unplugged?)."
                try:
                    proc.kill()
                except Exception:
                    pass
                return

    @staticmethod
    def _drain_stderr(proc, errlines):
        try:
            for raw in iter(proc.stderr.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    errlines.append(line)
        except Exception:
            pass

    def _captured(self, now, size):
        """Bookkeeping for a frame from the camera (called holding _cond)."""
        self._was_ok = True
        self.frames_captured += 1
        self._stamps.append(now)
        self._sizes.append((now, size))
        self.status_text = "STREAMING"
        self.last_error = None

    def _publish(self, frame):
        with self._cond:
            self._captured(time.time(), len(frame))
            self.frame = frame
            self.frame_seq += 1
            self._cond.notify_all()

    def _publish_jpeg(self, frame):
        """A JPEG decoded from the H.264 stream."""
        with self._cond:
            self._jpeg_at = time.time()
            self.frame = frame
            self.frame_seq += 1
            self._cond.notify_all()

    def _publish_h264(self, data, keyframe, sps):
        now = time.time()
        with self._cond:
            self._captured(now, len(data))
            if sps:
                self.h264_codec = h264_codec_string(sps)
            self.h264_seq += 1
            # Stamped with when it was taken (estimated), to look up the drone's pose then.
            self._h264.append((self.h264_seq, keyframe, int((now - self._capture_lag) * 1e6), data))
            self._cond.notify_all()
        self._jpegs.offer(data, keyframe)

    # ------------------------------------------------------------------ consumers
    def wait_frame(self, after_seq, timeout=2.0):
        """Block until a frame newer than after_seq exists. Returns (seq, jpeg) or (after_seq, None)."""
        with self._cond:
            if self.frame_seq <= after_seq:
                self._cond.wait(timeout)
            if self.frame_seq > after_seq and self.frame is not None:
                return self.frame_seq, self.frame
            return after_seq, None

    def want_jpeg(self):
        """With H.264, JPEGs for /video_feed are only made while it is watched:
        call this at least every JPEG_DEMAND_S while you need them."""
        if self.codec == "h264":
            self._jpegs.want()

    def _latest_keyframe(self):
        with self._cond:
            return next((f[3] for f in reversed(self._h264) if f[1]), None)

    def wait_h264(self, after_seq, timeout=2.0):
        """H.264 frames newer than after_seq, oldest first, waiting up to timeout
        for one: a list of (seq, keyframe, time µs, data)."""
        with self._cond:
            if not self._h264 or self._h264[-1][0] <= after_seq:
                self._cond.wait(timeout)
            out = []
            for f in reversed(self._h264):
                if f[0] <= after_seq:
                    break
                out.append(f)
            out.reverse()
            return out

    def snapshot(self):
        self.touch()
        deadline = time.time() + START_WAIT_S
        while not self._live() and time.time() < deadline and self.status_text not in ("NO CAMERA", "ERROR", "OFF"):
            time.sleep(0.2)                    # coming out of standby
        if not self._live():
            return None
        if self.codec != "h264":
            return self.frame
        if self._jpegs.wanted() and self.frame is not None and time.time() - self._jpeg_at < 1.0:
            return self.frame                  # /video_feed is being decoded: its latest picture
        key = self._latest_keyframe()
        return h264_to_jpeg(self.cfg["ffmpeg_path"], key) if key else None

    def _live(self):
        return bool(self._stamps) and (time.time() - self._stamps[-1]) < 3.0

    @property
    def connected(self):
        """Pictures now, or in standby after a capture that worked."""
        return self._live() or (self._was_ok and self.status_text in ("STANDBY", "STARTING"))

    def stream_kbps(self):
        now = time.time()
        recent = [(t, n) for t, n in self._sizes if now - t < 3.0]
        if len(recent) < 2:
            return 0
        return round(sum(n for _, n in recent) * 8 / 1000 / max(recent[-1][0] - recent[0][0], 1.0))

    def measured_fps(self):
        now = time.time()
        st = [t for t in self._stamps if now - t < 3.0]
        if len(st) < 2:
            return 0.0
        # At least a 1 s span, so the burst of buffered frames a camera emits
        # right after starting doesn't read as double the real rate.
        return round((len(st) - 1) / max(st[-1] - st[0], 1.0), 1)

    def available(self):
        """Cameras the Pi can see right now (the camera-module answer is the cached one)."""
        return {"usb": find_usb_camera(), "csi": bool(_csi_cache["present"])}

    def get_status(self):
        connected = bool(self.connected)
        return {
            "camera_connected": connected,
            "status_text": "STREAMING" if self._live() else self.status_text,
            "standby": self.status_text == "STANDBY",
            "measured_fps": self.measured_fps(),
            "target": f"{self.cfg['camera_width']}x{self.cfg['camera_height']} @ {self.cfg['camera_fps']} fps",
            "resolution": self.resolution,
            "pipeline": self.pipeline,
            "codec": self.codec,
            "h264_codec": self.h264_codec if self.codec == "h264" else None,
            "stream_kbps": self.stream_kbps() if connected else 0,
            "camera_source": self.cfg["camera_source"],
            "source": self.source,
            "device": self.device,
            "available": self.available(),
            "frames_captured": self.frames_captured,
            "frame_bytes": len(self.frame) if self.frame else 0,
            "last_error": None if connected else self.last_error,
        }
