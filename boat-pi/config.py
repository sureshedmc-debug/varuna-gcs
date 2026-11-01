"""
Boat backend settings.

Every value has a safe default, can be overridden by an environment variable
(handy in the systemd unit), and finally by boat_config.json next to this file
(handy when editing on the Pi). Order of precedence: JSON file > env > default.
"""

import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "boat_config.json"
DATA_DIR = HERE / "data"

DEFAULTS = {
    # How the Pi reaches the Pixhawk. TELEM2 wired to the Pi's UART is
    # /dev/serial0 @ 57600; a USB cable is /dev/ttyACM0 @ 115200.
    "mav_connection": "/dev/serial0",
    "mav_baud": 57600,
    # HTTP port the VARUNA app connects to (over NetBird).
    "http_port": 8000,
    # Collection behaviour.
    "default_hold_s": 8,          # seconds the boat waits over each plastic item
    "default_speed_mps": 0.8,     # cruise speed between items (DO_CHANGE_SPEED)
    "max_waypoints": 60,
    # Switch the motors off once the collection is finished and the boat is back,
    # so it is safe to lift out of the water. It then floats until told otherwise.
    "disarm_on_complete": True,
    # Safety: reject any target farther than this from the boat (metres).
    "max_distance_m": 1500,
    # The intake roller (collector.py): the Pixhawk output its ESC is on (0 = none;
    # that output's SERVOn_FUNCTION must be 0). Runs near each item and on R1.
    "collector_servo": 0,
    "collector_pwm_on": 1800,         # roller running (a forward/reverse brushed ESC: >1500 = forward)
    "collector_pwm_off": 1500,        # roller stopped: 1500 for a forward/reverse ESC, 1000 for forward-only
    # ...or a relay module on a Pi GPIO pin (BCM number, 0 = none; overrides the ESC output).
    "collector_relay_gpio": 0,
    "collector_relay_active_low": True,   # most relay modules: IN pulled low = on
    # What to do if the VARUNA app stops talking to the boat during a mission
    # (e.g. NetBird drops): "none" keeps collecting, "hold" stops, "rtl" comes home.
    "operator_lost_action": "none",
    "operator_lost_s": 30,
    # Simulator start position (used only with --sim): Hussain Sagar, Hyderabad.
    "sim_home_lat": 17.4239,
    "sim_home_lng": 78.4738,

    # ---- Camera (USB webcam over the intake ramp, looking forward and down).
    # 640x360 at 15 fps keeps a Pi Zero's software JPEG encoder within budget.
    "camera_source": "auto",          # auto | csi | usb | phone | test | sim | off
    "camera_device": "auto",
    "camera_width": 640,
    "camera_height": 360,
    "camera_fps": 15,
    "camera_quality": 75,
    "stream_fps": 15,
    # An Android phone on the USB cable (camera_source "phone"): captured at the
    # phone's full 1080p / 30 fps and passed straight through (no re-encoding);
    # the app is sent stream_fps of those frames, as Wi-Fi + NetBird allow.
    # Phones with USB webcam mode (Android 14+) are used directly; others run the
    # IP Webcam app, reached over USB debugging (adb) on phone_app_port.
    "phone_width": 1920,
    "phone_height": 1080,
    "phone_fps": 30,
    "phone_app_port": 8080,
    "ffmpeg_path": "ffmpeg",
    "telemetry_hz": 4.0,              # live telemetry pushes to the app per second
    # Pi Zero: lighter defaults (LITE_PROFILE) so a single slow core keeps up.
    # auto = on a Pi Zero only; on / off to force it. Values set in the file still win.
    "lite_mode": "auto",
    # ---- Driving by hand.
    # transmitter: an RC transmitter on the Pixhawk (the Pi sends no stick commands).
    # gamepad: no transmitter; a game controller on the PC drives the boat through
    #   the app. The Pi then sends the Pixhawk stick values (RC override, steering
    #   on channel 1, throttle on 3) ten times a second, ALWAYS — neutral unless
    #   someone is driving — so the Pixhawk sees a live "radio": it can arm and run
    #   missions, and if the Pi dies its own radio failsafe stops the boat (FS_ACTION).
    "rc_source": "transmitter",
    "gamepad_max_throttle": 0.6,      # full stick = this share of full throttle
    "gamepad_throttle_expo": 0.5,     # 0 = linear; higher = gentler near the centre, full at the end
    "gamepad_timeout_s": 0.5,         # no controller input this long → sticks centred
    "gamepad_lost_s": 3.0,            # …this long while driving in MANUAL → HOLD
    # Where the camera sits: used to turn a spot in the picture into a spot on the water.
    "camera_height_m": 0.6,           # lens height above the water
    "camera_tilt_deg": 15,            # below the horizon: 15° sees from the ramp (~1.2 m) out to ~20 m
    "camera_hfov_deg": 66,            # the webcam's horizontal field of view (from its spec sheet)
    # Picture layout (fractions of the frame height/width), shared with the app.
    "ramp_top": 0.78,                 # the ramp fills the picture below this line
    "count_line": 0.55,               # counting line, as a fraction of the ramp band
    "zone_x1": 0.25, "zone_x2": 0.75, # wildlife danger zone: centre strip…
    "zone_y1": 0.30,                  # …from this height (~5 m ahead) down to the ramp

    # ---- Last-metre homing
    "homing_enabled": True,
    "homing_start_m": 8.0,            # take over this close to a plastic point
    "homing_speed_mps": 0.4,          # crawl speed while homing
    "homing_accept_m": 6.0,           # plastic seen farther than this from the point is ignored
    "homing_search_s": 25.0,          # give up if nothing is seen for this long
    "homing_lost_s": 3.0,             # tracked item out of sight this long → search again
    "homing_capture_m": 1.5,          # this close (just before the ramp hides it): drive straight through
    "homing_drive_through_m": 1.5,
    "homing_confirm_s": 4.0,          # wait this long for the catch counter after a capture
    # ---- Live collect (live_collect.py): the boat goes after the drone's finds, no planned mission.
    "live_arrive_m": 1.5,             # this close to an item (no camera homing): drive through it
    "live_roller_on_m": 5.0,          # intake roller on this close to an item
    "live_dwell_s": 4.0,              # after driving through: wait this long for the ramp
    "live_merge_m": 2.0,              # a new find this close to a queued one is the same item
    "live_return_after_s": 30.0,      # "return when empty": nothing new for this long → home
    "live_target_timeout_s": 180.0,   # give up on an item not reached in this time

    # ---- Wildlife-safe mode
    "wildlife_enabled": True,
    "wildlife_clear_s": 5.0,          # danger zone empty this long → carry on
    "wildlife_alert_s": 60.0,         # still blocked after this long → ask the operator

    # ---- When the app's vision stops arriving (NetBird drop, laptop closed)
    "vision_timeout_s": 3.0,
    "on_vision_lost": "slow",         # continue | slow | hold
    "vision_lost_speed_mps": 0.4,

    # ---- Catch counter
    "bin_capacity_items": 75,
    "motion_sensitivity": 0.5,        # 0..1, used by the app's ramp motion check

    # ---- Turbidity sensor (analog module → ADS1115 ADC on I2C)
    "turbidity_enabled": True,
    "turb_i2c_bus": 1,
    "turb_i2c_addr": 72,              # 0x48
    "turb_channel": 0,                # ADS1115 input A0..A3
    "turb_divider": 1.5,              # sensor volts = ADC volts × this (10k/20k divider)
    "turb_clear_volts": 0.0,          # set by "Calibrate in clear water" (0 = not calibrated)
    "turb_ref_volts": 0.0,            # optional second point
    "turb_ref_ntu": 0.0,
    "turb_log_every_s": 2.0,
    "measure_s": 20.0,                # "Measure here": hold and average this long
}

_BOOL_KEYS = {"disarm_on_complete", "homing_enabled", "wildlife_enabled", "turbidity_enabled",
              "collector_relay_active_low"}
_INT_KEYS = {"mav_baud", "http_port", "max_waypoints", "collector_servo", "collector_pwm_on", "collector_pwm_off",
             "collector_relay_gpio",
             "operator_lost_s", "camera_width", "camera_height", "camera_fps", "camera_quality", "stream_fps",
             "bin_capacity_items", "turb_i2c_bus", "turb_i2c_addr", "turb_channel",
             "phone_width", "phone_height", "phone_fps", "phone_app_port"}
_FLOAT_KEYS = {"default_hold_s", "default_speed_mps", "max_distance_m", "sim_home_lat", "sim_home_lng",
               "camera_height_m", "camera_tilt_deg", "camera_hfov_deg", "ramp_top", "count_line",
               "zone_x1", "zone_x2", "zone_y1",
               "homing_start_m", "homing_speed_mps", "homing_accept_m", "homing_search_s", "homing_lost_s",
               "homing_capture_m", "homing_drive_through_m", "homing_confirm_s",
               "live_arrive_m", "live_roller_on_m", "live_dwell_s", "live_merge_m", "live_return_after_s",
               "live_target_timeout_s",
               "wildlife_clear_s", "wildlife_alert_s", "vision_timeout_s", "vision_lost_speed_mps",
               "motion_sensitivity", "turb_divider", "turb_clear_volts", "turb_ref_volts", "turb_ref_ntu",
               "turb_log_every_s", "measure_s", "telemetry_hz",
               "gamepad_max_throttle", "gamepad_throttle_expo", "gamepad_timeout_s", "gamepad_lost_s"}

# Pi Zero defaults: the camera's JPEG encoding is done in software, on one slow
# core, and the video goes over NetBird; 10 fps at quality 70 is about half the
# CPU and bandwidth of 15 fps at 75, and still plenty for the app's AI (it checks
# for plastic 3x a second) and the catch counter (an item rides the ramp ~16 frames).
LITE_PROFILE = {"camera_fps": 10, "stream_fps": 10, "camera_quality": 70, "telemetry_hz": 2.0}


def pi_model():
    """'Raspberry Pi Zero W Rev 1.1' etc., or '' when not on a Raspberry Pi."""
    try:
        return Path("/proc/device-tree/model").read_bytes().decode("utf-8", "replace").strip("\x00 \n")
    except OSError:
        return ""

# Settings the app can change live (Boat Vision → Settings, Water Lab →
# Calibrate). Each: (type, min, max) or a tuple of allowed strings.
TUNABLE = {
    "homing_enabled": ("bool",), "wildlife_enabled": ("bool",), "turbidity_enabled": ("bool",),
    "homing_start_m": ("float", 3, 20), "homing_speed_mps": ("float", 0.2, 1.5),
    "homing_search_s": ("float", 5, 120), "homing_capture_m": ("float", 0.4, 3),
    "wildlife_clear_s": ("float", 2, 60), "wildlife_alert_s": ("float", 10, 600),
    "on_vision_lost": ("continue", "slow", "hold"), "vision_lost_speed_mps": ("float", 0.2, 1.5),
    "bin_capacity_items": ("int", 5, 2000), "motion_sensitivity": ("float", 0.05, 1),
    "camera_height_m": ("float", 0.1, 3), "camera_tilt_deg": ("float", 5, 85), "camera_hfov_deg": ("float", 30, 130),
    "ramp_top": ("float", 0.5, 1), "count_line": ("float", 0.1, 0.9),
    "zone_x1": ("float", 0, 0.5), "zone_x2": ("float", 0.5, 1), "zone_y1": ("float", 0, 0.95),
    "measure_s": ("float", 5, 120), "turb_divider": ("float", 1, 3),
    "gamepad_max_throttle": ("float", 0.1, 1),
    "gamepad_throttle_expo": ("float", 0, 0.9),
    "live_arrive_m": ("float", 0.5, 5), "live_roller_on_m": ("float", 1, 20), "live_dwell_s": ("float", 0, 30),
    "live_merge_m": ("float", 0.5, 10), "live_return_after_s": ("float", 5, 600),
    "live_target_timeout_s": ("float", 30, 900),
    "collector_servo": ("int", 0, 16),
    "collector_pwm_on": ("int", 1000, 2000), "collector_pwm_off": ("int", 1000, 2000),
    "collector_relay_gpio": ("int", 0, 27), "collector_relay_active_low": ("bool",),
}


def tune(cfg, patch):
    """Validate and apply live settings. Returns (applied: dict, errors: dict)."""
    applied, errors = {}, {}
    for key, value in (patch or {}).items():
        spec = TUNABLE.get(key)
        if spec is None:
            errors[key] = "not a live setting"
            continue
        try:
            if spec[0] == "bool":
                v = _coerce("disarm_on_complete", value)
            elif spec[0] in ("float", "int"):
                v = float(value)
                if not (spec[1] <= v <= spec[2]):
                    raise ValueError(f"must be between {spec[1]} and {spec[2]}")
                v = int(round(v)) if spec[0] == "int" else v
            else:
                v = str(value).strip().lower()
                if v not in spec:
                    raise ValueError(f"must be one of: {', '.join(spec)}")
        except (TypeError, ValueError) as exc:
            errors[key] = str(exc)
            continue
        cfg[key] = v
        applied[key] = v
    if cfg["zone_x2"] <= cfg["zone_x1"]:
        errors["zone_x2"] = "must be right of zone_x1"
    return applied, errors


def _coerce(key, value):
    if key in _BOOL_KEYS:
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if key in _INT_KEYS:
        return int(round(float(value)))
    if key in _FLOAT_KEYS:
        return float(value)
    return str(value)


def load_config():
    cfg = dict(DEFAULTS)
    chosen = set()                     # keys set on purpose (env or file): the lite profile leaves them alone
    for key in DEFAULTS:
        env = os.environ.get("BOAT_" + key.upper())
        if env not in (None, ""):
            try:
                cfg[key] = _coerce(key, env)
                chosen.add(key)
            except ValueError:
                pass
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            print(f"[config] ignoring unreadable {CONFIG_PATH.name}: {exc}")
            data = {}
        for key, value in (data if isinstance(data, dict) else {}).items():
            if key in DEFAULTS:
                # One bad value (e.g. "mav_baud": "fast") must not stop the boat
                # backend from starting: keep the default for that key only.
                try:
                    cfg[key] = _coerce(key, value)
                    chosen.add(key)
                except (ValueError, TypeError) as exc:
                    print(f"[config] ignoring {key}={value!r}: {exc}")
    if cfg["operator_lost_action"] not in ("none", "hold", "rtl"):
        cfg["operator_lost_action"] = "none"
    if cfg["on_vision_lost"] not in ("continue", "slow", "hold"):
        cfg["on_vision_lost"] = "slow"
    mode = str(cfg["lite_mode"]).lower()
    cfg["lite"] = mode == "on" or (mode == "auto" and "Pi Zero" in pi_model())
    if cfg["lite"]:
        for key, value in LITE_PROFILE.items():
            if key not in chosen:
                cfg[key] = value
    cfg["telemetry_hz"] = max(0.5, min(10.0, float(cfg["telemetry_hz"])))
    if cfg["rc_source"] not in ("transmitter", "gamepad"):
        cfg["rc_source"] = "transmitter"
    cfg["gamepad_max_throttle"] = max(0.1, min(1.0, float(cfg["gamepad_max_throttle"])))
    cfg["gamepad_throttle_expo"] = max(0.0, min(0.9, float(cfg["gamepad_throttle_expo"])))
    return cfg


def save_settings(patch):
    """Merge `patch` into boat_config.json (keeps everything else in the file)."""
    data = {}
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    data.update(patch)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_PATH)
