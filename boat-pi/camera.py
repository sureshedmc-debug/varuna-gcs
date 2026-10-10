"""
Boat camera (a USB webcam over the intake ramp), served to the app as MJPEG.

Shared with the drone backend (drone-pi/camera.py), with two boat changes:
every frame keeps the time it was captured (the app returns it with its
detections, so the Pi can look up where the boat was at that moment), and
"auto" tries a camera module before a USB webcam.

One capture process feeds every viewer, at the configured size and rate
(640x360; 15 fps, 10 on a Pi Zero):

  * USB webcam  → ffmpeg asks the camera for its own MJPEG and copies the
    frames through untouched — no decoding or re-encoding on the Pi, the
    lightest option for a Pi Zero. If the camera can't do MJPEG at that size,
    it falls back to raw YUYV that ffmpeg encodes (heavier), then to 640x480.
  * Pi camera module (CSI) → rpicam-vid (or libcamera-vid on older OS) encodes
    MJPEG in software.
  * test → a generated test picture (laptop testing / no camera).

The process's output is a stream of JPEGs; each frame is cut out at its start
(FFD8) and end (FFD9) markers. The latest frame is kept for /video_feed (all
viewers) and /api/camera/snapshot. If the process dies (camera unplugged), it
is restarted every few seconds.
"""

import glob
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque

log = logging.getLogger("boat.camera")

SOI, EOI = b"\xff\xd8", b"\xff\xd9"
STALL_S = 10          # restart a capture process that sends nothing for this long

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


def csi_camera_present():
    hello = shutil.which("rpicam-hello") or shutil.which("libcamera-hello")
    if not hello:
        return False
    try:
        out = subprocess.run([hello, "--list-cameras"], capture_output=True, text=True, timeout=15)
        return "Available cameras" in out.stdout and "No cameras available" not in out.stdout
    except (OSError, subprocess.SubprocessError):
        return False


class CameraManager:
    def __init__(self, cfg):
        self.cfg = cfg
        self._stop = threading.Event()
        self._thread = None
        self._proc = None
        self._cond = threading.Condition()
        self.frame = None
        self.frame_time = 0.0
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

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        if self.cfg["camera_source"] == "off":
            self.status_text = "OFF"
            return
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
        """Capture commands to try, best first, for the configured source."""
        w, h, fps = self.cfg["camera_width"], self.cfg["camera_height"], self.cfg["camera_fps"]
        q = self.cfg["camera_quality"]
        ff = self.cfg["ffmpeg_path"]
        base = [ff, "-hide_banner", "-loglevel", "error", "-nostdin"]
        out = ["-f", "mjpeg", "-flush_packets", "1", "pipe:1"]
        # ffmpeg's -q:v runs 2 (best) … 31 (worst); map quality 0-100 onto it.
        qv = str(max(2, min(31, round(31 - q * 0.29))))
        source = self.cfg["camera_source"]
        if source == "auto":
            if find_csi_tool() and csi_camera_present():
                source = "csi"
            elif find_usb_camera():
                source = "usb"
            else:
                return "none", None, []
        if source == "test":
            return "test", "testsrc", [
                ("test pattern", f"{w}x{h}", base + ["-re", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}",
                                                      "-c:v", "mjpeg", "-q:v", qv] + out),
            ]
        if source == "csi":
            tool = find_csi_tool()
            if not tool:
                return "csi", None, []
            return "csi", "camera module", [
                ("camera module MJPEG", f"{w}x{h}", [tool, "-t", "0", "-n", "--codec", "mjpeg", "--width", str(w),
                                                     "--height", str(h), "--framerate", str(fps),
                                                     "--quality", str(q), "--flush", "-o", "-"]),
                ("camera module MJPEG", "640x480", [tool, "-t", "0", "-n", "--codec", "mjpeg", "--width", "640",
                                                    "--height", "480", "--framerate", str(fps), "--flush", "-o", "-"]),
            ]
        dev = self.cfg["camera_device"]
        dev = find_usb_camera() if dev in ("", "auto") else dev
        if not dev:
            return "usb", None, []
        v4l = base + ["-f", "v4l2", "-thread_queue_size", "64"]
        return "usb", dev, [
            ("USB camera MJPEG (pass-through)", f"{w}x{h}",
             v4l + ["-input_format", "mjpeg", "-video_size", f"{w}x{h}", "-framerate", str(fps), "-i", dev,
                    "-c:v", "copy"] + out),
            ("USB camera raw → MJPEG", f"{w}x{h}",
             v4l + ["-input_format", "yuyv422", "-video_size", f"{w}x{h}", "-framerate", str(fps), "-i", dev,
                    "-c:v", "mjpeg", "-q:v", qv] + out),
            # Most webcams that don't offer 640x360 do offer 640x480. Ask for the frame
            # rate here too: left alone, many run at 30 fps — three times the data.
            ("USB camera MJPEG (pass-through)", "640x480",
             v4l + ["-input_format", "mjpeg", "-video_size", "640x480", "-framerate", str(fps), "-i", dev,
                    "-c:v", "copy"] + out),
            ("USB camera raw → MJPEG", "640x480",
             v4l + ["-video_size", "640x480", "-framerate", str(fps), "-i", dev, "-c:v", "mjpeg", "-q:v", qv] + out),
        ]

    def _run(self):
        attempt_index = 0
        while not self._stop.is_set():
            source, device, attempts = self._attempts()
            self.source, self.device = source, device
            if not attempts:
                self.status_text = "NO CAMERA"
                self.last_error = {
                    "none": "No camera found. Plug the USB camera into the Pi (on a Pi Zero: the micro-USB port marked USB, "
                            "not PWR, through an OTG adapter).",
                    "csi": "rpicam-vid / libcamera-vid is not installed, or no camera module is connected.",
                    "usb": "No USB camera found. Plug it into the Pi (on a Pi Zero: the micro-USB port marked USB, "
                           "not PWR, through an OTG adapter).",
                }.get(source, "No camera found.")
                self._stop.wait(5)
                continue
            name, res, cmd = attempts[attempt_index % len(attempts)]
            ok = self._capture(name, res, cmd)
            if self._stop.is_set():
                break
            if not ok:
                attempt_index += 1                 # this setting doesn't work: try the next one
                if attempt_index % len(attempts) == 0:
                    self.status_text = "ERROR"
                    self._stop.wait(5)             # all failed: wait, then start over
            else:
                self._stop.wait(2)                 # it was streaming and stopped: retry the same

    def _capture(self, name, res, cmd):
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
        got = 0
        buf = bytearray()
        self.started_at = time.time()
        # A capture process can hang without exiting (camera unplugged mid-stream):
        # the read below would then block forever and the video never come back.
        threading.Thread(target=self._watchdog, args=(proc,), daemon=True).start()
        stream = proc.stdout
        while not self._stop.is_set():
            chunk = stream.read(65536)
            if not chunk:
                break
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

    def _publish(self, frame):
        now = time.time()
        with self._cond:
            self.frame = frame
            self.frame_time = now
            self.frame_seq += 1
            self.frames_captured += 1
            self._stamps.append(now)
            self.status_text = "STREAMING"
            self.last_error = None
            self._cond.notify_all()

    # ------------------------------------------------------------------ consumers
    def wait_frame(self, after_seq, timeout=2.0):
        """Block until a frame newer than after_seq exists.
        Returns (seq, jpeg, capture_time) or (after_seq, None, 0)."""
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
        return self.frame is not None and self._stamps and (time.time() - self._stamps[-1]) < 3.0

    def measured_fps(self):
        now = time.time()
        st = [t for t in self._stamps if now - t < 3.0]
        if len(st) < 2:
            return 0.0
        # At least a 1 s span, so the burst of buffered frames a camera emits
        # right after starting doesn't read as double the real rate.
        return round((len(st) - 1) / max(st[-1] - st[0], 1.0), 1)

    def get_status(self):
        connected = bool(self.connected)
        return {
            "camera_connected": connected,
            "status_text": self.status_text if not connected else "STREAMING",
            "measured_fps": self.measured_fps(),
            "target": f"{self.cfg['camera_width']}x{self.cfg['camera_height']} @ {self.cfg['camera_fps']} fps",
            "resolution": self.resolution,
            "pipeline": self.pipeline,
            "source": self.source,
            "device": self.device,
            "frames_captured": self.frames_captured,
            "frame_bytes": len(self.frame) if self.frame else 0,
            "last_error": None if connected else self.last_error,
        }
