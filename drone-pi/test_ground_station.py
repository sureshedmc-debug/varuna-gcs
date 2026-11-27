"""
Tests for the ground-station path, on one computer with no Pi:

  camera.py     H.264 → RTP packets (RtpSender / rtp_packets), UdpFanout hello
  mav_link.py   GLOBAL_POSITION_INT → GPS JSON datagram on UDP
  ground_station.py  RTP → frames (incl. loss → next IDR) → PyAV decode → one
                slot; GPS track + interpolation; ONNX detector; geotag; dispatch

Real H.264 comes from ffmpeg (libx264, IDR every 15, no B-frames, headers
repeated - the Pi's settings). Ports 5100/5101 play the Pi, 5200/5201 the PC.

Run:  py -3 drone-pi/test_ground_station.py
"""

import os
import subprocess
import sys
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")   # a plain Windows console is cp1252
except Exception:
    pass
os.environ["VARUNA_RTP_PORT"] = "5100"
os.environ["VARUNA_GPS_PORT"] = "5101"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import camera                      # noqa: E402
import mav_link                    # noqa: E402
import ground_station as gs        # noqa: E402

PASS = FAIL = 0


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'  ' + str(extra) if extra and not ok else ''}")


def h264_frames(n=60):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
           f"testsrc2=size=640x480:rate=30", "-frames:v", str(n), "-c:v", "libx264", "-preset", "ultrafast",
           "-tune", "zerolatency", "-g", "15", "-bf", "0", "-b:v", "1000k", "-x264-params", "repeat-headers=1",
           "-f", "h264", "pipe:1"]
    data = subprocess.run(cmd, capture_output=True, check=True).stdout
    out = []
    sp = camera.H264Splitter(lambda d, k, s: out.append((d, k)))
    sp.feed(data)
    sp.flush()
    return out


# ------------------------------------------------------------------ 1. RTP round trip
frames = h264_frames(60)
check("ffmpeg made 60 frames, IDR every 15", len(frames) == 60 and [i for i, f in enumerate(frames) if f[1]] == [0, 15, 30, 45],
      [i for i, f in enumerate(frames) if f[1]])
T0 = 1_760_000_000_000_000
seq, ssrc = 65530, 0x1234
pkts_per_frame = []
dep = gs.RtpH264Depacketizer()
got = []
big = 0
for i, (data, key) in enumerate(frames):
    pk, seq = camera.rtp_packets(data, seq, (T0 + i * 33333) * 9 // 100, ssrc, T0 + i * 33333)
    pkts_per_frame.append(pk)
    big = max(big, max(len(p) for p in pk))
    for p in pk:
        got += dep.feed(p)
check("every packet fits the 1280-byte Tailscale MTU", big <= 1200 + 12 + 16, big)
check("an IDR is split into FU-A fragments", len(pkts_per_frame[0]) > 1, len(pkts_per_frame[0]))
check("all 60 frames rebuilt (seq wraps 65535→0)", len(got) == 60, len(got))
check("frames identical to what was sent", all(g[0] == f[0] for g, f in zip(got, frames)))
check("keyframe flags kept", [g[1] for g in got] == [f[1] for f in frames])
check("capture time (µs) carried in the header extension", [g[2] for g in got] == [T0 + i * 33333 for i in range(60)])

# ------------------------------------------------------------------ 2. a lost packet
dep = gs.RtpH264Depacketizer()
got = []
for i, pk in enumerate(pkts_per_frame):
    for j, p in enumerate(pk):
        if i == 5 and j == 0:
            continue                      # lost on the way
        got += dep.feed(p)
idx = [(g[2] - T0) // 33333 for g in got]
check("after a loss, frames resume at the next IDR (15)", idx == list(range(0, 5)) + list(range(15, 60)), idx[:8])
check("the loss is counted", dep.lost == 1, dep.lost)

import av                           # noqa: E402
ctx = av.CodecContext.create("h264", "r")
decoded = 0
for g in got:
    for fr in ctx.decode(av.Packet(g[0])):
        decoded += 1
        img = fr.to_ndarray(format="bgr24")
check("PyAV decodes every frame handed on (no corrupt ones)", decoded == len(got), (decoded, len(got)))
check("decoded size 640x480", img.shape == (480, 640, 3), img.shape)

# ------------------------------------------------------------------ 3. live over UDP: Pi RtpSender → PC FrameGrabber
touched = []
rtp = camera.RtpSender(on_viewer=lambda: touched.append(time.time()))
rtp.start()
slot = gs.LatestFrame()
pi = gs.PiAddress(["127.0.0.1"])
grab = gs.FrameGrabber(pi, 5200, slot, pi_port=5100)
grab.start()
t = time.time()
while not rtp.out.active() and time.time() - t < 3:
    time.sleep(0.05)
check("the PC's hello subscribes it on the Pi", rtp.out.active(), rtp.out.view())
check("a subscriber wakes the camera (counts as a viewer)", bool(touched))
for i, (data, key) in enumerate(frames):
    rtp.send(data, T0 + i * 33333)
    time.sleep(1 / 30)
time.sleep(0.3)
check("the PC decoded the live frames", grab.decoded >= 55, grab.decoded)
seq_, img, cap, rx = slot.wait_newer(0, 1.0)
check("the slot holds the newest frame only", cap == T0 + 59 * 33333, cap)
check("no decode errors", grab.errors == 0, grab.errors)

# ------------------------------------------------------------------ 4. GPS: mav_link → UDP JSON → GpsTrack
class Msg:
    def __init__(self, kind, **kw):
        self._k = kind
        self.__dict__.update(kw)

    def get_type(self):
        return self._k

    def get_srcSystem(self):
        return 1


link = mav_link.DroneLink({})
link.gps_out = camera.UdpFanout("GPS JSON", 5101, mav_link.GPS_HELLO, "VARUNA_GPS_TARGETS")
link.gps_out.start()
track = gs.GpsTrack(pi, 5201, pi_port=5101)
track.start()
t = time.time()
while not link.gps_out.active() and time.time() - t < 3:
    time.sleep(0.05)
check("GPS subscriber registered on the Pi", link.gps_out.active())
link._handle(Msg("GPS_RAW_INT", fix_type=3, satellites_visible=14, eph=80))
check("no datagram before a position (no fix yet)", track.count == 0)
lat0, lng0 = 28.6139000, 77.2090000
pi_times = []
for k in range(5):
    link._handle(Msg("GLOBAL_POSITION_INT", lat=int((lat0 + k * 1e-5) * 1e7), lon=int(lng0 * 1e7), alt=250000,
                     relative_alt=12000 + k * 100, vx=100, vy=0, vz=-20, hdg=9000))
    pi_times.append(time.time())
    time.sleep(0.1)
time.sleep(0.2)
check("GPS JSON received for each position", track.count >= 5, track.count)
last = track.latest()
check("JSON has lat/lng/alt/fix/sats/heading", last and abs(last["lat"] - (lat0 + 4e-5)) < 1e-7 and last["alt_rel"] == 12.4
      and last["fix"] == 3 and last["sats"] == 14 and last["hdg"] == 90.0, last)
mid = (pi_times[1] + pi_times[2]) / 2
fx = track.at(mid)
check("position at a frame's time is interpolated between fixes",
      fx and lat0 + 1e-5 < fx["lat"] < lat0 + 2e-5 and 12.1 <= fx["alt"] <= 12.2, fx)
check("a frame 5 s after the last fix gets no position", track.at(pi_times[-1] + 5) is None)

# ------------------------------------------------------------------ 5. detector + geotag + dispatch
meta = __import__("json").load(open(os.path.join(gs.REPO, "public", "models", "plastic.json")))
det = gs.PlasticDetector(os.path.join(gs.REPO, "public", "models", "plastic.onnx"), meta, conf=0.05)
img = __import__("cv2").imread(os.path.join(gs.REPO, "public", "site", "boat-drone.jpg"))
dets = det(img)
check(f"detector runs on {det.provider} ({det.ms:.0f} ms)", isinstance(dets, list))
check("only plastic classes are returned (no 'other litter')", all(d["cls"] in det.target for d in dets))
fake = [{"cls": 0, "label": "plastic bottle", "score": 0.81, "box": [10, 20, 60, 90]}]
cap_us = int(mid * 1e6)
recs = gs.geotag(fake, img, cap_us, track, time.time(), 7)
r = recs[0]
check("detection tagged with the drone's position at capture time", r["lat"] == fx["lat"] and r["alt"] == fx["alt"], r)
check("first detection carries the crop for the boat's matcher", (r["crop_jpeg"] or "").startswith("data:image/jpeg;base64,"))

posts = []
log_path = os.path.join(os.environ.get("TEMP", "/tmp"), "gs_test_log.jsonl")
if os.path.exists(log_path):
    os.remove(log_path)
d = gs.Dispatcher(log_path, "http://boat:8000", "http://pi:8000", post=lambda u, b: posts.append((u, b)) or {"success": True})
d.submit(r)
d.handle(d.q.get_nowait())
check("logged to the JSONL file (without the crop)", os.path.exists(log_path) and "crop_jpeg" not in open(log_path).read())
check("boat got POST /api/live/targets with id/lat/lng/class",
      posts and posts[0][0] == "http://boat:8000/api/live/targets"
      and posts[0][1]["targets"][0]["lat"] == r["lat"] and posts[0][1]["targets"][0]["source"] == "drone"
      and posts[0][1]["targets"][0]["object_class"] == "plastic bottle", posts[:1])
check("drone backend got POST /api/ai/report", len(posts) == 2 and posts[1][0] == "http://pi:8000/api/ai/report")
r2 = dict(r, id="gs-2")
d.submit(r2)
d.handle(d.q.get_nowait())
check("the same spot again is logged but not re-sent", len(posts) == 2 and d.stats["dup"] == 1)
r3 = dict(r, id="gs-3", lat=None, lng=None)
d.submit(r3)
d.handle(d.q.get_nowait())
check("no GPS fix: logged, not sent to the boat", len(posts) == 2 and d.stats["no_fix"] == 1)

# ------------------------------------------------------------------ 6. Pi pipeline settings
cmd = camera.gst_usb_h264("gst-launch-1.0", "/dev/video0")
s = " ".join(cmd)
check("GStreamer: MJPEG 640x480@30 from the webcam", "image/jpeg,width=640,height=480,framerate=30/1" in s)
check("GStreamer: v4l2h264enc, IDR every 15, headers repeated, 1000 kbit/s",
      "v4l2h264enc" in s and "h264_i_frame_period=15" in s and "repeat_sequence_header=1" in s and "video_bitrate=1000000" in s)
check("GStreamer: baseline (no B-frames), byte-stream to stdout, sync=false",
      "profile=(string)baseline" in s and "fdsink fd=1 sync=false" in s)

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
