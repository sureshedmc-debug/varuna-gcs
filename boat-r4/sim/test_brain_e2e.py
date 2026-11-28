"""
End-to-end test of the UNO R4 boat brain, driven by the laptop's OWN boat link
(boat-pi/mav_link.py BoatLink and mission.py's item layout) - exactly what the
VARUNA app uses - against brain_sim (the same brain.cpp, a simulated air boat
and a simulated phone GPS + 50 Hz compass/gyro), with normal forward-only ESCs
(1000 us = stopped, 2000 us = full) and an FS-i6 transmitter on the receiver's PPM.

    py boat-r4/sim/test_brain_e2e.py [--port 5770] [--adb]

--adb: the sim runs in the Android emulator; side-channel commands (GPS off,
teleport) are written there with adb. Without it they go to a local file.
"""
import argparse
import math
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "boat-pi"))

from mav_link import BoatLink, LinkError, haversine_m, mavlink  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=5770)
ap.add_argument("--adb", action="store_true")
ap.add_argument("--quick", action="store_true", help="skip the long mission legs")
args = ap.parse_args()

ADB = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe")
results = []


def ctl(line):
    if args.adb:
        subprocess.run([ADB, "shell", f"echo '{line}' >> /data/local/tmp/brain_sim.ctl"], check=True)
    else:
        with open("/data/local/tmp/brain_sim.ctl", "a") as f:
            f.write(line + "\n")


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' - ' + detail) if detail else ''}", flush=True)
    return ok


def wait(pred, timeout, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return None


def stopped(s):
    """Both air motors at the forward-only ESC's stop (1000 us)."""
    return 0 < s[2] <= 1005 and 0 < s[3] <= 1005


def texts_since(t0):
    return [m["text"] for m in list(link.messages) if m.get("t", 0) >= t0 - 0.2]


def rc(thr=1000, ch4=1500, swd=1000, swa=1000, vrb=1000, secs=0.0):
    """The FS-i6 on the receiver's PPM: CH3 throttle, CH4 fin, CH5 SwD, CH6 SwA, CH7 VrB."""
    ctl(f"rc 1500 1500 {thr} {ch4} {swd} {swa} {vrb} 1500")
    if secs:
        time.sleep(secs)


def hdg_err(a, b):
    return (a - b + 540) % 360 - 180


def push(steer, thr, secs):
    t_end = time.time() + secs
    while time.time() < t_end:
        link.rc_override(steer, thr)
        time.sleep(0.1)


def offset(lat, lng, n, e):
    return (lat + n / 6378137.0 * 180 / math.pi,
            lng + e / (6378137.0 * math.cos(math.radians(lat))) * 180 / math.pi)


link = BoatLink(f"tcp:127.0.0.1:{args.port}", 115200)
reached = []
link.on_item_reached(lambda s: reached.append(s))
texts_seen = lambda: [m["text"] for m in list(link.messages)]
link.start()

print("== link")
check("heartbeat from the brain", wait(lambda: link.fc_connected, 15))
hb = link._m.messages.get("HEARTBEAT") if link._m else None
check("vehicle type is a surface boat, ArduPilot", hb is not None and hb.type == 11 and hb.autopilot == 3,
      f"type {getattr(hb, 'type', None)} autopilot {getattr(hb, 'autopilot', None)}")
check("GPS fix from the phone", wait(lambda: link.snapshot()["gps_fix"] >= 3 and link.snapshot()["lat"], 10))
check("home position reported", wait(lambda: link.snapshot()["home_lat"] is not None, 12))
check("heading reported", wait(lambda: link.snapshot()["heading"] is not None, 5))
check("servo outputs streamed", wait(lambda: link.snapshot()["servo_out"] is not None, 20))

print("== parameters")
check("SERVO3_FUNCTION = 73 (left air motor)", link.get_param("SERVO3_FUNCTION") == 73)
check("SERVO4_FUNCTION = 74 (right air motor)", link.get_param("SERVO4_FUNCTION") == 74)
check("SERVO1_FUNCTION = 26 (the one fin servo)", link.get_param("SERVO1_FUNCTION") == 26)
check("SERVO5_FUNCTION = 26 (right fin, steered with the left)", link.get_param("SERVO5_FUNCTION") == 26)
check("AB_GATE_SPEED = 1000 (scoop glides)", link.get_param("AB_GATE_SPEED") == 1000)
check("AB_MAN_SLEW = 0 (FS-i6 straight to the ESCs)", link.get_param("AB_MAN_SLEW") == 0)
check("AB_LOG_HZ = 25 (outputs fast for the phone log)", link.get_param("AB_LOG_HZ") == 25)
check("AB_REVERSIBLE = 0 (forward-only ESCs)", link.get_param("AB_REVERSIBLE") == 0)
check("SERVO3_TRIM = 1000 (ESC stop)", link.get_param("SERVO3_TRIM") == 1000)
check("RCMAP_ROLL = 4 (FS-i6 CH4 = fin)", link.get_param("RCMAP_ROLL") == 4)
check("MODE_CH = 5 (SwD)", link.get_param("MODE_CH") == 5)
check("AB_BRUSH_RELAY = 2, AB_GATE_OUT = 2", link.get_param("AB_BRUSH_RELAY") == 2 and link.get_param("AB_GATE_OUT") == 2)
check("unknown parameter: no answer", link.get_param("NO_SUCH_PARAM", timeout=1.0) is None)
old = link.get_param("AB_HDG_P")
v = link.set_param("AB_HDG_P", 0.025)
check("set AB_HDG_P", abs(v - 0.025) < 1e-6)
link.set_param("AB_HDG_P", old)

print("== manual drive (the app's motor push / sticks)")
try:
    link.set_mode("MANUAL")
    check("MANUAL", link.snapshot()["flight_mode"] == "MANUAL")
except LinkError as e:
    check("MANUAL", False, str(e))
so = lambda: link.snapshot()["servo_out"] or [0] * 8
check("disarmed: motors at 1000 (stopped)", wait(lambda: stopped(so()), 3), f"{so()}")
link.rc_override(1500, 1700)
time.sleep(0.5)
try:
    link.arm(True)
    check("arm refused with throttle up", False)
except LinkError as e:
    check("arm refused with throttle up", True, str(e))
link.rc_override(1500, 1500)                     # throttle stick centred = stopped
time.sleep(0.5)
try:
    check("arm in MANUAL", link.arm(True) == "Armed.")
except LinkError as e:
    check("arm in MANUAL", False, str(e))
push(1500, 1700, 3)
s = so()
check("throttle stick: both air motors run, same speed (bridge)", s[2] > 1300 and s[2] == s[3], f"L{s[2]} R{s[3]}")
push(1900, 1700, 1.5)
s = so()
check("steer right: fin right, motors still equal", s[0] > 1700 and s[2] == s[3], f"fin {s[0]} L{s[2]} R{s[3]}")
push(1500, 1100, 2)
s = so()
check("throttle below centre: motors stay stopped (no reverse)", stopped(s), f"L{s[2]} R{s[3]}")

print("== ACRO heading hold (phone compass + gyro, steering stick centred)")
link.set_mode("ACRO")
check("ACRO", link.snapshot()["flight_mode"] == "ACRO")
push(1500, 1800, 5)
ref = link.snapshot()["heading"]
ctl("kick 40")                                   # a gust spins the boat at 40 deg/s
worst = 0
t_end = time.time() + 4
while time.time() < t_end:
    link.rc_override(1500, 1800)
    worst = max(worst, abs(hdg_err(link.snapshot()["heading"], ref)))
    time.sleep(0.1)
end_err = abs(hdg_err(link.snapshot()["heading"], ref))
check("gust kick: heading pulled back", worst < 8 and end_err < 2.5, f"worst {worst:.1f}, after 4 s {end_err:.1f} deg")

push(1500, 1500, 1)
link.rc_override(0, 0)
check("override released: motors stop", wait(lambda: stopped(so()), 2), f"{so()}")

print("== gate servo + relays (the laptop's buttons)")
link.set_mode("MANUAL")
check("gate closed at start (1000)", so()[1] == 1000, f"{so()[1]}")
r = link.command_long(mavlink.MAV_CMD_DO_SET_SERVO, [2, 2000])
check("DO_SET_SERVO 2 (gate) accepted", r == 0)
check("gate output opens", wait(lambda: so()[1] == 2000, 2), f"{so()[1]}")
link.command_long(mavlink.MAV_CMD_DO_SET_SERVO, [2, 1000])
check("gate output closes", wait(lambda: so()[1] == 1000, 2), f"{so()[1]}")
t0 = time.time()
r = link.command_long(mavlink.MAV_CMD_DO_SET_RELAY, [1, 1])
check("relay 2 (brushes) on from the laptop", r == 0 and wait(lambda: "Brushes on" in texts_since(t0), 2))
link.command_long(mavlink.MAV_CMD_DO_SET_RELAY, [1, 0])
r = link.command_long(mavlink.MAV_CMD_DO_SET_SERVO, [3, 2000])
check("DO_SET_SERVO on a motor output is refused", r == mavlink.MAV_RESULT_DENIED)
r = link.command_long(mavlink.MAV_CMD_DO_SET_RELAY, [0, 1])
check("relay on", r == 0)
r = link.command_long(mavlink.MAV_CMD_DO_SET_RELAY, [0, 0])
check("relay off", r == 0)
link.arm(False)

print("== motor test (disarmed)")
r = link.command_long(mavlink.MAV_CMD_DO_MOTOR_TEST, [1, 0, 20, 2])
check("motor test accepted", r == 0)
check("motor 1 (both motors) runs in the test", wait(lambda: so()[2] > 1150 and so()[3] > 1150, 2), f"{so()}")
check("motor test ends", wait(lambda: stopped(so()), 4), f"{so()}")
# ArduRover's numbering: 1 = both motors, 2 = steering (fin), 3 = left, 4 = right
r = link.command_long(mavlink.MAV_CMD_DO_MOTOR_TEST, [4, 0, 20, 2])
check("right motor test: right forward, left stopped", wait(lambda: so()[3] > 1150 and so()[2] <= 1005, 2), f"{so()}")
wait(lambda: stopped(so()), 4)
# The app's motor-matching card (laptop main.py): raw pulses.
r = link.command_long(mavlink.MAV_CMD_DO_MOTOR_TEST, [4, 1, 1100, 2])
check("matching card's raw 1100 us test", wait(lambda: so()[3] == 1100, 2), f"{so()}")
wait(lambda: stopped(so()), 4)

print("== mission upload + AUTO (mission.py's layout: home, speed, waypoints, RTL)")
snap = link.snapshot()
home = (snap["home_lat"], snap["home_lng"])
lat0, lng0 = snap["lat"], snap["lng"]
legs = [(18, 4), (18, 22)] if not args.quick else [(10, 0)]
wps = [offset(lat0, lng0, n, e) for n, e in legs]
items = [{"command": 16, "lat": home[0], "lng": home[1], "alt": 0},
         {"command": 178, "frame": 2, "param1": 1, "param2": 1.2, "param3": -1}]
for la, ln in wps:
    items.append({"command": 16, "param1": 3, "lat": la, "lng": ln, "alt": 0})
rtl_seq = len(items)
items.append({"command": 20, "lat": 0, "lng": 0, "alt": 0})
try:
    n = link.upload_mission(items)
    check("upload + verify download", n == len(items), f"{n} items")
except LinkError as e:
    check("upload + verify download", False, str(e))
link.set_mode("HOLD")
h_before = (link.snapshot()["home_lat"], link.snapshot()["home_lng"])
link.arm(True)
# Arming moves home to where the boat is (as ArduPilot); the brain announces it.
check("home re-announced on arming", wait(lambda: (link.snapshot()["home_lat"], link.snapshot()["home_lng"]) != h_before, 3))
home = (link.snapshot()["home_lat"], link.snapshot()["home_lng"])
check("set current item 1 -> reports first waypoint (2)", link.set_current_item(1, 2))
link.set_mode("AUTO")
check("AUTO", link.snapshot()["flight_mode"] == "AUTO")
t0 = time.time()
done = wait(lambda: rtl_seq in reached, 240, 0.5)
dt = time.time() - t0
s = link.snapshot()
dh = haversine_m(s["lat"], s["lng"], home[0], home[1])
check("every waypoint reached, then home", done and all(q in reached for q in range(2, rtl_seq + 1)),
      f"reached {reached} in {dt:.0f} s")
check("ended near home", dh < 6, f"{dh:.1f} m from home")
# MIS_DONE_BEHAVE 1 = loiter in AUTO at the end (as ArduRover): it must stay there.
worst = 0
t_end = time.time() + 20
while time.time() < t_end:
    s = link.snapshot()
    worst = max(worst, haversine_m(s["lat"], s["lng"], home[0], home[1]))
    time.sleep(0.5)
check("after the mission: keeps its place at home (20 s)", worst < 6, f"worst {worst:.1f} m, mode {link.snapshot()['flight_mode']}")

print("== GUIDED goto + keeping position")
link.set_mode("GUIDED")
s = link.snapshot()
gt = offset(s["lat"], s["lng"], -12, 10)
link.goto(*gt)
dist = lambda: haversine_m(link.snapshot()["lat"], link.snapshot()["lng"], gt[0], gt[1])
check("GUIDED reaches the point (within 2.5 m)", wait(lambda: dist() < 2.5, 90, 0.3), f"{dist():.1f} m")
worst = 0
t_end = time.time() + 25
while time.time() < t_end:
    worst = max(worst, dist())
    time.sleep(0.5)
check("holds the point against the current (25 s)", worst < 4.5, f"worst {worst:.1f} m")

print("== RTL")
link.set_mode("RTL")
dh = lambda: haversine_m(link.snapshot()["lat"], link.snapshot()["lng"], home[0], home[1])
check("RTL returns home", wait(lambda: dh() < 4, 90, 0.5), f"{dh():.1f} m")

print("== failsafes")
link.set_mode("LOITER")
ctl("gps off")
ok = wait(lambda: link.snapshot()["flight_mode"] == "HOLD" or not link.snapshot()["armed"], 10)
check("GPS lost in LOITER -> HOLD", ok, f"{link.snapshot()['flight_mode']} armed={link.snapshot()['armed']}")
s = so()
check("GPS lost: motors stopped", stopped(s), f"{s}")
try:
    link.set_mode("AUTO")
    check("AUTO refused without GPS", False)
except LinkError as e:
    check("AUTO refused without GPS", True, str(e)[:80])
ctl("gps on")
wait(lambda: link.snapshot()["gps_fix"] >= 3, 10)
time.sleep(1.5)

link.set_mode("MANUAL")
if not link.snapshot()["armed"]:
    link.rc_override(1500, 1500)
    time.sleep(0.3)
    link.arm(True)
t_end = time.time() + 1
while time.time() < t_end:
    link.rc_override(1500, 1700)
    time.sleep(0.1)
check("driving on the laptop's sticks", so()[2] > 1300, f"{so()}")
# Laptop vanishes mid-push: the override stops coming.
check("override stops -> motors stop within RC_OVERRIDE_TIME", wait(lambda: stopped(so()), 5), f"{so()}")

print("== older phone app (no 50 Hz ATTITUDE): heading from GPS_INPUT only")
link.set_mode("ACRO")
ctl("att off")
time.sleep(1)
push(1500, 1800, 4)
ref = link.snapshot()["heading"]
worst = 0
t_end = time.time() + 5
while time.time() < t_end:
    link.rc_override(1500, 1800)
    worst = max(worst, abs(hdg_err(link.snapshot()["heading"], ref)))
    time.sleep(0.1)
check("heading hold still works without the gyro", worst < 7, f"wander {worst:.1f} deg")
ctl("att on")
link.rc_override(0, 0)
wait(lambda: stopped(so()), 5)
link.arm(False)

print("== FS-i6 on PPM (SwD manual/auto, CH3 both motors, CH4 fin, SwA brushes, VrB gate)")
link.set_mode("HOLD")
rc(swd=1000, secs=1.5)
check("SwD up -> MANUAL", wait(lambda: link.snapshot()["flight_mode"] == "MANUAL", 3), link.snapshot()["flight_mode"])
try:
    link.set_mode("LOITER")
    check("laptop mode change refused while SwD is MANUAL", False)
except LinkError as e:
    check("laptop mode change refused while SwD is MANUAL", link.snapshot()["flight_mode"] == "MANUAL", str(e)[:60])
rc(thr=1000, ch4=2000, secs=2.8)                  # stick arming: throttle low + CH4 right 2 s
check("stick arming (throttle low, CH4 right)", wait(lambda: link.snapshot()["armed"], 2))
rc(thr=1000, ch4=1500, secs=0.5)
check("armed, throttle low: motors stopped", stopped(so()), f"{so()}")
rc(thr=1600, secs=1.5)
s = so()
check("CH3 up: both motors, identical signal", s[2] > 1450 and s[2] == s[3], f"L{s[2]} R{s[3]}")
rc(thr=1600, ch4=1900, secs=1.0)
s = so()
check("CH4 right: fin moves, motors still equal", s[0] > 1700 and s[2] == s[3], f"fin {s[0]} L{s[2]} R{s[3]}")
check("CH4 right: both fins move together", s[4] == s[0], f"fin1 {s[0]} fin2 {s[4]}")
link.rc_override(1100, 1900)
time.sleep(0.5)
s = so()
check("laptop sticks ignored while the FS-i6 has it", s[0] > 1700 and s[2] == s[3], f"fin {s[0]} L{s[2]} R{s[3]}")
link.rc_override(0, 0)
rc(thr=1000, secs=1.0)
check("throttle down: motors stop", stopped(so()), f"{so()}")
t0 = time.time()
rc(swa=2000, secs=1.0)
check("SwA down: brushes on", "Brushes on" in texts_since(t0), str(texts_since(t0))[:80])
t0 = time.time()
rc(swa=1000, secs=1.0)
check("SwA up: brushes off", "Brushes off" in texts_since(t0), str(texts_since(t0))[:80])
rc(vrb=2000, secs=0.35)
g = so()[1]
check("VrB jump: the scoop glides (no jerk)", 1000 < g < 2000, f"{g}")
rc(vrb=1500, secs=1.2)
check("VrB turned: gate follows the knob", abs(so()[1] - 1500) <= 10, f"{so()[1]}")
rc(vrb=2000, secs=1.2)
check("VrB full: gate open", so()[1] == 2000, f"{so()[1]}")
rc(vrb=1000, secs=1.6)
check("VrB back: gate closed", so()[1] == 1000, f"{so()[1]}")
t0 = time.time()
rc(swd=2000, secs=1.5)
m = link.snapshot()["flight_mode"]
check("SwD down -> AUTO (mission loaded)", m == "AUTO", m)
tx = texts_since(t0)
check("auto: brushes on, gate open by themselves", "Brushes on" in tx and wait(lambda: so()[1] == 2000, 2), f"{tx} gate {so()[1]}")
t0 = time.time()
link.set_mode("HOLD")
check("SwD down: the laptop may change modes", link.snapshot()["flight_mode"] == "HOLD")
time.sleep(1.0)
tx = texts_since(t0)
check("HOLD: brushes off, gate closed", "Brushes off" in tx and wait(lambda: so()[1] == 1000, 2), f"{tx} gate {so()[1]}")
rc(swd=1000, secs=1.5)
check("SwD up again -> MANUAL", link.snapshot()["flight_mode"] == "MANUAL", link.snapshot()["flight_mode"])
rc(thr=900, secs=2.0)                             # receiver failsafe value: CH3 below FS_THR_VALUE
m = link.snapshot()["flight_mode"]
check("radio lost (CH3 < 960) -> HOLD, motors stopped", m == "HOLD" and stopped(so()), f"{m} {so()}")
ctl("rc off")
time.sleep(1.0)
link.arm(False)

print("== brake (force disarm)")
link.set_mode("HOLD")
link.arm(True)
check("brake_disarm", link.brake_disarm())

print("== reboot keeps parameters")
link.set_param("CRUISE_SPEED", 1.3)
link.command_long(mavlink.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, [1])
time.sleep(4)
check("back after reboot", wait(lambda: link.fc_connected, 15))
v = link.get_param("CRUISE_SPEED")
check("CRUISE_SPEED kept", v is not None and abs(v - 1.3) < 1e-4, f"{v}")
link.set_param("CRUISE_SPEED", 1.0)

link.stop()
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
for n in failed:
    print("  FAILED:", n)
sys.exit(1 if failed else 0)
