"""
Water turbidity along the boat's route.

The analog turbidity module (e.g. DFRobot SEN0189) gives 0–4.5 V: clear water
lets more light through and reads high, murky water reads low. A Raspberry Pi
has no analog input, so an ADS1115 ADC on I2C reads it:

    sensor VCC → 5 V, GND → GND, signal → 10 kΩ → ADS1115 A0, A0 → 20 kΩ → GND
    ADS1115 VDD → 3.3 V, GND → GND, SDA → GPIO2 (pin 3), SCL → GPIO3 (pin 5)

The divider keeps A0 under 3.3 V; `turb_divider` (1.5) scales it back.

Volts → NTU (nephelometric turbidity units, lower = clearer):
  * not calibrated: the module maker's curve, valid 2.5–4.2 V;
  * "Calibrate in clear water" stores the clear-water voltage and shifts the
    curve so that reads 0 NTU (each probe and supply voltage differs a little);
  * with a second reference sample of known NTU, a straight line between the
    two points is used instead.

A reading is logged every `turb_log_every_s` with the boat's GPS position, so
the app can colour the route by water clarity. "Measure here" is a longer,
averaged reading taken while the boat holds still (see vision.py).
"""

import json
import logging
import math
import random
import threading
import time
from collections import deque

log = logging.getLogger("boat.water")

ADS_CONVERSION, ADS_CONFIG = 0x00, 0x01
ADS_FSR = 4.096                      # PGA ±4.096 V
MAX_TRACK = 20000


def maker_curve(v):
    """DFRobot SEN0189 curve: NTU from sensor volts (2.5–4.2 V)."""
    v = max(2.5, min(4.2, v))
    return max(0.0, -1120.4 * v * v + 5742.3 * v - 4352.9)


def quality(ntu):
    if ntu is None:
        return None
    if ntu < 10:
        return "Clear"
    if ntu < 50:
        return "Slightly cloudy"
    if ntu < 150:
        return "Cloudy"
    return "Murky"


class ADS1115:
    def __init__(self, bus, addr):
        from smbus2 import SMBus  # imported here: the laptop simulator doesn't need it
        self.bus = SMBus(bus)
        self.addr = addr

    def read_volts(self, channel):
        mux = 0x4000 | ((channel & 3) << 12)          # single-ended AINx vs GND
        cfg = 0x8000 | mux | 0x0200 | 0x0100 | 0x0080 | 0x0003   # start, ±4.096 V, single shot, 128 SPS, no comparator
        self.bus.write_i2c_block_data(self.addr, ADS_CONFIG, [(cfg >> 8) & 0xFF, cfg & 0xFF])
        time.sleep(0.01)
        hi, lo = self.bus.read_i2c_block_data(self.addr, ADS_CONVERSION, 2)
        raw = (hi << 8) | lo
        if raw & 0x8000:
            raw -= 1 << 16
        return raw * ADS_FSR / 32768.0

    def close(self):
        try:
            self.bus.close()
        except Exception:
            pass


class Turbidity:
    def __init__(self, cfg, data_dir, link, sim=False, save_settings=None):
        self.cfg = cfg
        self.link = link
        self.sim = sim
        self.save_settings = save_settings
        self.path = data_dir / "water_track.jsonl"
        self.readings_path = data_dir / "water_readings.json"
        self.track = deque(maxlen=MAX_TRACK)
        self.readings = []
        self._recent = deque(maxlen=12)        # last few raw volts (for smoothing)
        self._stop = threading.Event()
        self._thread = None
        self._adc = None
        self.connected = False
        self.error = None
        self.volts = None
        self.ntu = None
        self.updated = 0.0
        self._last_log = 0.0
        self._load()
        self._appended = len(self.track)

    # ------------------------------------------------------------------ storage
    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    try:
                        self.track.append(json.loads(line))
                    except ValueError:
                        pass
        except OSError:
            pass
        try:
            self.readings = json.loads(self.readings_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.readings = []

    def _append(self, point):
        self.track.append(point)
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(point) + "\n")
            # Keep the file from growing forever: once it holds about twice what
            # is kept in memory, rewrite it with just the kept points.
            self._appended += 1
            if self._appended >= MAX_TRACK:
                self._appended = 0
                tmp = self.path.with_suffix(".tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    for p in self.track:
                        f.write(json.dumps(p) + "\n")
                tmp.replace(self.path)
        except OSError as exc:
            log.warning("Could not save the water track: %s", exc)

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        if not self.cfg["turbidity_enabled"]:
            self.error = "Turbidity sensor switched off in the settings."
            return
        self._thread = threading.Thread(target=self._run, name="turbidity", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self._adc:
            self._adc.close()

    def _open(self):
        if self.sim:
            return True
        try:
            self._adc = ADS1115(self.cfg["turb_i2c_bus"], self.cfg["turb_i2c_addr"])
            self._adc.read_volts(self.cfg["turb_channel"])
            return True
        except ImportError as exc:
            self.error = f"Can't load the I2C library ({exc}) — run Update in the Boat Pi Tool."
        except (OSError, IOError) as exc:
            self.error = (f"No ADS1115 found on I2C bus {self.cfg['turb_i2c_bus']} at 0x{self.cfg['turb_i2c_addr']:02X} "
                          f"({exc}). Check SDA→pin 3, SCL→pin 5, 3.3 V and GND, and that I2C is enabled.")
        if self._adc:
            self._adc.close()
            self._adc = None
        return False

    def _read_sensor_volts(self):
        if self.sim:
            return self._sim_volts()
        return self._adc.read_volts(self.cfg["turb_channel"]) * self.cfg["turb_divider"]

    def _sim_volts(self):
        """Simulator: a murky patch north-east of home, clear elsewhere."""
        s = self.link.snapshot()
        lat, lng = s["lat"], s["lng"]
        hl, hg = self.cfg["sim_home_lat"], self.cfg["sim_home_lng"]
        ntu = 6.0
        if lat is not None:
            north = math.radians(lat - hl) * 6371000.0
            east = math.radians(lng - hg) * 6371000.0 * math.cos(math.radians(hl))
            ntu += 140 * math.exp(-((north - 25) ** 2 + (east - 20) ** 2) / (2 * 12 ** 2))
        ntu += random.uniform(-1.5, 1.5)
        # inverse of the maker curve, for a realistic voltage
        lo, hi = 2.5, 4.2
        for _ in range(30):
            mid = (lo + hi) / 2
            if maker_curve(mid) > ntu:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    def _run(self):
        while not self._stop.is_set():
            if not self.connected:
                self.connected = self._open()
                if not self.connected:
                    self._stop.wait(5)
                    continue
                self.error = None
                log.info("Turbidity sensor connected%s", " (simulated)" if self.sim else "")
            try:
                v = self._read_sensor_volts()
            except (OSError, IOError) as exc:
                self.connected = False
                self.error = f"Lost the ADS1115: {exc}"
                log.warning(self.error)
                if self._adc:
                    self._adc.close()
                    self._adc = None
                continue
            self._recent.append(v)
            vs = sorted(self._recent)
            self.volts = vs[len(vs) // 2]           # median: ignores bubbles and splashes
            self.ntu = round(self.to_ntu(self.volts), 1)
            self.updated = time.time()
            self._maybe_log()
            self._stop.wait(0.5)

    # ------------------------------------------------------------------ conversion
    def to_ntu(self, v):
        clear = self.cfg["turb_clear_volts"]
        ref_v, ref_ntu = self.cfg["turb_ref_volts"], self.cfg["turb_ref_ntu"]
        if clear > 0 and ref_v > 0 and ref_ntu > 0 and abs(clear - ref_v) > 0.05:
            return max(0.0, ref_ntu * (clear - v) / (clear - ref_v))
        if clear > 0:
            return maker_curve(v + (4.2 - clear))
        return maker_curve(v)

    def calibrate(self, action, ntu=None):
        if self.volts is None:
            raise ValueError("No reading from the sensor yet.")
        if action == "clear":
            patch = {"turb_clear_volts": round(self.volts, 3)}
            msg = f"Clear water set at {self.volts:.2f} V — it now reads 0 NTU."
        elif action == "reference":
            n = float(ntu or 0)
            if n <= 0:
                raise ValueError("Enter the reference sample's NTU (more than 0).")
            if self.cfg["turb_clear_volts"] <= 0:
                raise ValueError("Calibrate in clear water first.")
            patch = {"turb_ref_volts": round(self.volts, 3), "turb_ref_ntu": n}
            msg = f"Reference set: {n:g} NTU at {self.volts:.2f} V."
        elif action == "reset":
            patch = {"turb_clear_volts": 0.0, "turb_ref_volts": 0.0, "turb_ref_ntu": 0.0}
            msg = "Calibration cleared — using the sensor maker's curve."
        else:
            raise ValueError("Unknown calibration step.")
        self.cfg.update(patch)
        if self.save_settings and not self.sim:
            self.save_settings(patch)
        return msg

    # ------------------------------------------------------------------ logging
    def _maybe_log(self):
        now = time.time()
        if now - self._last_log < self.cfg["turb_log_every_s"]:
            return
        s = self.link.snapshot()
        if s["lat"] is None:
            return
        self._last_log = now
        self._append({"t": round(now, 1), "lat": round(s["lat"], 7), "lng": round(s["lng"], 7),
                      "ntu": self.ntu, "v": round(self.volts, 3)})

    def add_reading(self, ntu_values, volts_values, reason):
        s = self.link.snapshot()
        ntu = round(sum(ntu_values) / len(ntu_values), 1)
        reading = {
            "id": f"w{int(time.time() * 1000)}",
            "t": round(time.time(), 1),
            "lat": s["lat"], "lng": s["lng"],
            "ntu": ntu, "min": round(min(ntu_values), 1), "max": round(max(ntu_values), 1),
            "v": round(sum(volts_values) / len(volts_values), 3),
            "samples": len(ntu_values), "quality": quality(ntu), "reason": reason,
            "calibrated": self.cfg["turb_clear_volts"] > 0,
        }
        self.readings.append(reading)
        self.readings = self.readings[-500:]
        try:
            tmp = self.readings_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.readings, indent=1), encoding="utf-8")
            tmp.replace(self.readings_path)
        except OSError as exc:
            log.warning("Could not save the water reading: %s", exc)
        return reading

    # ------------------------------------------------------------------ views
    def fresh(self):
        return self.connected and time.time() - self.updated < 3

    def summary(self):
        ok = self.fresh()
        return {
            "connected": ok,
            "ntu": self.ntu if ok else None,
            "volts": round(self.volts, 3) if ok and self.volts is not None else None,
            "quality": quality(self.ntu) if ok else None,
            "calibrated": self.cfg["turb_clear_volts"] > 0,
            "error": None if ok else (self.error or "Waiting for the sensor…"),
            "simulated": self.sim,
        }

    def status(self):
        return {
            **self.summary(),
            "enabled": self.cfg["turbidity_enabled"],
            "clear_volts": self.cfg["turb_clear_volts"] or None,
            "ref_volts": self.cfg["turb_ref_volts"] or None,
            "ref_ntu": self.cfg["turb_ref_ntu"] or None,
            "last_reading": self.readings[-1] if self.readings else None,
        }

    def track_points(self, limit=2000, since=None):
        pts = list(self.track)
        if since:
            pts = [p for p in pts if p["t"] >= since]
        return pts[-limit:]
