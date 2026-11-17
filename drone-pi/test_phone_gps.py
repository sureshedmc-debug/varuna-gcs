"""
Checks phone_gps.py: the phone's GPS and camera attitude as the drone's pose.

  py test_phone_gps.py

A simulated phone flies east at 5 m/s, 1 GPS fix a second, attitude 20 times a
second, with its clock 37 s off this computer's and 30-80 ms of Wi-Fi delay.
Checks that frame poses (by the phone's clock) land within a metre of the truth
between and after fixes, the clock offset is found, angles wrap the short way,
and the field of view narrows by the stabiliser's zoom.
"""

import math
import random

import phone_gps
from phone_gps import PhoneGPS

LAT0, LNG0 = 28.6, 77.2
SPEED = 5.0          # m/s east
CLOCK_OFF = 37.0     # laptop - phone, s


class Cfg(dict):
    def get(self, k, d=None):
        return super().get(k, d)


def truth(ts):
    return phone_gps._move(LAT0, LNG0, 0.0, SPEED * ts)


def main():
    random.seed(1)
    cfg = Cfg(camera_url="http://192.168.1.23:8080/video", position_source="auto")
    g = PhoneGPS(cfg)
    assert g.stream_url() == "http://192.168.1.23:8080/location/stream", g.stream_url()

    t0 = 1_700_000_000.0          # phone clock at the start
    last_fix = None
    for i in range(20 * 12):      # 12 s
        ts = i / 20.0
        if last_fix is None or ts - last_fix >= 1.0:
            last_fix = ts
        lat, lng = truth(last_fix)
        hdg = (350 + ts * 2) % 360            # turning slowly through north
        s = {"t": int((t0 + ts) * 1000), "lat": lat, "lng": lng, "acc": 3.5, "spd": SPEED, "crs": 90.0,
             "fix": "gps", "fix_age": int((ts - last_fix) * 1000), "rel_alt": 20.0 + 0.1 * ts,
             "sats": 14, "sats_seen": 25, "home_lat": LAT0, "home_lng": LNG0,
             "hdg": hdg, "pitch": -1.0, "roll": 2.0, "fov": 66.0}
        g.ingest(s, t0 + ts + CLOCK_OFF + random.uniform(0.03, 0.08))

    assert abs(g.offset - CLOCK_OFF - 0.03) < 0.01, g.offset
    worst = 0.0
    for k in range(100):
        ts = 6.0 + k * 0.05                    # between fixes and up to 1 s after one
        p = g.pose_at_phone(t0 + ts)
        lat, lng = truth(ts)
        err = phone_gps._dist_m(lat, lng, p["lat"], p["lng"])
        worst = max(worst, err)
    print(f"position error at frame times: worst {worst:.2f} m")
    assert worst < 1.0, worst

    # After the last fix (live edge): carried forward along the velocity.
    ts = 11.95 + 0.6
    p = g.pose_at_phone(t0 + ts)
    lat, lng = truth(ts)
    err = phone_gps._dist_m(lat, lng, p["lat"], p["lng"])
    print(f"carried forward 0.6 s past the last line: {err:.2f} m off")
    assert err < 1.0, err

    # Heading wraps through north the short way.
    a = g.pose_at_phone(t0 + 5.0)["hdg"]
    assert a < 1 or a > 359, a
    p = g.pose_at_phone(t0 + 5.025)
    assert abs(((p["hdg"] - 0.05) + 180) % 360 - 180) < 0.2, p["hdg"]
    assert p["cam"] is True and p["alt"] and abs(p["alt"] - 20.5) < 0.05, p

    # Field of view narrowed by the stabiliser's 12 % zoom.
    z = g.pose_at_phone(t0 + 5.0, zoom=1.12)["fov"]
    want = math.degrees(2 * math.atan(math.tan(math.radians(33)) / 1.12))
    assert abs(z - want) < 0.05, (z, want)
    print(f"field of view 66.0 -> {z} with stabilisation")

    # Fixed height overrides the phone's.
    cfg["phone_fixed_alt_m"] = 15
    assert g.pose_at_phone(t0 + 5.0)["alt"] == 15
    cfg["phone_fixed_alt_m"] = 0

    # By this computer's clock (frames without a stamp).
    p = g.pose_at(t0 + 6.5 + CLOCK_OFF + 0.03)
    lat, lng = truth(6.5)
    assert phone_gps._dist_m(lat, lng, p["lat"], p["lng"]) < 1.0

    # Smoothed like the stabilised picture: shake averages out, heading wraps.
    g2 = PhoneGPS(cfg)
    for i in range(200):
        ts = i / 20.0
        g2.ingest({"t": int((t0 + ts) * 1000), "hdg": (359.5 + (1 if i % 2 else -1)) % 360,
                   "pitch": 3.0 * (1 if i % 2 else -1), "roll": 1.0}, t0 + ts + CLOCK_OFF)
    p = g2.pose_at_phone(t0 + 5.0, smooth_s=0.3)
    assert abs(p["pitch"]) < 0.5 and abs(((p["hdg"] - 359.5) + 180) % 360 - 180) < 0.2, p
    print(f"smoothed attitude: pitch {p['pitch']}, heading {p['hdg']}")

    # No fix for too long: no position.
    assert g.pose_at_phone(t0 + 30)["lat"] is None
    assert len(g.recent_track()) >= 10
    print("PASSED")


if __name__ == "__main__":
    main()
