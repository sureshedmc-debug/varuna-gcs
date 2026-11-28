"""Test for analyze_log.py: a made-up boat with KNOWN numbers, driven through the
test runs (TEST_RUNS.md), written as the same .tlog the phone records. The
analyzer must find those numbers again.

    py boat-r4\\sysid\\make_test_log.py            -> sysid/test/fake_boat.tlog + truth.json
    py boat-r4\\sysid\\analyze_log.py boat-r4\\sysid\\test\\fake_boat.tlog --out boat-r4\\sysid\\test\\out
"""
import json
import math
import os
import struct

import numpy as np

os.environ.setdefault("MAVLINK20", "1")
from pymavlink.dialects.v20 import ardupilotmega as mav  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TRUTH = {"surge": {"k_thrust": 0.9, "d_lin": 0.6, "d_quad": 0.8, "d_scoop": 0.5, "delay_s": 0.10},
         "yaw": {"k_fin": 120.0, "k_diff": 60.0, "d_r": 2.0, "d_ru": 0.5, "bias": 1.5, "delay_s": 0.12}}
DT = 0.002


def schedule(t):
    """Throttle L, R (0..1), fin (-1..1), scoop (1 lowered), armed: the test runs."""
    if t < 10:
        return 0, 0, 0, 0, 0
    t -= 10
    seq = []
    for thr in (0.3, 0.6, 1.0):                      # straight runs + coast-downs
        seq += [(15, thr, thr, 0, 0), (10, 0, 0, 0, 0)]
    for f in (0.5, -0.5, 1.0, -1.0, 0.7, -0.7):      # fin steps at 60 %
        seq += [(4, 0.6, 0.6, 0, 0), (3, 0.6, 0.6, f, 0)]
    for k in range(8):                               # zig-zag
        seq += [(3, 0.8, 0.8, 0.8 if k % 2 else -0.8, 0)]
    seq += [(20, 0.6, 0.6, 0, 1), (10, 0, 0, 0, 1), (20, 1.0, 1.0, 0, 1), (10, 0, 0, 0, 0)]  # scoop lowered
    for d in (0.3, -0.3, 0.2, -0.2):                 # motor difference (as AUTO does)
        seq += [(5, 0.6 + d, 0.6 - d, 0, 0), (3, 0.6, 0.6, 0, 0)]
    seq += [(15, 0, 0, 0, 0)]
    for dur, L, R, f, s in seq:
        if t < dur:
            return L, R, f, s, 1
        t -= dur
    return None


def main():
    rng = np.random.default_rng(7)
    out_dir = os.path.join(HERE, "test")
    os.makedirs(out_dir, exist_ok=True)
    brain = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    phone = mav.MAVLink(None, srcSystem=254, srcComponent=220)
    recs = []
    t0_us = 1_764_000_000_000_000
    def rec(t, msg, enc):
        recs.append(struct.pack(">Q", t0_us + int(t * 1e6)) + msg.pack(enc))
    s, y = TRUTH["surge"], TRUTH["yaw"]
    hist = []                                        # past commands (for the delays)
    u = r = 0.0
    psi = 40.0
    north = east = 0.0
    lat0, lon0 = 28.6, 77.2
    t = 0.0
    nxt = {"att": 0, "gps": 0, "out": 0, "hb": 0}
    pos_bias = np.zeros(2)
    while True:
        cmd = schedule(t)
        if cmd is None:
            break
        L, R, f, sc, armed = cmd
        hist.append((t, L, R, f, sc))
        def late(d):
            i = max(0, len(hist) - 1 - int(round(d / DT)))
            return hist[i]
        _, Ls, Rs, _, _ = late(s["delay_s"])
        _, Ly, Ry, fy, _ = late(y["delay_s"])
        T_s = (Ls ** 2 + Rs ** 2) / 2
        T_y, D_y = (Ly ** 2 + Ry ** 2) / 2, (Ly ** 2 - Ry ** 2) / 2
        du = s["k_thrust"] * T_s - s["d_lin"] * u - s["d_quad"] * u * abs(u) - s["d_scoop"] * sc * u
        dr = y["k_fin"] * fy * T_y + y["k_diff"] * D_y - y["d_r"] * r - y["d_ru"] * r * abs(u) + (y["bias"] if armed else 0)
        if not armed:
            dr = -y["d_r"] * r
        u += du * DT
        r += dr * DT
        psi += r * DT
        cur = (0.05, -0.03)                          # a little current: the GPS sees it, the model must cope
        vn = u * math.cos(math.radians(psi)) + cur[0]
        ve = u * math.sin(math.radians(psi)) + cur[1]
        north += vn * DT
        east += ve * DT
        if t >= nxt["att"]:                          # the phone: compass + gyro, 50 Hz
            nxt["att"] += 0.02 + rng.normal(0, 0.002)
            yaw = math.radians((psi + rng.normal(0, 1.0) + 180) % 360 - 180)
            rate = math.radians(r + rng.normal(0, 0.6) + 0.3)
            rec(t, phone.attitude_encode(int(t * 1000), 0, 0, yaw, 0, 0, rate), phone)
        if t >= nxt["gps"]:                          # the phone: GPS, 10 Hz
            nxt["gps"] += 0.1
            pos_bias = 0.98 * pos_bias + rng.normal(0, 0.08, 2)
            n_m, e_m = north + pos_bias[0], east + pos_bias[1]
            lat = lat0 + n_m / 111320
            lon = lon0 + e_m / (111320 * math.cos(math.radians(lat0)))
            rec(t, phone.gps_input_encode(0, 0, 0, 0, 0, 3, int(lat * 1e7), int(lon * 1e7), 0, 0.8, 1.0,
                                          vn + rng.normal(0, 0.05), ve + rng.normal(0, 0.05), 0, 0.2, 1.5, 3, 12,
                                          int(psi % 360 * 100) or 36000), phone)
        if t >= nxt["out"]:                          # the brain: its outputs, 25 Hz
            nxt["out"] += 0.04
            fin_us = int(1500 + f * 400)
            rec(t, brain.servo_output_raw_encode(int(t * 1e6), 0, fin_us, int(1000 + sc * 1000),
                                                 int(1000 + L * 1000), int(1000 + R * 1000), fin_us, 0, 0, 0), brain)
        if t >= nxt["hb"]:
            nxt["hb"] += 1.0
            rec(t, brain.heartbeat_encode(10, 3, 129 if armed else 1, 0, 4), brain)
        t += DT
    path = os.path.join(out_dir, "fake_boat.tlog")
    with open(path, "wb") as fh:
        for b in recs:
            fh.write(b)
    with open(os.path.join(out_dir, "truth.json"), "w") as fh:
        json.dump(TRUTH, fh, indent=2)
    print(f"{path}: {t:.0f} s, {len(recs)} frames")


if __name__ == "__main__":
    main()
