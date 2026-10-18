"""
Drone backend settings.

Every value has a safe default, can be overridden by an environment variable
(DRONE_<KEY>, handy in the systemd unit) and finally by drone_config.json next
to this file (written by the installer and by "Save to disk" in the app).
Order of precedence: JSON file > env > default.

TUNABLE lists the settings the app can change live (System → Live tuning).
"""

import json
import os
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "drone_config.json"
DATA_DIR = HERE / "data"

DEFAULTS = {
    # ---- Pixhawk link
    # Set mav_connection to force one link (e.g. "tcp:127.0.0.1:5760" for SITL).
    # Left empty, the link follows link_prefer: "auto" tries USB first, then TELEM2.
    "mav_connection": "",
    "usb_device": "/dev/ttyACM0",
    "usb_baud": 115200,
    "telem2_device": "/dev/serial0",
    "telem2_baud": 57600,
    "link_prefer": "auto",
    # ---- HTTP
    "http_port": 8000,
    # ---- Camera: 1280x720 at 30 fps
    "camera_source": "auto",          # auto | usb | csi | test | off
    "camera_device": "auto",          # auto = first USB camera, or e.g. /dev/video0
    "camera_width": 1280,
    "camera_height": 720,
    "camera_fps": 30,
    "camera_quality": 80,             # JPEG quality when the Pi has to encode (CSI / fallback)
    "ffmpeg_path": "ffmpeg",
    # ---- Flight safety (live-tunable)
    "stream_fps": 30,
    "takeoff_alt_m": 10,
    "max_altitude_m": 120,
    "loiter_time_s": 10,
    "max_distance_m": 1500,
    "max_waypoints": 100,
    "operator_lost_action": "none",   # none | rtl | land
    "operator_lost_s": 30,
    # ---- Keyboard flight (app → Control tab; GUIDED velocity, see control.py)
    "kb_speed_mps": 2.0,              # W A S D: horizontal speed
    "kb_climb_mps": 0.8,              # up / down arrows: climb / descend speed
    "kb_yaw_dps": 45,                 # left / right arrows: turn rate (degrees per second)
    "kb_min_alt_m": 3.0,              # the keyboard never descends below this (land with LAND)
    "kb_lost_action": "rtl",          # no keys from the app for kb_lost_s while flying: rtl | land | hover
    "kb_lost_s": 20,
    # ---- Misc
    "operator_pin": "",               # empty = no PIN check
    "web_root": "",                   # optional: folder with the built VARUNA web app
}

# Live-tunable settings, shown in the app as sliders / fields.
TUNABLE = {
    "camera_source": {"type": "str", "options": ["auto", "usb", "csi", "off"],
                      "description": "Which camera: auto (USB webcam if plugged in, else the Pi camera module), "
                                     "usb, csi (Pi camera module) or off. Switches straight away."},
    "stream_fps": {"type": "int", "min": 1, "max": 30,
                   "description": "Video frames per second sent to the app (lower it on a weak link)."},
    "takeoff_alt_m": {"type": "float", "min": 2, "max": 50,
                      "description": "Default take-off height in metres."},
    "max_altitude_m": {"type": "float", "min": 5, "max": 120,
                       "description": "Highest altitude any take-off or mission may use (metres)."},
    "loiter_time_s": {"type": "int", "min": 1, "max": 120,
                      "description": "Seconds the drone hovers at a 'loiter' waypoint."},
    "max_distance_m": {"type": "float", "min": 50, "max": 5000,
                       "description": "Mission points farther than this from home are rejected (metres)."},
    "operator_lost_action": {"type": "str", "options": ["none", "rtl", "land"],
                             "description": "If the app goes silent during a mission: none, rtl (come home) or land."},
    "operator_lost_s": {"type": "int", "min": 5, "max": 300,
                        "description": "Seconds of silence from the app before that action."},
    "kb_speed_mps": {"type": "float", "min": 0.5, "max": 5,
                     "description": "Keyboard flight: horizontal speed with W A S D (m/s)."},
    "kb_climb_mps": {"type": "float", "min": 0.2, "max": 2,
                     "description": "Keyboard flight: climb / descend speed with the up / down arrows (m/s)."},
    "kb_yaw_dps": {"type": "int", "min": 10, "max": 90,
                   "description": "Keyboard flight: turn rate with the left / right arrows (degrees per second)."},
    "kb_min_alt_m": {"type": "float", "min": 1, "max": 30,
                     "description": "Keyboard flight never descends below this height (use LAND to land)."},
    "kb_lost_action": {"type": "str", "options": ["rtl", "land", "hover"],
                       "description": "No keys from the app while flying by keyboard: rtl (come home), land, or hover."},
    "kb_lost_s": {"type": "int", "min": 5, "max": 120,
                  "description": "Seconds without keys from the app before that action."},
}

_INT = {"usb_baud", "telem2_baud", "http_port", "camera_width", "camera_height", "camera_fps",
        "camera_quality", "stream_fps", "loiter_time_s", "max_waypoints", "operator_lost_s",
        "kb_yaw_dps", "kb_lost_s"}
_FLOAT = {"takeoff_alt_m", "max_altitude_m", "max_distance_m", "kb_speed_mps", "kb_climb_mps", "kb_min_alt_m"}
_CHOICES = {
    "link_prefer": ("auto", "usb", "telem2"),
    "camera_source": ("auto", "usb", "csi", "test", "off"),
    "operator_lost_action": ("none", "rtl", "land"),
    "kb_lost_action": ("rtl", "land", "hover"),
}


def coerce(key, value):
    if key in _INT:
        return int(round(float(value)))
    if key in _FLOAT:
        return float(value)
    value = str(value).strip()
    if key in _CHOICES and value.lower() not in _CHOICES[key]:
        raise ValueError(f"must be one of: {', '.join(_CHOICES[key])}")
    return value.lower() if key in _CHOICES else value


class ConfigStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._runtime = set()      # set from the command line: never written to disk
        self.values = dict(DEFAULTS)
        for key in DEFAULTS:
            env = os.environ.get("DRONE_" + key.upper())
            if env not in (None, ""):
                try:
                    self.values[key] = coerce(key, env)
                except ValueError:
                    pass
        if CONFIG_PATH.exists():
            try:
                data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                for key, value in data.items():
                    if key in DEFAULTS:
                        try:
                            self.values[key] = coerce(key, value)
                        except ValueError as exc:
                            print(f"[config] ignoring {key}: {exc}")
            except (ValueError, OSError) as exc:
                print(f"[config] ignoring unreadable {CONFIG_PATH.name}: {exc}")

    def __getitem__(self, key):
        return self.values[key]

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        with self._lock:
            self.values[key] = coerce(key, value)
            self._runtime.discard(key)
            return self.values[key]

    def set_runtime(self, key, value):
        """A temporary override (command line): used now, never saved."""
        with self._lock:
            self.values[key] = coerce(key, value)
            self._runtime.add(key)

    def schema(self):
        """The live-tunable settings in the shape the app's Live tuning panel reads."""
        out = {}
        for key, meta in TUNABLE.items():
            out[key] = {"value": self.values[key], **meta}
        return out

    def update(self, patch):
        """Apply live changes; returns {success, message, settings, errors}."""
        errors, changed = {}, []
        for key, value in (patch or {}).items():
            if key not in TUNABLE:
                continue
            meta = TUNABLE[key]
            try:
                v = coerce(key, value)
                if "options" in meta and v not in meta["options"]:
                    raise ValueError(f"must be one of: {', '.join(meta['options'])}")
                if "min" in meta and v < meta["min"]:
                    raise ValueError(f"must be at least {meta['min']}")
                if "max" in meta and v > meta["max"]:
                    raise ValueError(f"must be at most {meta['max']}")
            except (ValueError, TypeError) as exc:
                errors[key] = str(exc)
                continue
            if self.values[key] != v:
                self.set(key, v)
                changed.append(key)
        ok = not errors
        msg = (f"Applied: {', '.join(changed)}." if changed else "Nothing changed.") if ok \
            else f"Some values were rejected: {', '.join(errors)}."
        return {"success": ok, "message": msg, "settings": self.schema(), "errors": errors}

    def save(self):
        """Persist everything that differs from the defaults to drone_config.json."""
        with self._lock:
            existing = {}
            if CONFIG_PATH.exists():
                try:
                    existing = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    existing = {}
            # Keys already in the file are always rewritten (a value set back to
            # its default must not keep the old one); others only if changed.
            for k, v in self.values.items():
                if k in self._runtime:
                    continue
                if v != DEFAULTS[k] or k in existing:
                    existing[k] = v
            tmp = CONFIG_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(existing, indent=2), encoding="utf-8")
            tmp.replace(CONFIG_PATH)
