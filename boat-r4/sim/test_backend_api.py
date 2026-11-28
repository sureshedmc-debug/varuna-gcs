"""
The laptop's boat program (boat-pi, started on a spare port against brain_sim)
driven through its HTTP API, exactly as the VARUNA app does it: status, motor
setup readout and motor test, scoop servo, a collection mission from upload to
completion, failsafe report. Never point this at the live boat program.

    py boat-r4/sim/test_backend_api.py [--base http://127.0.0.1:8091]
"""
import argparse
import json
import math
import sys
import time
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8091")
args = ap.parse_args()
if args.base.rstrip("/").endswith(":8001") or args.base.rstrip("/").endswith(":8000"):
    sys.exit("Refusing: that is the live boat program's port.")
results = []


def call(path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(args.base + path, data=data, method="GET" if body is None else "POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' - ' + str(detail)[:160]) if detail else ''}", flush=True)


def wait(pred, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = pred()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(step)
    return None


def offset(lat, lng, n, e):
    return (lat + n / 6378137.0 * 180 / math.pi,
            lng + e / (6378137.0 * math.cos(math.radians(lat))) * 180 / math.pi)


print("== status")
check("backend sees the brain", wait(lambda: call("/api/mavlink/status").get("fc_connected"), 20))
tel = wait(lambda: (lambda t: t if t.get("lat") else None)(call("/api/telemetry")), 20)
check("telemetry has a position", tel, tel and {k: tel.get(k) for k in ("lat", "lng", "heading", "gps_fix")})

print("== motors (app's motor setup page)")
m = call("/api/pixhawk/motors")
check("motor outputs found", m.get("success", True) and "left" in json.dumps(m) and "right" in json.dumps(m), m)
r = call("/api/pixhawk/motor_test", {"motor": "left", "pwm": 1150, "seconds": 1.0})
check("left motor test", r.get("success"), r.get("message"))
time.sleep(1.5)
r = call("/api/pixhawk/motor_test", {"motor": "right", "pwm": 1150, "seconds": 1.0})
check("right motor test", r.get("success"), r.get("message"))
time.sleep(1.5)

print("== scoop servo")
r = call("/api/servo", {"servo": 1, "on": True})
check("scoop servo on", r.get("success"), r.get("message"))
time.sleep(0.5)
r = call("/api/servo", {"servo": 1, "on": False})
check("scoop servo off", r.get("success"), r.get("message"))

print("== failsafe report")
r = call("/api/pixhawk/failsafe")
check("failsafe report", r.get("success", True), json.dumps(r)[:200])

print("== collection mission (upload -> start -> completed)")
tel = call("/api/telemetry")
pts = [offset(tel["lat"], tel["lng"], 14, 6), offset(tel["lat"], tel["lng"], 10, 18)]
r = call("/api/mission/upload", {"name": "R4 sim test", "waypoints": [{"lat": a, "lng": b} for a, b in pts],
                                  "hold_s": 2, "speed_mps": 1.2, "rtl": True, "homing": False})
check("upload", r.get("success"), r.get("message"))
r = call("/api/mission/start", {})
check("start", r.get("success"), r.get("message"))
st = wait(lambda: (lambda s: s if s.get("state") == "completed" else None)(call("/api/mission/status")), 240, 1.0)
s = call("/api/mission/status")
check("mission completed", st, {k: s.get(k) for k in ("state", "reached", "missed", "progress")})
check("disarmed after completion", wait(lambda: not call("/api/mavlink/status").get("armed"), 30),
      call("/api/mavlink/status"))

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
for n in failed:
    print("  FAILED:", n)
sys.exit(1 if failed else 0)
