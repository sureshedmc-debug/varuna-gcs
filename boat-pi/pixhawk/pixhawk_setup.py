"""
Boat Pixhawk settings for the phone-linked boat (ArduRover 4.7, Pixhawk1).

    py pixhawk_setup.py                 show the current values next to the wanted ones
    py pixhawk_setup.py --apply         back up every parameter, then write the wanted ones
    py pixhawk_setup.py --compass-cal   on-board compass calibration (rotate the boat)
    py pixhawk_setup.py --reboot        restart the Pixhawk

Safe by design: nothing is written while the boat is armed, every value is
read back after writing, a full backup (.param) is saved first, and a setting
this firmware does not have is reported and skipped (never guessed).

Wiring this matches: MAIN OUT 1 rudder, 2 scoop servo (moved by the boat
program), 3 BLDC ESC, 4 second servo (SwA on the FS-i6, passed straight
through), RC IN = FS-iA6B PPM, USB = the boat phone (OTG). No power module.
"""

import argparse
import math
import os
import sys
import time

from pymavlink import mavutil

HERE = os.path.dirname(os.path.abspath(__file__))

# (name, value, why). The order is the order they are written.
WANTED = [
    # GPS: the phone's GPS is the Pixhawk's only GPS (GPS_INPUT over USB from VARUNA Boat Link)
    ("GPS1_TYPE", 14, "GPS from the phone (MAVLink GPS_INPUT)"),
    ("GPS2_TYPE", 0, "no second GPS"),
    ("EK3_SRC1_POSXY", 3, "position from GPS (the phone)"),
    ("EK3_SRC1_VELXY", 3, "speed from GPS (the phone)"),
    ("EK3_GPS_CHECK", 0, "phone GPS accuracy would fail the strict pre-arm GPS checks"),
    # Heading WITHOUT a compass (skip compass calibration). The boat does not use
    # the compass, so it arms with no "Compass not calibrated" pre-arm and there is
    # nothing to calibrate. In GUIDED / AUTO the EKF takes heading from GPS motion
    # (the EKF-GSF yaw estimator) once the boat is moving. To go back to a compass
    # later: calibrate with --compass-cal, then set COMPASS_USE 1 and EK3_SRC1_YAW 1.
    ("COMPASS_ENABLE", 1, "compass powered (read, but not used for heading)"),
    ("COMPASS_USE", 0, "do NOT use the compass -> nothing to calibrate, no compass pre-arm"),
    ("EK3_SRC1_YAW", 0, "no compass; heading from GPS motion (EKF GSF) in GUIDED/AUTO"),
    # Navigation and speed (the Pixhawk holds heading and speed itself in AUTO / GUIDED / ACRO)
    ("WP_RADIUS", 3.0, "phone GPS is good to ~3-5 m; the camera does the last metres"),
    ("WP_SPEED", 0.5, "slow, safe speed (m/s)"),
    ("CRUISE_SPEED", 0.5, "speed the Pixhawk holds (m/s)"),
    ("MOT_THR_MAX", 50, "motor capped at 50%"),
    # Transmitter, modes, failsafes
    ("RCMAP_ROLL", 4, "rudder on CH4"),
    ("RCMAP_THROTTLE", 3, "throttle on CH3"),
    ("MODE_CH", 8, "SwD (on CH8) = mode switch"),
    ("MODE1", 0, "SwD one end = MANUAL (drive by hand)"),
    ("MODE6", 1, "SwD other end = ACRO (holds heading)"),
    ("RC5_OPTION", 0, "SwA has no autopilot function (it drives the second servo)"),
    ("RC6_OPTION", 0, "no arming switch"),
    ("RC8_OPTION", 0, "CH8 (SwD) is the mode switch only (MODE_CH 8) — no other aux function"),
    ("ARMING_RUDDER", 2, "arm / disarm with the left stick"),
    ("FS_THR_ENABLE", 1, "transmitter lost -> failsafe"),
    ("FS_THR_VALUE", 910, "receiver failsafe puts CH3 below this"),
    ("FS_ACTION", 2, "failsafe = HOLD (stop)"),
    ("FS_EKF_ACTION", 1, "position lost (phone GPS / USB gone) -> HOLD"),
    ("FS_GCS_ENABLE", 0, "laptop link loss is handled by the phone (HOLD only in GUIDED/AUTO)"),
    ("FENCE_ENABLE", 0, "no fence"),
    ("BATT_MONITOR", 0, "no power module"),
    ("BRD_SAFETY_DEFLT", 0, "no safety switch"),
    # Outputs
    ("SERVO1_FUNCTION", 26, "MAIN OUT 1 = rudder"),
    # Rudder throw maximised: full 1000-2000 us swing (the default is a narrow
    # 1100-1900). If the rudder hits its mechanical stop before the stick is full
    # (servo buzzes / strains at the end), pull SERVO1_MIN up / SERVO1_MAX down a
    # little; if it still has room, widen toward 900 / 2100.
    ("SERVO1_MIN", 1000, "rudder hard-over one way (max steering angle)"),
    ("SERVO1_MAX", 2000, "rudder hard-over the other way (max steering angle)"),
    ("SERVO1_TRIM", 1500, "rudder centred / straight"),
    ("SERVO2_FUNCTION", 0, "MAIN OUT 2 = scoop (moved smoothly by the boat program)"),
    ("SERVO3_FUNCTION", 70, "MAIN OUT 3 = BLDC ESC (throttle)"),
    # Forward-only BLDC ESC: it must see 1000 us ("stopped") at power-up to arm.
    # The default 1500 us neutral reads as mid-throttle, so the ESC never arms and
    # the motor won't spin. Rest at 1000 (off), full throttle at 2000.
    ("SERVO3_MIN", 1000, "ESC zero throttle / arm point"),
    ("SERVO3_MAX", 2000, "ESC full throttle"),
    ("SERVO3_TRIM", 1000, "throttle rests here = motor stopped (forward-only ESC)"),
    ("SERVO4_FUNCTION", 55, "MAIN OUT 4 = second servo, straight from RC input 5 (SwA)"),
    ("SERVO4_MIN", 1000, "second servo range"),
    ("SERVO4_MAX", 2000, "second servo range"),
    ("SERVO4_TRIM", 1500, "second servo centre"),
    # Telemetry on USB (the phone), so the phone screen has data even with no laptop
    ("SERIAL0_PROTOCOL", 2, "USB = MAVLink 2"),
    # 4.7 names (MAV1_ = the first MAVLink port = USB; older firmware called them SR0_)
    ("MAV1_EXT_STAT", 2, "status / GPS 2 Hz"),
    ("MAV1_POSITION", 4, "position 4 Hz"),
    ("MAV1_EXTRA1", 4, "attitude 4 Hz"),
    ("MAV1_EXTRA2", 4, "speed / heading 4 Hz"),
    ("MAV1_RC_CHAN", 4, "receiver channels 4 Hz"),
]
# Arming checks: the compass check is SKIPPED (the boat has no compass heading),
# so an uncalibrated compass never blocks arming. The GPS check stays skipped too,
# so the boat can be armed and driven by hand (MANUAL on SwD) with no GPS fix.
SKIPCHK_COMPASS_BIT = 4


def find_port():
    from serial.tools import list_ports
    for p in list_ports.comports():
        if (p.vid in (0x1209, 0x26AC, 0x2DAE, 0x3162)) or "ArduPilot" in (p.description or "") or "PX4" in (p.description or ""):
            return p.device
    return None


def connect(port):
    # mavserial directly: on Windows mavlink_connection("COM7") can mistake the port for a log file
    try:
        m = mavutil.mavserial(port, baud=115200, source_system=255, source_component=190)
    except Exception as e:
        sys.exit(f"Cannot open {port}: {e}\nClose Mission Planner / the boat program if they are using it.")
    t_end = time.time() + 15
    while time.time() < t_end:
        hb = m.recv_match(type="HEARTBEAT", blocking=True, timeout=1)
        if hb and hb.type != mavutil.mavlink.MAV_TYPE_GCS and hb.autopilot == mavutil.mavlink.MAV_AUTOPILOT_ARDUPILOTMEGA:
            m.target_system, m.target_component = hb.get_srcSystem(), hb.get_srcComponent()
            return m, hb
    sys.exit(f"No Pixhawk heartbeat on {port}. Is Mission Planner / the boat program using the port?")


def armed(m):
    hb = m.recv_match(type="HEARTBEAT", blocking=True, timeout=3)
    return bool(hb and hb.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)


def version(m):
    m.mav.command_long_send(m.target_system, m.target_component,
                            mavutil.mavlink.MAV_CMD_REQUEST_MESSAGE, 0, 148, 0, 0, 0, 0, 0, 0)
    v = m.recv_match(type="AUTOPILOT_VERSION", blocking=True, timeout=3)
    if not v:
        return "?"
    s = v.flight_sw_version
    return f"{s >> 24 & 255}.{s >> 16 & 255}.{s >> 8 & 255}"


def fetch_all(m):
    params, total = {}, None
    m.mav.param_request_list_send(m.target_system, m.target_component)
    last = time.time()
    while time.time() - last < 3:
        p = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=0.5)
        if not p:
            continue
        last = time.time()
        params[p.param_id] = (p.param_value, p.param_index)
        total = p.param_count
        if total and len(params) >= total:
            break
    if total:                                   # ask again for any that were missed
        have = {i for _, i in params.values()}
        for i in range(total):
            if i not in have:
                m.mav.param_request_read_send(m.target_system, m.target_component, b"", i)
                p = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=1)
                if p:
                    params[p.param_id] = (p.param_value, p.param_index)
    return {k: v for k, (v, _) in params.items()}, total


def same(a, b):
    return math.isclose(float(a), float(b), rel_tol=1e-5, abs_tol=1e-4)


def set_param(m, name, value):
    for _ in range(3):
        m.mav.param_set_send(m.target_system, m.target_component, name.encode(), float(value),
                             mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        t_end = time.time() + 2
        while time.time() < t_end:
            p = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=0.5)
            if p and p.param_id == name:
                if same(p.param_value, value):
                    return True
                break
    return False


def fmt(v):
    return f"{v:g}" if v is not None else "-"


def wanted_list(params):
    out = list(WANTED)
    if "ARMING_SKIPCHK" in params:
        cur = int(params["ARMING_SKIPCHK"])
        out.append(("ARMING_SKIPCHK", cur | SKIPCHK_COMPASS_BIT,
                    "skip the compass arming check (the boat has no compass heading)"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--compass-cal", action="store_true")
    ap.add_argument("--reboot", action="store_true")
    a = ap.parse_args()
    port = a.port or find_port()
    if not port:
        sys.exit("No Pixhawk on USB.")
    m, hb = connect(port)
    print(f"Pixhawk on {port}: ArduRover {version(m)}, system {m.target_system}, "
          f"{'ARMED' if hb.base_mode & 128 else 'disarmed'}")

    if a.compass_cal:
        return compass_cal(m)
    if a.reboot:
        return reboot(m)

    params, total = fetch_all(m)
    print(f"Read {len(params)} of {total} parameters")
    rows = wanted_list(params)
    changes = []
    for name, val, why in rows:
        cur = params.get(name)
        if cur is None:
            print(f"  ?? {name:16} not in this firmware - skipped ({why})")
            continue
        mark = "ok" if same(cur, val) else "->"
        if mark == "->":
            changes.append((name, val, cur))
        print(f"  {mark} {name:16} {fmt(cur):>8}  wanted {fmt(val):>8}   {why}")
    for extra in ("COMPASS_USE2", "COMPASS_USE3", "COMPASS_OFS_X", "COMPASS_DEV_ID", "AHRS_ORIENTATION",
                  "SERVO_RC_FS_MSK"):
        if extra in params:
            print(f"     {extra:16} {fmt(params[extra]):>8}")
    if not a.apply:
        print(f"\n{len(changes)} to change. Run with --apply to write them.")
        return
    if not changes:
        print("\nNothing to change.")
        return
    if armed(m):
        sys.exit("ARMED - nothing written. Disarm first.")
    stamp = time.strftime("%Y-%m-%d_%H%M")
    path = os.path.join(HERE, f"boat_pixhawk_backup_{stamp}.param")
    with open(path, "w") as f:
        for k in sorted(params):
            f.write(f"{k},{params[k]:g}\n")
    print(f"\nBackup: {path}")
    bad = []
    for name, val, cur in changes:
        if armed(m):
            sys.exit("Armed during writing - stopped.")
        okd = set_param(m, name, val)
        print(f"  {'set ' if okd else 'FAIL'} {name} {fmt(cur)} -> {fmt(val)}")
        if not okd:
            bad.append(name)
    print("\nAll written and read back." if not bad else f"\nNOT written: {', '.join(bad)}")
    print("Restart the Pixhawk now (py pixhawk_setup.py --reboot) so GPS / compass / outputs take effect.")


def reboot(m):
    if armed(m):
        sys.exit("ARMED - not restarting.")
    m.mav.command_long_send(m.target_system, m.target_component,
                            mavutil.mavlink.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 0, 1, 0, 0, 0, 0, 0, 0)
    try:
        ack = m.recv_match(type="COMMAND_ACK", blocking=True, timeout=3)
    except Exception:                                   # noqa: BLE001 - USB vanished: it is restarting
        ack = None
        print("Restarting the Pixhawk (USB dropped as it restarted). Give it ~10 s.")
        return
    print("Restarting the Pixhawk." if ack and ack.result == 0 else f"Restart answer: {ack}")


def compass_cal(m):
    if armed(m):
        sys.exit("ARMED - disarm first.")
    print("Compass calibration. Do this with the Pixhawk MOUNTED IN THE BOAT, away from steel / laptops.\n"
          "Slowly turn the whole boat through every direction: level spins, nose up/down, on each side,\n"
          "upside down - until it reaches 100%. Ctrl+C cancels.")
    m.mav.command_long_send(m.target_system, m.target_component,
                            mavutil.mavlink.MAV_CMD_DO_START_MAG_CAL, 0, 0, 1, 1, 0, 0, 0, 0)
    reports, last_pct, t_end = {}, {}, time.time() + 300
    try:
        while time.time() < t_end:
            msg = m.recv_match(type=["MAG_CAL_PROGRESS", "MAG_CAL_REPORT", "COMMAND_ACK", "STATUSTEXT"],
                               blocking=True, timeout=1)
            if not msg:
                continue
            t = msg.get_type()
            if t == "COMMAND_ACK" and msg.command == mavutil.mavlink.MAV_CMD_DO_START_MAG_CAL and msg.result != 0:
                sys.exit(f"Pixhawk refused calibration (result {msg.result}).")
            elif t == "MAG_CAL_PROGRESS":
                if last_pct.get(msg.compass_id) != msg.completion_pct:
                    last_pct[msg.compass_id] = msg.completion_pct
                    print("  " + "   ".join(f"compass {i}: {p}%" for i, p in sorted(last_pct.items())), flush=True)
            elif t == "MAG_CAL_REPORT":
                good = msg.cal_status == mavutil.mavlink.MAG_CAL_SUCCESS
                reports[msg.compass_id] = good
                print(f"  compass {msg.compass_id}: {'SUCCESS' if good else 'FAILED'}  fitness {msg.fitness:.1f}  "
                      f"offsets {msg.ofs_x:.0f},{msg.ofs_y:.0f},{msg.ofs_z:.0f}")
                if len(reports) >= len(last_pct):
                    break
            elif t == "STATUSTEXT":
                print("  Pixhawk:", msg.text)
    except KeyboardInterrupt:
        m.mav.command_long_send(m.target_system, m.target_component,
                                mavutil.mavlink.MAV_CMD_DO_CANCEL_MAG_CAL, 0, 0, 0, 0, 0, 0, 0, 0)
        sys.exit("Cancelled.")
    if reports and all(reports.values()):
        print("Calibration saved. Restart the Pixhawk: py pixhawk_setup.py --reboot")
    else:
        print("Calibration did not succeed - try again, turning more slowly through ALL directions.")


if __name__ == "__main__":
    main()
