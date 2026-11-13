"""Put the drone back on its most stable tune, with read-back of every value.

    py apply_tune.py COM10 baseline   # exactly the flight settings of log 149 (2026-11-05)
    py apply_tune.py COM10 tuned      # baseline + the fixes the logs prove (see TUNED below)
    py apply_tune.py COM10 check      # only show what would change

Refuses to touch an armed vehicle. Calibrations (accel, gyro, compass, level
trim, baro) are never changed, and neither are the pilot's own safety choices:
12 V battery failsafe, fence off, auto-disarm after landing, the Pi's TELEM2
setup, and light logging. AutoTune is never put on a switch.
"""
import sys
import time

from pymavlink import mavutil

# Flight-behaviour settings as they were in log 149 (the flights rated most stable).
BASELINE = {
    # roll / pitch rate gains
    "ATC_RAT_RLL_P": 0.11, "ATC_RAT_RLL_I": 0.11, "ATC_RAT_RLL_D": 0.0025, "ATC_RAT_RLL_SMAX": 0,
    "ATC_RAT_PIT_P": 0.11, "ATC_RAT_PIT_I": 0.11, "ATC_RAT_PIT_D": 0.0025, "ATC_RAT_PIT_SMAX": 0,
    "ATC_THR_MIX_MAX": 0.5,
    # vibration filters
    "INS_HNTCH_FREQ": 70, "INS_HNTCH_BW": 35, "INS_HNTCH_REF": 0.26, "INS_HNTCH_HMNCS": 3,
    "INS_HNTC2_ENABLE": 1,
    # height control
    "PSC_ACCZ_P": 0.5, "PSC_ACCZ_I": 1.0, "PILOT_SPEED_DN": 0,
    "MOT_THST_HOVER": 0.2592, "MOT_HOVER_LEARN": 2,
    # Loiter, GPS and position estimate
    "LOIT_BRK_ACCEL": 90, "EK3_POSNE_M_NSE": 0.3,
    "GPS1_RATE_MS": 200, "GPS_MIN_ELEV": -100, "GPS_SBAS_MODE": 2,
}

# Changes on top of the baseline that the downloaded logs (137-156) back up.
TUNED_CHANGES = {
    # Airborne gyro batch data (logs 149, 152) puts the motor vibration at ~100 Hz
    # (88-110) with harmonics at ~195 and ~290 Hz; 70 Hz missed it. Hover throttle 0.22.
    "INS_HNTCH_FREQ": 95, "INS_HNTCH_BW": 45, "INS_HNTCH_REF": 0.22, "INS_HNTCH_HMNCS": 7,
    # The fixed 80 Hz notch sat below the real noise and only added delay.
    "INS_HNTC2_ENABLE": 0,
    # Start every flight from the measured hover throttle (0.219 airborne, logs 152/155);
    # still learn in flight, but don't save it: log 155 saved 0.16, learned in ground effect.
    "MOT_THST_HOVER": 0.22, "MOT_HOVER_LEARN": 1,
    # Log 152: in a gust and on landing, throttle fell to ~0 and the drone lost its
    # angle (tipped on landing). Let attitude control win over throttle.
    "ATC_THR_MIX_MAX": 0.9,
    # Stick-down descent was 2.5 m/s (it used the climb speed); that cut the throttle.
    "PILOT_SPEED_DN": 100,
}

# Kept as the pilot set them, whichever profile is applied.
KEEP = {
    "BATT_LOW_VOLT": 12.0, "BATT_CRT_VOLT": 11.4, "BATT_ARM_VOLT": 13.6,
    "BATT_FS_VOLTSRC": 0, "BATT_LOW_TIMER": 10,
    "FENCE_ENABLE": 0, "RC8_OPTION": 0, "DISARM_DELAY": 10,
    "LOG_BITMASK": 180222, "INS_LOG_BAT_MASK": 0,
}

NEEDS_REBOOT = {"INS_HNTC2_ENABLE", "INS_LOG_BAT_MASK", "GPS1_RATE_MS"}


def connect(port):
    m = mavutil.mavlink_connection(port, baud=115200, source_system=254)
    if m.wait_heartbeat(timeout=15) is None:
        sys.exit("No heartbeat from the Pixhawk.")
    m.mav.request_data_stream_send(m.target_system, m.target_component,
                                   mavutil.mavlink.MAV_DATA_STREAM_ALL, 0, 0)
    return m


def read(m, name):
    for _ in range(3):
        m.mav.param_request_read_send(m.target_system, m.target_component, name.encode(), -1)
        end = time.time() + 1.5
        while time.time() < end:
            r = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=0.5)
            if r is not None and r.param_id == name:
                return r.param_value
    return None


def write(m, name, value):
    for _ in range(3):
        m.mav.param_set_send(m.target_system, m.target_component, name.encode(), float(value),
                             mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        end = time.time() + 2
        while time.time() < end:
            r = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=0.5)
            if r is not None and r.param_id == name:
                if abs(r.param_value - value) <= 1e-4 * max(1, abs(value)):
                    return r.param_value
                break
    return None


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("baseline", "tuned", "check"):
        sys.exit(__doc__)
    port, profile = sys.argv[1], sys.argv[2]
    want = dict(BASELINE)
    if profile in ("tuned", "check"):
        want.update(TUNED_CHANGES)
    want.update(KEEP)

    m = connect(port)
    if m.motors_armed():
        sys.exit("ARMED: not changing anything.")
    changes = []
    for name, value in want.items():
        now = read(m, name)
        if now is None:
            print(f"  ?    {name}: no answer from the Pixhawk")
        elif abs(now - value) > 1e-4 * max(1, abs(value)):
            changes.append((name, now, value))
    if not changes:
        print("Already on this tune - nothing to change.")
        return
    for name, now, value in changes:
        print(f"  {name:18s} {now:g} -> {value:g}")
    if profile == "check":
        return
    bad = 0
    for name, now, value in changes:
        if write(m, name, value) is None:
            bad += 1
            print(f"  FAIL {name}")
    print(f"{len(changes) - bad}/{len(changes)} set and read back.")
    if any(n in NEEDS_REBOOT for n, _, _ in changes) and not bad:
        m.mav.command_long_send(m.target_system, m.target_component,
                                mavutil.mavlink.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 0, 1, 0, 0, 0, 0, 0, 0)
        print("Rebooting the Pixhawk so the filter/logging changes take effect.")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
