"""Raspberry Pi health for System → Raspberry Pi and the app's warning banner."""

import platform
import shutil
import subprocess
import time

import psutil

psutil.cpu_percent(percpu=True)  # prime: the first reading is always 0
_BOOT = psutil.boot_time()


def _temperature():
    read = getattr(psutil, "sensors_temperatures", None)
    if not read:
        return None
    try:
        temps = read() or {}
    except Exception:
        return None
    for key in ("cpu_thermal", "coretemp", "soc_thermal", "k10temp"):
        if temps.get(key):
            return round(temps[key][0].current, 1)
    for entries in temps.values():
        if entries:
            return round(entries[0].current, 1)
    return None


def throttled_state():
    """Decode `vcgencmd get_throttled` (under-voltage, throttling) on a Pi; None elsewhere."""
    if not shutil.which("vcgencmd"):
        return None
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=3).stdout
        value = int(out.strip().split("=")[1], 16)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    return {
        "raw": hex(value),
        "under_voltage": bool(value & 0x1),
        "frequency_capped": bool(value & 0x2),
        "throttled": bool(value & 0x4),
        "soft_temp_limit": bool(value & 0x8),
        "under_voltage_occurred": bool(value & 0x10000),
        "throttling_occurred": bool(value & 0x40000),
    }


def pi_metrics(processes=False):
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    out = {
        "cpu_per_core": [{"percent": p} for p in psutil.cpu_percent(percpu=True)],
        "cpu_percent": psutil.cpu_percent(),
        "cpu_count": psutil.cpu_count(logical=True),
        "ram_percent": ram.percent,
        "ram_used_mb": round(ram.used / 1048576),
        "ram_total_mb": round(ram.total / 1048576),
        "disk_percent": disk.percent,
        "temperature": _temperature(),
        "throttled_state": throttled_state(),
        "uptime_s": round(time.time() - _BOOT),
        "platform": platform.platform(),
    }
    if processes:
        procs = []
        for p in psutil.process_iter(["pid", "name", "memory_percent", "cpu_percent"]):
            info = p.info
            procs.append({"pid": info["pid"], "name": info["name"],
                          "memory_percent": round(info["memory_percent"] or 0, 1),
                          "cpu_percent": round(info["cpu_percent"] or 0, 1)})
        procs.sort(key=lambda x: x["memory_percent"], reverse=True)
        out["processes"] = procs[:6]
    return out
