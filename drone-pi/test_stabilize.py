"""Stabilisation test: a shaky 720p30 video (7 Hz vibration + jitter + roll
wobble, over a slow intended pan) through stabilize.Stabilizer at real-time
pace. Checks the shake is mostly gone, the pan is kept, the capture stamps
survive, and how much delay it adds.  Run: py test_stabilize.py"""
import subprocess
import sys
import threading
import time

import cv2
import numpy as np

import stabilize
from camera import H264Splitter

W, H, FPS, N = 1280, 720, 30, 180
FF = "ffmpeg"


def scene():
    rng = np.random.default_rng(1)
    img = np.full((1100, 1800, 3), 90, np.uint8)
    for _ in range(900):
        c = tuple(int(x) for x in rng.integers(0, 255, 3))
        p = (int(rng.integers(0, 1800)), int(rng.integers(0, 1100)))
        cv2.circle(img, p, int(rng.integers(4, 30)), c, -1)
    return cv2.GaussianBlur(img, (3, 3), 0)


def shaky_frames():
    base = scene()
    rng = np.random.default_rng(2)
    out, truth = [], []
    for i in range(N):
        t = i / FPS
        pan = 60 * t                                     # intended: 60 px/s to the right
        shake = np.array([14 * np.sin(2 * np.pi * 7 * t), 10 * np.sin(2 * np.pi * 5.3 * t + 1)])
        shake += rng.normal(0, 3, 2)
        ang = 1.2 * np.sin(2 * np.pi * 3.1 * t)          # degrees
        cx, cy = 900 + pan + shake[0], 550 + shake[1]
        m = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
        m[0, 2] += W / 2 - cx
        m[1, 2] += H / 2 - cy
        out.append(cv2.warpAffine(base, m, (W, H)))
        truth.append((pan, shake, ang))
    return out, truth


def encode(frames):
    p = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                        "-s", f"{W}x{H}", "-framerate", str(FPS), "-i", "pipe:0", "-c:v", "libx264",
                        "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-b:v", "6000k",
                        "-pix_fmt", "yuv420p", "-g", "30", "-bf", "0", "-f", "h264", "pipe:1"],
                       input=b"".join(f.tobytes() for f in frames), capture_output=True, check=True)
    au = []
    sp = H264Splitter(lambda d, k, s: au.append((d, k)))
    sp.feed(p.stdout + b"\x00\x00\x00\x01\x09\xf0")    # an AUD at the end lets the last frame out
    return au


def decode_gray(data):
    p = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0",
                        "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], input=data, capture_output=True, check=True)
    n = len(p.stdout) // (W * H)
    return np.frombuffer(p.stdout[:n * W * H], np.uint8).reshape(n, H, W)


def motions(gray):
    st = stabilize.Stabilizer.__new__(stabilize.Stabilizer)
    out = []
    prev = None
    for g in gray:
        small = cv2.resize(g, (320, 180), interpolation=cv2.INTER_AREA)
        if prev is not None:
            out.append(stabilize.Stabilizer._motion(st, prev, small, W / 320))
        prev = small
    return np.array(out)


def jitter(m):
    """Frame-to-frame motion minus its slow part: the shake that is left."""
    k = np.ones(15) / 15
    slow = np.stack([np.convolve(m[:, j], k, mode="same") for j in range(3)], 1)
    r = (m - slow)[10:-10]
    return np.sqrt((r[:, :2] ** 2).sum(1)).mean(), np.rad2deg(np.abs(r[:, 2]).mean())


def main():
    ok = True
    frames, _ = shaky_frames()
    au = encode(frames)
    print(f"made {len(au)} shaky H.264 frames")
    got, sent_at, got_at = [], {}, []
    lock = threading.Event()
    cfg = {"stabilize_delay_ms": 300, "stabilize_crop_pct": 12}

    def on_frame(d, k, s):
        got.append(d)
        got_at.append(time.time())
        if len(got) >= len(au) - 12:
            lock.set()

    s = stabilize.Stabilizer(FF, W, H, FPS, cfg, on_frame, H264Splitter)
    for i, (d, k) in enumerate(au):
        sent_at[i] = time.time()
        s.offer(stabilize.sei_stamp(1000 + i) + d, k)
        time.sleep(1 / FPS)
    lock.wait(5)
    s.close()
    print(f"stabilised frames out: {len(got)} (the last {len(au) - len(got)} wait for the look-ahead)")
    if len(got) < len(au) - 15:
        print("FAIL  too few frames came out")
        return 1

    stamps = [int(stabilize.SEI_MARK.search(d).group(1)) for d in got if stabilize.SEI_MARK.search(d)]
    if stamps[:len(got)] != list(range(1000, 1000 + len(stamps))):
        print("FAIL  capture stamps lost or out of order:", stamps[:10])
        ok = False
    else:
        print(f"PASS  capture stamps kept in order on all {len(stamps)} frames")
    delays = [(got_at[j] - sent_at[stamps[j] - 1000]) * 1000 for j in range(len(stamps))]
    print(f"      added delay: {np.median(delays):.0f} ms median (look-ahead {cfg['stabilize_delay_ms']} ms)")

    before = motions(decode_gray(b"".join(d for d, _ in au)))
    after = motions(decode_gray(b"".join(got)))
    jb, rb = jitter(before)
    ja, ra = jitter(after)
    print(f"      shake before: {jb:.1f} px/frame, roll {rb:.2f} deg/frame")
    print(f"      shake after:  {ja:.1f} px/frame, roll {ra:.2f} deg/frame")
    if ja > jb * 0.35 or ra > rb * 0.5:
        print("FAIL  stabilisation took out too little")
        ok = False
    else:
        print(f"PASS  {100 * (1 - ja / jb):.0f} % of the shake and {100 * (1 - ra / rb):.0f} % of the roll removed")
    pan_before = before[10:-10, 0].mean() * FPS
    pan_after = after[10:-10, 0].mean() * FPS
    print(f"      pan kept: {pan_before:.0f} px/s in, {pan_after:.0f} px/s out (zoomed {1.12:.2f}x)")
    if abs(pan_after) < abs(pan_before) * 0.8:
        print("FAIL  the intended pan was taken out too")
        ok = False
    else:
        print("PASS  the intended pan is kept")
    print("\nSTABILISE TESTS " + ("PASSED" if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
