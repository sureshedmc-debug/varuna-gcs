"""
The boat program (main.py) with the drone -> boat collection extras, started by
find_boat.py --run.

Scoop servo (MAIN OUT 2): never jumps. It glides along an S-curve (slow start,
slow stop, no jerk) whose PEAK speed is scoop_speed_pct of the servo's own top
speed (default 50 %, a 25 kg digital servo ~0.15 s/60°). A new command mid-move
turns it round from where it is. When the program (re)starts it takes over the
position the Pixhawk already gives the servo, so nothing moves.

Automatic collection: when the camera homing reaches the capture point of a
drone target (state COLLECTING), the scoop glides to its extreme, holds, and
glides back to 0 -- but ONLY if every check passes (auto collection ON, live
collect running, near the drone's GPS point, camera on, image match >= the
threshold, slow enough, Pixhawk connected + armed + GUIDED + 3D fix + no
critical error, scoop at 0 and still). A failed check is logged and nothing
moves. The operator can abort at any time (the scoop glides back to 0).

Second servo (MAIN OUT 4): SwA on the FS-i6 (CH5) passed straight through by
the Pixhawk (SERVO4_FUNCTION 55). This program only READS it for the app.

Driving is by the FS-i6 transmitter straight into the Pixhawk (CH3 throttle,
CH4 rudder, SwD on CH8 = MANUAL / ACRO); boat_config.json has rc_source
"transmitter", so this program never sends stick values. Flipping SwD takes
over from any automatic mode.

Motor on drone signal: a NEW plastic find from the drone (POST
/api/live/targets) runs the motor at motor_power_pct (50 % = 1500 µs at the
ESC) for motor_run_s, by overriding CH3 only — no steering, no GUIDED, no
correction; the rudder stays on the transmitter. Only when the boat is ARMED
in MANUAL. STOP / SwD / disarm hand the throttle straight back (MotorPush).

Also here: the phone's own GPS (VARUNA Boat Link /status.json) next to the
Pixhawk's telemetry, live distance / bearing to the drone target, the operator
banners and alerts, and one timestamped event log (data/ops_events.log), all
at /api/ops/... for the app's Boat Ops screen.

Camera: when the launcher found the phone's camera it sets BOAT_CAMERA_URL
(http://<phone>:8080/video, VARUNA Boat Link's MJPEG) and the boat's camera
reads it over Wi-Fi, so live view, camera homing and wildlife work as on the Pi.

main.py, camera.py and collector.py stay as they are: their classes are
extended here before main.py starts.

    py boat_extras.py --connection tcp:<esp32>:5760 --port 8001
"""

import json
import logging
import math
import os
import sys
import threading
import time
import urllib.request
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

import camera  # noqa: E402
import camera_model  # noqa: E402
import collector  # noqa: E402
import mav_link  # noqa: E402
import vision  # noqa: E402
from mav_link import LinkError  # noqa: E402

log = logging.getLogger("boat.extras")

# ---------------------------------------------------------------- phone camera over Wi-Fi
_cam_attempts = camera.CameraManager._attempts


def _cam_attempts_url(self):
    url = os.environ.get("BOAT_CAMERA_URL")
    if not url:
        return _cam_attempts(self)
    # curl hands the phone's JPEGs straight over (no re-encoding on the laptop).
    return "phone", url, [
        ("Boat phone camera over Wi-Fi", "phone",
         ["curl", "-sSN", "--tcp-nodelay", "--max-time", "0", "--connect-timeout", "5", url]),
    ]


camera.CameraManager._attempts = _cam_attempts_url

# ---------------------------------------------------------------- operator settings
OPS_FILE = os.path.join(HERE, "data", "ops_settings.json")
OPS_DEFAULTS = {
    "auto_collect": True,            # the scoop may move by itself (all checks must still pass)
    "scoop_speed_pct": 50,           # PEAK glide speed, % of the servo's own top speed
    "scoop_servo_s_per_60": 0.15,    # the servo's rated speed (25 kg digital class: 0.13-0.17 s/60°)
    "scoop_deg_per_1000us": 90,      # degrees it turns per 1000 µs (500-2500 µs = 180° servos)
    "scoop_hold_s": 2.0,             # stays at the extreme this long, then glides back to 0 (0 = stays)
    "scoop_delay_s": -1,             # after the capture point (-1 = capture distance / homing speed)
    "collect_max_speed_mps": 0.8,    # faster than this: no scoop
    "collect_max_gps_m": 10.0,       # farther than this from the drone's GPS point: no scoop
    "require_match": False,          # True: the camera's item must match the drone's picture (off: any plastic)
    "motor_on_signal": True,         # a new drone find runs the motor (boat ARMED in MANUAL only)
    "motor_power_pct": 20,           # motor power for it, % of the ESC's range (20 % default)
    "motor_run_s": 10,               # how long each signal runs it (a new find restarts the time)
    "alert_on_signal": True,         # a new drone find pulses the alert relay (LED strip + buzzer)
    "alert_duration_s": 8,           # duration of alert pulsing rhythm in seconds
    # ---- The boat's OWN camera (CameraCollect): verified plastic -> motor -> scoop
    "camera_motor": True,            # plastic the boat's camera verifies runs the motor
    "camera_motor_pct": 100,         # motor power while going for it, % of the ESC's range (full speed)
    "camera_scoop": True,            # …and the scoop closes when it reaches the collection zone
    "camera_scoop_m": 0.9,           # VERY close: scoop only when the plastic is this near (~bottom 15% of the picture)
    "camera_scoop_confirm": 3,       # …and read that close this many times in a row (one jumpy reading never scoops)
    # Trapped: the scoop closes only when the plastic the boat was going for is
    # INSIDE the scoop's mouth, which the camera sees in this part of its picture
    # (fractions of the picture: 0 = left / top, 1 = right / bottom).
    "camera_scoop_inside": True,     # require the waste inside the scoop (off: the "very close" rule above)
    "camera_scoop_seen_first": False,  # …and seen out on the water before it was in the scoop (off: a bottle put straight in counts)
    "scoop_zone_x1": 0.30, "scoop_zone_x2": 0.70,
    "scoop_zone_y1": 0.72, "scoop_zone_y2": 1.00,
    "camera_cooldown_s": 6.0,        # after a collection, ignore new plastic this long
    "camera_stale_s": 1.5,           # nothing seen from the app this long -> motor OFF (watchdog)
    "camera_alert": True,            # pulse the LED strip + buzzer for the boat camera's plastic too
}
OPS_LIMITS = {"scoop_speed_pct": (5, 100), "scoop_servo_s_per_60": (0.05, 1.0),
              "scoop_deg_per_1000us": (30, 270), "scoop_hold_s": (0, 30), "scoop_delay_s": (-1, 15),
              "collect_max_speed_mps": (0.1, 3.0), "collect_max_gps_m": (2.0, 30.0),
              "motor_power_pct": (0, 100), "motor_run_s": (1, 120),
              "alert_duration_s": (1, 60),
              "camera_motor_pct": (0, 100), "camera_scoop_m": (0.3, 10.0), "camera_scoop_confirm": (1, 20),
              "scoop_zone_x1": (0.0, 0.95), "scoop_zone_x2": (0.05, 1.0),
              "scoop_zone_y1": (0.0, 0.95), "scoop_zone_y2": (0.05, 1.0),
              "camera_cooldown_s": (0, 60), "camera_stale_s": (0.3, 10)}
_ops_lock = threading.Lock()


def _load_ops():
    s = dict(OPS_DEFAULTS)
    try:
        with open(OPS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        s.update({k: v for k, v in saved.items() if k in OPS_DEFAULTS})
    except (OSError, ValueError):
        pass
    return s


OPS_SETTINGS = _load_ops()


def update_ops(changes):
    """Validated partial update; returns (new settings, error or None)."""
    with _ops_lock:
        new = dict(OPS_SETTINGS)
        for k, v in (changes or {}).items():
            if k not in OPS_DEFAULTS:
                return OPS_SETTINGS, f"Unknown setting {k}"
            if isinstance(OPS_DEFAULTS[k], bool):
                new[k] = bool(v)
                continue
            try:
                v = float(v)
            except (TypeError, ValueError):
                return OPS_SETTINGS, f"{k} must be a number"
            lo, hi = OPS_LIMITS[k]
            if not lo <= v <= hi:
                return OPS_SETTINGS, f"{k} must be {lo:g}-{hi:g}"
            new[k] = v
        if new["scoop_zone_x2"] <= new["scoop_zone_x1"] or new["scoop_zone_y2"] <= new["scoop_zone_y1"]:
            return OPS_SETTINGS, "The scoop area must be wider and taller than nothing (x2 > x1, y2 > y1)"
        OPS_SETTINGS.clear()
        OPS_SETTINGS.update(new)
        try:
            os.makedirs(os.path.dirname(OPS_FILE), exist_ok=True)
            with open(OPS_FILE, "w", encoding="utf-8") as f:
                json.dump(OPS_SETTINGS, f, indent=1)
        except OSError as exc:
            log.warning("Could not save %s: %s", OPS_FILE, exc)
        return OPS_SETTINGS, None


def scoop_travel_s(delta_us):
    """Glide time for a move of delta_us. The cosine S-curve peaks at pi/2 x its
    average speed, so this keeps the PEAK at scoop_speed_pct of the servo's own speed."""
    st = OPS_SETTINGS
    deg = abs(delta_us) / 1000.0 * st["scoop_deg_per_1000us"]
    native = deg / 60.0 * st["scoop_servo_s_per_60"]
    return max(0.3, native / (st["scoop_speed_pct"] / 100.0) * math.pi / 2)


# ---------------------------------------------------------------- smooth scoop
SCOOP_STEP_HZ = 40
DO_SET_SERVO = 183


class ScoopMover:
    """Glides the scoop servo to its target along an S-curve, in a thread of its own."""

    def __init__(self, col):
        self.col = col
        self.pos = None            # µs the servo was last sent (None = not known yet)
        self.target = None
        self.moving = False
        self.gen = 0
        self.cv = threading.Condition()
        threading.Thread(target=self._run, name="scoop", daemon=True).start()

    def move(self, target):
        with self.cv:
            self.target = int(target)
            self.gen += 1
            self.cv.notify()

    def _send_nowait(self, n, us):
        link = self.col.link
        ts, tc = link.target_system, link.target_component
        if ts is None:
            return
        link._send(lambda m: m.mav.command_long_send(ts, tc, DO_SET_SERVO, 0, n, us, 0, 0, 0, 0, 0))

    def _run(self):
        seen = 0
        while True:
            with self.cv:
                while self.gen == seen:
                    self.cv.wait()
                seen, target = self.gen, self.target
            n = self.col.output
            if not n:
                continue
            start = self.pos if self.pos is not None else target
            dur = scoop_travel_s(target - start)
            t0 = time.time()
            done = False
            self.moving = True
            while self.gen == seen and self.col.link.fc_connected:
                x = min(1.0, (time.time() - t0) / dur)
                us = start + (target - start) * (1.0 - math.cos(math.pi * x)) / 2.0
                self._send_nowait(n, int(round(us)))
                self.pos = us
                if x >= 1.0:
                    done = True
                    break
                time.sleep(1.0 / SCOOP_STEP_HZ)
            if done:
                try:                                       # last step with an answer: make sure it's there
                    self.col.link.command_long(DO_SET_SERVO, [n, target])
                except LinkError:
                    pass
            if self.gen == seen:
                self.moving = False

    def wait_still(self, timeout):
        """Wait until the glide has finished. True if it did."""
        end = time.time() + timeout
        while time.time() < end:
            if not self.moving and self.pos is not None and self.target is not None \
                    and abs(self.pos - self.target) < 1:
                return True
            time.sleep(0.05)
        return False


_col_send = collector.Collector._send
_col_set = collector.Collector.set


def _live_output_us(col):
    s = col.link.snapshot()
    out = s.get("servo_out") if time.time() - (s.get("servo_out_t") or 0) < 2 else None
    n = col.output
    return (out[n - 1] or None) if out and 1 <= n <= len(out) else None


def _col_send_smooth(self, on):
    if not self.scoop or self.relay_pin or not self.output:
        return _col_send(self, on)
    mover = self.__dict__.get("_mover")
    if mover is None:
        mover = self._mover = ScoopMover(self)
    n = self.output
    if mover.pos is None:
        us = _live_output_us(self)
        if us is None and not self.__dict__.get("_in_set"):
            first = self.__dict__.setdefault("_first_try", time.time())
            if time.time() - first < 3:
                return False                               # wait a moment for the Pixhawk's output report
        if us is not None and not self.__dict__.get("_in_set"):
            # Boat program (re)started: keep the scoop where the Pixhawk already has it.
            zero, ext = self._pwm(False), self._pwm(True)
            on = abs(us - ext) < abs(us - zero)
            self.on = on
            log.info("Scoop: taking over at %d µs (%s)", us, "extreme" if on else "0")
        mover.pos = us
    target = self._pwm(on)
    check = int(round(mover.pos)) if mover.pos is not None else target
    try:
        result = self.link.command_long(DO_SET_SERVO, [n, check])   # the Pixhawk takes this output?
    except LinkError as exc:
        self.error = str(exc)
        return False
    if result != 0:
        self.error = f"The Pixhawk refused output {n} (result {result}) — is SERVO{n}_FUNCTION 0?"
        return False
    self.error = None
    if mover.pos is None:
        mover.pos = target
    mover.move(target)
    return True


def _col_set_marked(self, on, by="operator"):
    self._in_set = True
    try:
        return _col_set(self, on, by)
    finally:
        self._in_set = False


collector.Collector._send = _col_send_smooth
collector.Collector.set = _col_set_marked

# ---------------------------------------------------------------- receiver channels (read only)
# SwA (CH5) drives the SECOND servo through the Pixhawk itself (SERVO4_FUNCTION 55);
# nothing here moves anything because of a switch. The channels are only read so
# the app can show what the transmitter is doing.
MANUAL_SERVO_CHANNEL, MANUAL_SERVO_OUTPUT = 5, 4
RC_CHANNELS_MSG, RC_CHANNELS_HZ = 65, 4

_link_handle = mav_link.BoatLink._handle


def _link_handle_rc(self, msg):
    if msg.get_type() == "RC_CHANNELS":
        self.rc_in = (time.time(), msg.chancount, [getattr(msg, f"chan{i}_raw") for i in range(1, 19)])
    return _link_handle(self, msg)


mav_link.BoatLink._handle = _link_handle_rc


def _main():
    """The running boat program's module (uvicorn imports main.py as "main")."""
    return sys.modules.get("main")


def _dist_m(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def _bearing_deg(a_lat, a_lng, b_lat, b_lng):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dl = math.radians(b_lng - a_lng)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


STATE_WORDS = {
    "NAVIGATING": "Nirmal Dhara Jalyan navigation started",
    "SEARCHING": "Boat approaching target — camera searching for the plastic",
    "MATCHED": "Image match confirmed",
    "APPROACHING": "Final approach started",
    "COLLECTING": "Collection point reached",
    "VERIFYING": "Checking the pick-up",
    "COLLECTED": "Collection completed",
    "NOT_FOUND": "Plastic not found by the camera",
    "RETRY_REQUIRED": "Collection failed — retry needed",
    "SKIPPED": "Target skipped",
}
STATUS_WORDS = {  # the operator's target states
    "DETECTED": "DETECTED", "SENT": "DETECTED", "NAVIGATING": "BOAT MOVING", "SEARCHING": "VISUAL SEARCH",
    "MATCHED": "MATCHED", "APPROACHING": "APPROACHING", "COLLECTING": "COLLECTING",
    "VERIFYING": "COLLECTING", "COLLECTED": "COLLECTED", "NOT_FOUND": "FAILED / LOST",
    "RETRY_REQUIRED": "FAILED / LOST", "SKIPPED": "FAILED / LOST",
}


class Ops:
    """Phone GPS, the automatic scoop cycle, banners / alerts and the event log."""

    def __init__(self):
        self.lock = threading.Lock()
        self.events = deque(maxlen=400)
        sim = "--sim" in sys.argv
        self.log_path = os.path.join(HERE, "data", "ops_events_sim.log" if sim else "ops_events.log")
        self.t0 = time.time()        # target history from before this start is not logged again
        self.phone_url = os.environ.get("BOAT_PHONE_URL")
        self.phone = None            # last /status.json
        self.phone_t = 0.0           # when it was read
        self.phone_err = None
        self.cycle = {"state": "idle", "t": 0.0}
        self.gen = 0
        self.last_check = None       # the last collection decision with every check
        self._seen = set()           # events already in the log
        self._dist = {}              # target id -> deque[(t, metres)]
        self._fc_lost_since = None
        self._started = False

    # ------------------------------------------------------------ start
    def start(self):
        if self._started:
            return
        self._started = True
        for fn, name in ((self._phone_loop, "ops-phone"), (self._watch_loop, "ops-watch")):
            threading.Thread(target=fn, name=name, daemon=True).start()
        self.event("Boat program started" + (f" — phone at {self.phone_url}" if self.phone_url else ""))

    # ------------------------------------------------------------ event log
    def event(self, text, level="info", t=None):
        e = {"t": round(t or time.time(), 2), "text": text, "level": level}
        with self.lock:
            self.events.append(e)
        try:
            os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e["t"])) + f" [{level}] {text}\n")
        except OSError:
            pass
        (log.warning if level == "warn" else log.info)("OPS: %s", text)

    def _collect_events(self, M):
        """Pull new events from every part of the boat program into the one log."""
        live, vision, col, link = M.live, M.vision, M.collector, M.link
        for src, dq in (("live", live.events), ("camera", vision.events), ("scoop", col.events)):
            for e in list(dq):
                key = (src, e.get("t"), e.get("text"))
                if key not in self._seen:
                    self._seen.add(key)
                    self.event(e.get("text", ""), e.get("level", "info"), t=e.get("t"))
        for m in list(link.messages):
            key = ("px", m.get("t"), m.get("text"))
            if key not in self._seen:
                self._seen.add(key)
                sev = m.get("severity", 6)
                self.event(f"Pixhawk: {m.get('text')}", "warn" if sev <= 4 else "info", t=m.get("t"))
        for t in list(live.targets.values()):
            for h in list(t.get("history") or []):
                key = ("tgt", t["id"], h.get("t"), h.get("state"))
                if key in self._seen:
                    continue
                self._seen.add(key)
                if (h.get("t") or 0) < self.t0 - 2:
                    self._seen.add(("new", t["id"]))
                    continue                                 # from an earlier run
                st = h.get("state")
                if st in ("SENT", "DETECTED"):
                    if ("new", t["id"]) in self._seen:
                        continue
                    self._seen.add(("new", t["id"]))
                    self.event(f"Drone detected plastic ({t.get('object_class') or 'plastic'}) — "
                               f"target {t['id']}: lat {t['lat']:.8f}, lng {t['lng']:.8f}", t=h.get("t"))
                    self.event("Target coordinates received", t=h.get("t"))
                    continue
                words = STATE_WORDS.get(st, st)
                if st == "MATCHED" and t.get("match_score") is not None:
                    words += f" — {t['match_score'] * 100:.0f}%"
                note = f" ({h['note'].replace(', roller on', '')})" if h.get("note") and st not in ("MATCHED",) else ""
                self.event(f"{words} — target {t['id']}{note}",
                           "warn" if st in ("NOT_FOUND", "RETRY_REQUIRED") else "info", t=h.get("t"))
        if len(self._seen) > 20000:
            self._seen = set(list(self._seen)[-5000:])

    # ------------------------------------------------------------ phone
    def _phone_loop(self):
        while True:
            if self.phone_url:
                try:
                    with urllib.request.urlopen(self.phone_url + "/status.json", timeout=1.5) as r:
                        self.phone = json.loads(r.read().decode("utf-8"))
                        self.phone_t = time.time()
                        self.phone_err = None
                except Exception as exc:                     # noqa: BLE001 - any failure = unreachable
                    self.phone_err = str(exc)
            time.sleep(1.0)

    def phone_view(self):
        p, age = self.phone, time.time() - self.phone_t
        reachable = p is not None and age < 4
        fix_age = None
        if reachable and p.get("fix_age_s") is not None:
            fix_age = p.get("fix_age_s")
        gps_ok = bool(reachable and p.get("lat") is not None and (fix_age is None or fix_age < 5))
        return {
            "configured": bool(self.phone_url), "reachable": reachable, "error": None if reachable else self.phone_err,
            "gps_ok": gps_ok,
            "lat": p.get("lat") if reachable else None, "lng": p.get("lng") if reachable else None,
            "accuracy_m": p.get("accuracy_m") if reachable else None,
            "sats_used": p.get("sats_used") if reachable else None,
            "fix_age_s": fix_age, "gps_state": p.get("gps") if reachable else None,
            "pixhawk_usb": p.get("pixhawk") if reachable else None, "usb": p.get("usb") if reachable else None,
            "laptops": p.get("laptops") if reachable else None, "gps_sent": p.get("gps_sent") if reachable else None,
            "camera": p.get("camera") if reachable else None, "camera_fps": p.get("camera_fps") if reachable else None,
            # Boat Link 2.0+: which brain is on the USB ("uno_r4" / "pixhawk" / "none") and the
            # phone compass (the UNO R4's heading). Older phones leave these out.
            "brain": p.get("brain") if reachable else None,
            "compass_deg": p.get("compass_deg") if reachable else None,
            "compass_calibrate": bool(p.get("compass_calibrate")) if reachable else False,
        }

    def boat_position(self, s, phone=None):
        """Where the boat is: the phone's own GPS when fresh, else the Pixhawk's (fed by the same phone)."""
        phone = phone or self.phone_view()
        if phone["gps_ok"]:
            return phone["lat"], phone["lng"], "phone"
        if s.get("lat") is not None and s.get("gps_fix", 0) >= 3:
            return s["lat"], s["lng"], "pixhawk"
        return None, None, None

    # ------------------------------------------------------------ watchdog
    def _watch_loop(self):
        while True:
            try:
                M = _main()
                if M is not None and hasattr(M, "live"):
                    self._collect_events(M)
                    self._watch(M)
            except Exception:
                log.exception("ops watch")
            time.sleep(1.0)

    def _watch(self, M):
        s, live = M.link.snapshot(), M.live
        now = time.time()
        # Pixhawk lost while collecting: don't carry on blindly when it comes back.
        if not s["fc_connected"]:
            self._fc_lost_since = self._fc_lost_since or now
            if live.state in ("running", "returning") and now - self._fc_lost_since > 3 \
                    and not getattr(live, "pixhawk_skipped", False):
                self.event("PIXHAWK CONNECTION LOST — live collect paused (press Start when it is back)", "warn")
                try:
                    live.pause("Pixhawk connection lost", hold=True)
                except Exception:
                    log.exception("pause")
                self.abort("Pixhawk connection lost")
        else:
            if self._fc_lost_since and now - self._fc_lost_since > 3:
                self.event("Pixhawk connection back")
            self._fc_lost_since = None
        # Live collect stopped / paused (the operator, a mode change on SwD, a failsafe)
        # during a scoop cycle: abort it, the scoop glides back to 0.
        # Not for a cycle the boat's OWN CAMERA started: that one has nothing to
        # do with the drone's queue — the boat is in MANUAL, going for something
        # only its camera found, and CameraCollect watches that one instead.
        if self.cycle.get("source", "drone") != "camera" \
                and self.cycle["state"] in ("checking", "waiting", "to_extreme", "holding") \
                and live.state != "running":
            self.abort(f"live collect {live.state}")
        # distance history of the current target (is the boat getting closer?)
        tid = live.current
        if tid and tid in live.targets:
            t = live.targets[tid]
            lat, lng, _ = self.boat_position(s)
            if lat is not None:
                dq = self._dist.setdefault(tid, deque(maxlen=30))
                dq.append((now, _dist_m(lat, lng, t["lat"], t["lng"])))

    # ------------------------------------------------------------ automatic scoop
    def camera_checks(self, vm, target):
        """Every condition for scooping plastic the BOAT'S OWN camera found.

        The drone path (checks() below) asks for GUIDED and a GPS point; this
        one can't, because the boat is being pushed in MANUAL towards something
        only the camera knows about. What it does ask for is that the item is
        verified plastic, in the collection zone, in front of the boat, and that
        the boat is slow, armed and holding its scoop open at 0."""
        M, st = _main(), OPS_SETTINGS
        s = vm.link.snapshot()
        live = vm.live
        col = live.collector if live else None
        mover = col.__dict__.get("_mover") if col else None
        gs = float(s.get("groundspeed") or 0.0)
        crit = [m for m in list(s.get("messages") or [])
                if m.get("severity", 6) <= 2 and time.time() - m.get("t", 0) < 15]
        cam = getattr(M, "camera", None)
        d = target.get("distance_m")
        zone = float(st["camera_scoop_m"])
        age = float(target.get("age_ms") or 0) / 1000.0
        # Where the waste is: trapped inside the scoop (the camera sees it in the
        # scoop's mouth; CameraCollect has already seen it there several times in
        # a row, after seeing it out on the water), or the older "very close" rule.
        if st.get("camera_scoop_inside", True):
            inside = CAMERA.in_scoop(target)
            where = [("Waste trapped inside the scoop" + ("" if inside is not None else " (the app sends no box position)"),
                      bool(inside))]
        else:
            where = [(f"Very close (within {zone:g} m)" + (f" (now {d:.2f} m)" if d is not None else " (no distance)"),
                      d is not None and d <= zone),
                     ("In front of the boat", bool(target.get("centred")))]
        out = [
            ("Automatic collection is ON", bool(st["auto_collect"])),
            ("Camera collection is ON", bool(st["camera_scoop"])),
            ("Boat camera connected", bool(cam is not None and cam.connected)),
            ("The item is verified plastic", bool(target.get("confirmed"))),
            *where,
            (f"Seen just now (last seen {age:.1f} s ago)", age <= 1.0),
            (f"Speed at most {st['collect_max_speed_mps']:g} m/s (now {gs:.1f})", gs <= st["collect_max_speed_mps"]),
            ("Pixhawk connected and armed", bool(s["fc_connected"] and s["armed"])),
            ("No critical Pixhawk error", not crit),
            ("Scoop ready at 0 and not moving", bool(col and col.scoop and col.output and not col.on
                                                     and not (mover and mover.moving))),
        ]
        return all(ok for _, ok in out), out

    def checks(self, vm, tid, match):
        M, st = _main(), OPS_SETTINGS
        s = vm.link.snapshot()
        live = vm.live
        t = live.targets.get(tid) if (live and tid) else None
        col = live.collector if live else None
        mover = col.__dict__.get("_mover") if col else None
        lat, lng, src = self.boat_position(s)
        d = _dist_m(lat, lng, t["lat"], t["lng"]) if (t and lat is not None) else None
        thr = float(vm.cfg.get("match_threshold", 0.55))
        gs = float(s.get("groundspeed") or 0.0)
        crit = [m for m in list(s.get("messages") or []) if m.get("severity", 6) <= 2 and time.time() - m.get("t", 0) < 15]
        cam = getattr(M, "camera", None)
        out = [
            ("Automatic collection is ON", bool(st["auto_collect"])),
            ("Live collect is running", live is not None and live.state == "running"),
            ("Drone target known", t is not None),
            (f"Within {st['collect_max_gps_m']:g} m of the drone's GPS point"
             + (f" (now {d:.1f} m, {src} GPS)" if d is not None else " (no boat position)"),
             d is not None and d <= st["collect_max_gps_m"]),
            ("Boat camera connected", bool(cam is not None and cam.connected)),
            (f"Image match at least {thr * 100:.0f}%" + (f" (now {match * 100:.0f}%)" if match is not None else " (no match score)"),
             (match is not None and match >= thr) if st["require_match"] else True),
            (f"Speed at most {st['collect_max_speed_mps']:g} m/s (now {gs:.1f})", gs <= st["collect_max_speed_mps"]),
            ("Pixhawk connected and armed", bool(s["fc_connected"] and s["armed"])),
            ("Pixhawk in GUIDED (not taken over by the transmitter)", s.get("flight_mode") == "GUIDED"),
            ("GPS 3D fix on the Pixhawk", (s.get("gps_fix") or 0) >= 3),
            ("No critical Pixhawk error", not crit),
            ("Scoop ready at 0 and not moving", bool(col and col.scoop and col.output and not col.on
                                                       and not (mover and mover.moving))),
        ]
        return all(ok for _, ok in out), out

    def request_collect(self, vm, tid, match, source="drone", target=None, on_refused=None):
        """Start a scoop cycle for a drone target, or for one the boat's own
        camera verified (source "camera"). One cycle at a time."""
        with self.lock:
            busy = self.cycle["state"] in ("checking", "waiting", "to_extreme", "holding", "to_zero")
            if not busy:
                self.gen += 1
                gen = self.gen
                self.cycle = {"state": "checking", "t": time.time(), "tid": tid, "match": match, "source": source}
        if busy:
            self.event(f"Collection request for {tid} ignored: the scoop is already in a cycle", "warn")
            if on_refused:
                on_refused()
            return
        threading.Thread(target=self._cycle, args=(gen, vm, tid, match, source, target, on_refused),
                         name="scoop-cycle", daemon=True).start()

    def _set_cycle(self, gen, state, **kw):
        with self.lock:
            if gen == self.gen:
                self.cycle = {**self.cycle, "state": state, "t": time.time(), **kw}
                return True
            return False

    def _cycle(self, gen, vm, tid, match, source="drone", target=None, on_refused=None):
        camera = source == "camera"
        if camera:
            ok, checks = self.camera_checks(vm, target or {})
        else:
            ok, checks = self.checks(vm, tid, match)
        self.last_check = {"t": round(time.time(), 1), "tid": tid, "ok": ok, "source": source,
                           "checks": [{"text": c, "ok": bool(v)} for c, v in checks]}
        if not ok:
            failed = "; ".join(c for c, v in checks if not v)
            self.event(f"Scoop NOT activated for {tid}: {failed}", "warn")
            self._set_cycle(gen, "refused", why=failed)
            if on_refused:
                on_refused()
            return
        col = vm.live.collector
        st, cfg = OPS_SETTINGS, vm.cfg
        if camera:
            d = (target or {}).get("distance_m")
            self.event(f"Scoop collection initiated — the camera's plastic {tid}"
                       + (f" at {d:.2f} m" if d is not None else ""))
        else:
            self.event(f"Scoop collection initiated — target {tid}" + (f", match {match * 100:.0f}%" if match is not None else ""))
        delay = 0.0 if camera else st["scoop_delay_s"]   # the camera path is already at the item
        if delay is None or delay < 0:
            delay = float(cfg.get("homing_capture_m", 1.5)) / max(0.2, float(cfg.get("homing_speed_mps", 0.4)))
            delay = max(0.0, delay - scoop_travel_s(1000) / 2)
        self._set_cycle(gen, "waiting", delay=round(delay, 2))
        end = time.time() + delay
        while time.time() < end:
            if gen != self.gen:
                return
            if not OPS_SETTINGS["auto_collect"]:
                self.event("Scoop cycle cancelled: automatic collection switched OFF", "warn")
                self._set_cycle(gen, "aborted", why="auto collection off")
                return
            time.sleep(0.05)
        try:
            if not self._set_cycle(gen, "to_extreme"):
                return
            col.set(True, "auto-collect")
            mover = col.__dict__.get("_mover")
            if mover and not mover.wait_still(scoop_travel_s(1000) + 3):
                if gen != self.gen:
                    return
                self.event("Scoop did not reach the collection position in time", "warn")
            if gen != self.gen:
                return
            self.event(f"Scoop reached collection position ({col._pwm(True)} µs)")
            hold = float(st["scoop_hold_s"])
            if hold <= 0:
                self._set_cycle(gen, "done", note="left at the extreme")
                self.event("Collection completed (scoop left at the extreme — return it from the app)")
                return
            self._set_cycle(gen, "holding")
            end = time.time() + hold
            while time.time() < end:
                if gen != self.gen:
                    return
                time.sleep(0.05)
            self._set_cycle(gen, "to_zero")
            col.set(False, "auto-collect")
            if mover:
                mover.wait_still(scoop_travel_s(1000) + 3)
            if gen != self.gen:
                return
            self._set_cycle(gen, "done")
            self.event("Collection completed — scoop back at 0, ready for the next")
        except LinkError as exc:
            self.event(f"Scoop cycle stopped: {exc}", "warn")
            self._set_cycle(gen, "failed", why=str(exc))

    def abort(self, why="operator"):
        with self.lock:
            active = self.cycle["state"] in ("checking", "waiting", "to_extreme", "holding", "to_zero")
            self.gen += 1
            if active:
                self.cycle = {**self.cycle, "state": "aborted", "t": time.time(), "why": why}
        M = _main()
        col = getattr(M, "collector", None) if M else None
        if active:
            self.event(f"Scoop cycle ABORTED ({why}) — scoop gliding back to 0", "warn")
        if col is not None and col.scoop and (active or col.on):
            try:
                col.set(False, f"abort: {why}")
            except LinkError as exc:
                self.event(f"Could not return the scoop: {exc}", "warn")
        return active

    # ------------------------------------------------------------ the app's view
    def status(self):
        M = _main()
        if M is None or not hasattr(M, "link"):
            return {"success": False, "message": "Boat program starting"}
        s, live, vision, col = M.link.snapshot(), M.live, M.vision, M.collector
        now = time.time()
        phone = self.phone_view()
        lat, lng, src = self.boat_position(s, phone)
        cam = M.camera
        mover = col.__dict__.get("_mover")
        rc = getattr(M.link, "rc_in", None)
        rc_ok = bool(rc and now - rc[0] < 2 and rc[1] >= MANUAL_SERVO_CHANNEL)
        sw = rc[2][MANUAL_SERVO_CHANNEL - 1] if rc_ok else None
        out = s.get("servo_out") if now - (s.get("servo_out_t") or 0) < 3 else None
        hm = vision.hm
        cur = live.targets.get(live.current) if live.current else None
        if cur is None:
            # Not homing on one yet (or the Pixhawk is skipped): show the newest
            # drone find, its picture first, so "Drone saw this" + matching work.
            act = [t for t in live.targets.values() if t.get("status") in live_collect.ACTIVE]
            if act:
                cur = max(act, key=lambda t: (bool(t.get("has_reference")), t.get("added_at") or 0))
        tv = None
        if cur:
            d_ph = _dist_m(phone["lat"], phone["lng"], cur["lat"], cur["lng"]) if phone["gps_ok"] else None
            d_px = (_dist_m(s["lat"], s["lng"], cur["lat"], cur["lng"])
                    if s.get("lat") is not None and (s.get("gps_fix") or 0) >= 3 else None)
            dq = self._dist.get(cur["id"])
            closing = None
            if dq and len(dq) >= 2:
                old = [d for t_, d in dq if now - t_ >= 4]
                if old:
                    closing = dq[-1][1] < old[-1] - 0.3
            tv = {"id": cur["id"], "lat": cur["lat"], "lng": cur["lng"], "state": cur.get("state"),
                  "status_word": STATUS_WORDS.get(cur.get("state"), cur.get("state")),
                  "object_class": cur.get("object_class"), "confidence": cur.get("confidence"),
                  "match_score": cur.get("match_score") if cur.get("match_score") is not None else hm.get("match"),
                  "distance_m": d_ph if d_ph is not None else d_px, "distance_phone_m": d_ph,
                  "distance_pixhawk_m": d_px, "distance_from": "phone" if d_ph is not None else ("pixhawk" if d_px is not None else None),
                  "bearing_deg": _bearing_deg(lat, lng, cur["lat"], cur["lng"]) if lat is not None else None,
                  "closing": closing, "added_at": cur.get("added_at"), "detected_at": cur.get("detected_at"),
                  "has_reference": bool(cur.get("has_reference")),
                  "homing_distance_m": hm.get("dist") if hm.get("wid") == cur["id"] else None}
        pending = [t for t in live.targets.values() if t.get("status") == "pending"]
        alerts = []
        if not s["fc_connected"] or phone.get("pixhawk_usb") is False:
            alerts.append("PIXHAWK CONNECTION LOST")
        if phone["configured"] and not phone["reachable"]:
            alerts.append("PHONE LINK LOST")
        elif phone["configured"] and not phone["gps_ok"]:
            alerts.append("PHONE GPS UNAVAILABLE")
        if not cam.connected:
            alerts.append("BOAT CAMERA UNAVAILABLE")
        for m in list(s.get("messages") or [])[-5:]:
            if m.get("severity", 6) <= 2 and now - m.get("t", 0) < 30:
                alerts.append(f"PIXHAWK: {m.get('text')}")
        banner = None
        st_ = cur.get("state") if cur else None
        if cur and live.state == "running" and st_ in ("MATCHED", "APPROACHING", "COLLECTING", "VERIFYING"):
            banner = {"kind": "matched", "title": "WASTE DETECTED AND MATCHED", "sub": "HEADING TOWARDS IT"}
        elif cur and live.state == "running":
            banner = {"kind": "moving", "title": "WASTE DETECTED", "sub": "NIRMAL DHARA JALYAN MOVING TOWARDS IT"}
        elif (pending or cur) and live.state != "running":
            banner = {"kind": "idle", "title": "WASTE DETECTED",
                      "sub": "Boat not moving — start live collect to send Nirmal Dhara Jalyan"}
        with self.lock:
            events = list(self.events)[-150:]
            cycle = dict(self.cycle)
        return {
            "success": True, "t": round(now, 2),
            "phone": phone,
            "boat_position": {"lat": lat, "lng": lng, "source": src},
            "pixhawk": {
                "connected": s["fc_connected"], "link_error": s.get("link_error"), "armed": s["armed"],
                "mode": s.get("flight_mode"), "lat": s.get("lat"), "lng": s.get("lng"),
                "gps_fix": s.get("gps_fix"), "satellites": s.get("satellites"),
                "speed_mps": s.get("groundspeed"), "heading_deg": s.get("heading"), "alt_m": s.get("relative_alt"),
                "battery_voltage": s.get("battery_voltage"), "battery_percent": s.get("battery_percent"),
                "board_v": s.get("board_v"), "servo_v": s.get("servo_v"),
                "messages": list(s.get("messages") or [])[-12:],
            },
            "live": {"state": live.state, "phase": live.phase, "pending": len(pending),
                     "total": len(live.targets)},
            "target": tv,
            "banner": banner, "alerts": alerts,
            "camera": {"connected": bool(cam.connected), "fps": cam.measured_fps()},
            "auto": {"settings": dict(OPS_SETTINGS), "cycle": cycle, "last_check": self.last_check,
                     "match_threshold": M.cfg.get("match_threshold")},
            "scoop": {"output": col.output, "on": col.on, "by": col.by,
                      "pos_us": None if not mover or mover.pos is None else round(mover.pos),
                      "target_us": None if not mover else mover.target, "moving": bool(mover and mover.moving),
                      "zero_us": col._pwm(False), "extreme_us": col._pwm(True),
                      "travel_s": round(scoop_travel_s(abs(col._pwm(True) - col._pwm(False))), 2),
                      "error": col.error},
            "manual_servo": {"channel": MANUAL_SERVO_CHANNEL, "switch": "SwA", "output": MANUAL_SERVO_OUTPUT,
                             "in_us": sw, "out_us": out[MANUAL_SERVO_OUTPUT - 1] if out and len(out) >= 4 else None,
                             "position": None if sw is None else ("extreme" if sw > 1500 else "0"),
                             "receiver": rc_ok},
            "events": events,
            "motor": MOTOR.view(s),
            "alert": ALERT.view(),
            "camera_collect": CAMERA.view(),
        }


OPS = Ops()

# ---------------------------------------------------------------- drone signal -> motor at 50 %
# When a NEW drone find reaches the boat (the live_collect patch further down),
# the motor (MAIN OUT 3, SERVO3_FUNCTION 70) runs at motor_power_pct for
# motor_run_s -- and nothing else: no GUIDED, no goto, no steering, no heading
# correction.
#
# How: RC override on the THROTTLE channel only (RCMAP_THROTTLE 3). Every other
# channel is sent as "ignore", so the rudder (CH4), SwA and SwD stay on the
# FS-i6. ArduRover passes the throttle stick straight to the motor only in
# MANUAL, so the boat must be ARMED in MANUAL (SwD); otherwise the signal is
# logged and nothing moves. Arming later never starts the motor by surprise.
#
# 50 % stick -> SERVO3_TRIM + 50 % of (SERVO3_MAX - SERVO3_TRIM) = 1500 µs at
# the ESC (MOT_THR_MAX 100: full power allowed). The µs sent on CH3 comes from the
# Pixhawk's own RC3_MIN / TRIM / MAX / DZ (read when it connects).
#
# Stops (throttle back on the transmitter at once): motor_run_s over, STOP /
# brake / emergency stop / arm / mode / Pause in the app, SwD flipped out of
# MANUAL, disarmed, Pixhawk link lost, Auto motor switched OFF. If the laptop
# itself dies, the Pixhawk drops the override after RC_OVERRIDE_TIME (3 s).
#
# While it runs the Pixhawk reads CH3 from here, not from the receiver: the
# throttle stick, stick-disarm and the radio-loss failsafe don't act -- flip SwD
# to take over. That is why every run is time-limited.
MOTOR_SEND_HZ = 10
RC_THROTTLE_CH = 3          # RCMAP_THROTTLE 3
MOTOR_OUTPUT = 3            # MAIN OUT 3 = the ESC (SERVO3_FUNCTION 70)
MOTOR_PARAMS_RETRY_S = 30.0
# Used until the Pixhawk's own values are read (= what pixhawk_setup.py writes).
MOTOR_PARAM_DEFAULTS = {"RC3_MIN": 1000.0, "RC3_TRIM": 1000.0, "RC3_MAX": 2000.0, "RC3_DZ": 50.0,
                        "RC3_REVERSED": 0.0, "SERVO3_TRIM": 1000.0, "SERVO3_MAX": 2000.0, "MOT_THR_MAX": 100.0}


def throttle_pwm(pct, p):
    """CH3 µs that ArduPilot (RC_Channel::pwm_to_angle_dz_trim, throttle = 0..100)
    reads as `pct` % throttle. Rounded away from the trim so its integer maths
    never lands below pct."""
    pct = max(0.0, min(100.0, float(pct)))
    mn, tr, mx = p["RC3_MIN"], p["RC3_TRIM"], p["RC3_MAX"]
    dz = max(0.0, p["RC3_DZ"])
    if pct <= 0:
        return int(round(tr))
    if p.get("RC3_REVERSED"):
        us = math.floor(tr - dz - pct / 100.0 * ((tr - dz) - mn))
    else:
        us = math.ceil(tr + dz + pct / 100.0 * (mx - (tr + dz)))
    return int(max(mn, min(mx, us)))


class MotorPush:
    """A drone signal runs the motor at motor_power_pct for motor_run_s (CH3 override only)."""

    def __init__(self, get_link=None, event=None, settings=None, get_cfg=None):
        self._get_link = get_link or (lambda: getattr(_main(), "link", None))
        self._get_cfg = get_cfg or (lambda: getattr(_main(), "cfg", None) or {})
        self._event = event or (lambda text, level="info": OPS.event(text, level))
        self.settings = OPS_SETTINGS if settings is None else settings
        self.lock = threading.RLock()
        self.on = False
        self.until = 0.0
        self.started_at = None
        self.run_s = None
        self.pct = None
        self.pwm = None
        self.reason = None                    # why it last started / stopped / did not start
        self.last_signal = None               # {"t", "ids", "source", "started"}
        self.params = dict(MOTOR_PARAM_DEFAULTS)
        self.params_from = "defaults"         # "pixhawk" once its own values are read
        self._params_sys = None
        self._params_try = 0.0
        self._reading = False
        self._wake = threading.Event()
        self._started = False

    # ------------------------------------------------------------ thread
    def start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._run, name="motor-push", daemon=True).start()

    def _run(self):
        while True:
            self._wake.wait(1.0 / MOTOR_SEND_HZ)
            self._wake.clear()
            try:
                self.step()
            except Exception:                                        # noqa: BLE001
                log.exception("motor push")

    def step(self):
        """One 10 Hz tick: keep the override alive, or end the run."""
        link = self._get_link()
        self._maybe_read_params(link)
        with self.lock:
            if not self.on:
                return
            run_s = self.run_s
        if link is None or not link.fc_connected:
            self.stop("the Pixhawk is not connected")
            return
        # Checked on EVERY tick, however the run was started: flipping SwD out
        # of MANUAL or disarming stops the motor at once. `force` only ever
        # decides whether a run may START, never whether it may continue.
        why = self.not_ready(link, force=False)
        if why:
            self.stop(why.split(" (")[0])
            return
        with self.lock:
            if not self.on:
                return
            if time.time() >= self.until:
                pass                                                 # stop() below, outside this block
            else:
                self._send(link, self.pwm)                           # under the lock: never after a stop
                return
        self.stop(f"{run_s:g} s run finished")

    # ------------------------------------------------------------ checks
    def not_ready(self, link=None, force=False):
        """None if the motor may run now, else why not (for the operator).

        `force` is the operator pressing Test Motor: only then may this arm the
        boat or put it in MANUAL. Nothing the cameras see ever does — a drone
        find or a plastic the boat sees can only run a motor the operator has
        already armed in MANUAL."""
        link = link if link is not None else self._get_link()
        if link is None or not link.fc_connected or link.target_system is None:
            return "the Pixhawk is not connected"
        if not force and (self._get_cfg() or {}).get("rc_source") == "gamepad":
            return "rc_source is gamepad (the game controller drives CH3)"
        s = link.snapshot()
        if not s.get("armed"):
            if force:
                try:
                    link.arm(True, force=True)
                    time.sleep(0.08)
                    s = link.snapshot()
                except Exception as exc:
                    log.warning("motor auto-arm: %s", exc)
            if not s.get("armed"):
                return "the boat is DISARMED (arm it with the left stick in MANUAL)"
        if s.get("flight_mode") not in ("MANUAL", "LEARNING", "STEERING"):
            if force:
                try:
                    link.set_mode("MANUAL")
                    time.sleep(0.08)
                    s = link.snapshot()
                except Exception as exc:
                    log.warning("motor auto set MANUAL: %s", exc)
            if s.get("flight_mode") not in ("MANUAL", "LEARNING", "STEERING"):
                return f"the boat is in {s.get('flight_mode') or 'an unknown mode'}, not MANUAL (set SwD to MANUAL)"
        return None

    def effective_pct(self, pct):
        cap = self.params.get("MOT_THR_MAX")
        return min(float(pct), float(cap)) if cap else float(pct)

    def esc_us(self, pct):
        tr, mx = self.params["SERVO3_TRIM"], self.params["SERVO3_MAX"]
        return int(round(tr + max(0.0, pct) / 100.0 * (mx - tr)))

    # ------------------------------------------------------------ signal / stop
    def signal(self, ids, source="drone", force=False, pct=None, quiet=False, gate="motor_on_signal"):
        """A drone signal (new plastic find), camera detection or test. Returns (started, message).

        `quiet` is for keeping a run alive while the boat goes for the same
        plastic: it does the same thing without writing another event line."""
        ids = [str(i) for i in (ids or [])]
        drone = source == "drone"
        label = "Drone signal" if drone else source.capitalize()
        what = (f"{len(ids)} new plastic find{'s' if len(ids) != 1 else ''}"
                + (f": {ids[0]}" if len(ids) == 1 else "")) if drone else ("plastic detected" if source == "boat camera" else "from the app")
        now = time.time()
        with self.lock:
            self.last_signal = {"t": round(now, 2), "ids": ids[:10], "source": source, "started": False}
        # Each way of finding plastic has its own switch: the drone's finds
        # (Auto motor) and the boat's own camera (Camera motor).
        if not force and gate and not self.settings.get(gate, True):
            off = "Auto motor is OFF" if gate == "motor_on_signal" else "Camera motor is OFF"
            return self._refuse(f"{label} ({what}) — motor NOT started: {off}")
        link = self._get_link()
        why = self.not_ready(link, force=force)
        if why:
            return self._refuse(f"{label} ({what}) — motor NOT started: {why}")
        if pct is None:
            pct = float(self.settings.get("motor_power_pct", 20))
        else:
            pct = float(pct)
        run_s = float(self.settings.get("motor_run_s", 10))
        with self.lock:
            was = self.on
            pwm = throttle_pwm(pct, self.params)
            self.on, self.pct, self.pwm, self.run_s = True, pct, pwm, run_s
            self.forced = bool(force)
            self.until = now + run_s
            self.started_at = self.started_at if was else now
            self.last_signal["started"] = True
            self.reason = f"{label}: {what}"
            self._send(link, pwm)                                    # at once; the thread keeps it alive
        self._wake.set()
        eff = self.effective_pct(pct)
        if was:
            msg = f"{label} ({what}) — motor stays at {pct:g} %, {run_s:g} s again"
        else:
            msg = (f"{label} ({what}) — MOTOR ON at {pct:g} %"
                   + (f" (capped to {eff:g} % by MOT_THR_MAX)" if eff < pct else "")
                   + f" for {run_s:g} s: CH3 {pwm} µs, ESC about {self.esc_us(eff)} µs. "
                     "No steering — the rudder stays on the transmitter")
        if not (quiet and was):
            self._event(msg)
        return True, msg

    def _refuse(self, msg):
        with self.lock:
            self.reason = msg.split(" — ", 1)[-1]
        self._event(msg, "warn")
        return False, msg

    def stop(self, why="stopped"):
        """Throttle back on the transmitter at once. True if the motor was running."""
        with self.lock:
            was = self.on
            self.on, self.until = False, 0.0
            if not was:
                return False
            ran = time.time() - (self.started_at or time.time())
            self.started_at = None
            self.reason = f"stopped: {why}"
            self._release(self._get_link())                          # under the lock: no send can follow it
        self._event(f"MOTOR OFF ({why}) after {ran:.0f} s — throttle back on the transmitter")
        return True

    # ------------------------------------------------------------ MAVLink
    @staticmethod
    def _send(link, pwm):
        """CH3 = pwm; every other channel 'ignore' (stays on the transmitter)."""
        try:
            link.rc_override_channels({RC_THROTTLE_CH: int(pwm)}, others=None)
        except Exception as exc:                                     # noqa: BLE001
            log.warning("motor push send: %s", exc)

    @staticmethod
    def _release(link):
        """CH3 0 = back to the transmitter at once (sent twice in case one is lost)."""
        if link is None or link.target_system is None:
            return
        for _ in range(2):
            try:
                link.rc_override_channels({RC_THROTTLE_CH: 0}, others=None)
            except Exception as exc:                                 # noqa: BLE001
                log.warning("motor push release: %s", exc)

    def _maybe_read_params(self, link):
        if link is None or not link.fc_connected or link.target_system is None:
            return
        if self._params_sys == link.target_system or self._reading \
                or time.time() - self._params_try < MOTOR_PARAMS_RETRY_S:
            return
        self._reading, self._params_try = True, time.time()
        threading.Thread(target=self._read_params, args=(link,), name="motor-params", daemon=True).start()

    def _read_params(self, link):
        try:
            got = {}
            for name in MOTOR_PARAM_DEFAULTS:
                v = link.get_param(name, timeout=2.0)
                if v is not None:
                    got[name] = float(v)
            with self.lock:
                self.params.update(got)
                if all(n in got for n in MOTOR_PARAM_DEFAULTS if n.startswith("RC3_")):
                    self.params_from = "pixhawk"
                    self._params_sys = link.target_system
            if got:
                log.info("Motor push: Pixhawk values %s -> 50 %% = CH3 %d µs", got, throttle_pwm(50, self.params))
        except Exception as exc:                                     # noqa: BLE001 - LinkError, link gone
            log.warning("Motor push: could not read the Pixhawk's RC3 values: %s", exc)
        finally:
            self._reading = False

    # ------------------------------------------------------------ the app's view
    def view(self, s=None):
        now = time.time()
        st = self.settings
        with self.lock:
            on, until, pct, pwm = self.on, self.until, self.pct, self.pwm
            reason, last = self.reason, dict(self.last_signal) if self.last_signal else None
        pct = pct if on else float(st.get("motor_power_pct", 50))
        eff = self.effective_pct(pct)
        out = s.get("servo_out") if s and now - (s.get("servo_out_t") or 0) < 3 else None
        why = self.not_ready()
        return {
            "enabled": bool(st.get("motor_on_signal", True)), "on": on,
            "power_pct": pct, "effective_pct": eff, "run_s": float(st.get("motor_run_s", 10)),
            "left_s": round(max(0.0, until - now), 1) if on else None,
            "ch3_us": pwm if on else throttle_pwm(pct, self.params), "esc_expected_us": self.esc_us(eff),
            "esc_out_us": out[MOTOR_OUTPUT - 1] if out and len(out) >= MOTOR_OUTPUT else None,
            "ready": why is None, "not_ready": why, "reason": reason, "last_signal": last,
            "params_from": self.params_from,
        }


MOTOR = MotorPush()

# ---------------------------------------------------------------- drone signal -> visual alert (LED strip & buzzer)
# When a NEW drone find reaches the boat, the 5V relay on AUX OUT 1 (Pin 50,
# RELAY1_PIN) pulses in an unmistakable alert rhythm (triple-burst beacon:
# 220ms ON, 180ms OFF x 3, then 400ms pause, repeating for alert_duration_s).
# The E-minus LED strip and the buzzer are wired to the relay switch contacts,
# so they flash and sound in exact lockstep rhythm.
RELAY_DO_SET = 181  # MAV_CMD_DO_SET_RELAY
RELAY_INSTANCE = 0  # 0 = RELAY1 (AUX 1, Pin 50)
ALERT_BEEPS = 8     # the buzzer rings this many times for each plastic detection


def _trigger_esp32(endpoint):
    """Notify ESP32 relay controller asynchronously over Wi-Fi."""
    def _call():
        urls = [
            f"http://varuna-relay.local/{endpoint}",
            f"http://varuna-boat.local/{endpoint}",
        ]
        esp_ip = os.environ.get("ESP32_RELAY_IP")
        if esp_ip:
            urls.insert(0, f"http://{esp_ip}/{endpoint}")
        for arg in sys.argv:
            if "tcp:" in arg:
                host = arg.split("tcp:")[-1].split(":")[0]
                urls.append(f"http://{host}/{endpoint}")
        for url in urls:
            try:
                with urllib.request.urlopen(url, timeout=0.8):
                    return
            except Exception:
                pass
    threading.Thread(target=_call, name="esp32-alert-http", daemon=True).start()


class AlertBlinker:
    """Pulses the Pixhawk AUX 1 relay and/or Wi-Fi ESP32 relay in an alert rhythm for alert_duration_s."""

    def __init__(self, get_link=None, event=None, settings=None):
        self._get_link = get_link or (lambda: getattr(_main(), "link", None))
        self._event = event or (lambda text, level="info": OPS.event(text, level))
        self.settings = OPS_SETTINGS if settings is None else settings
        self.lock = threading.RLock()
        self.on = False
        self.until = 0.0
        self.started_at = None
        self.run_s = None
        self.relay_state = 0
        self._wake = threading.Event()
        self._started = False

    def start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._run, name="alert-blinker", daemon=True).start()

    def _set_relay(self, link, state):
        self.relay_state = 1 if state else 0
        if link is None or not link.fc_connected or link.target_system is None:
            return
        try:
            ts, tc = link.target_system, link.target_component
            link._send(lambda m: m.mav.command_long_send(
                ts, tc, RELAY_DO_SET, 0, RELAY_INSTANCE, int(bool(state)), 0, 0, 0, 0, 0))
        except Exception as exc:                                     # noqa: BLE001
            log.warning("relay send: %s", exc)

    def _run(self):
        # Exactly ALERT_BEEPS beeps/pulses: ON -> OFF repeated. Every OFF is shorter
        # than the ESP32 bridge's 300 ms re-arm, so it plays its own 8 beeps once.
        cadence = [(0.25, 1), (0.20, 0)] * ALERT_BEEPS
        while True:
            self._wake.wait(0.1)
            with self.lock:
                active = self.on
            if not active:
                continue

            link = self._get_link()
            for duration, state in cadence:
                with self.lock:
                    if not self.on:
                        break
                self._set_relay(link, state)
                time.sleep(duration)

            self.stop(f"{ALERT_BEEPS} beeps finished")

    def signal(self, ids, source="drone", force=False):
        """A drone signal (new plastic find) or operator test."""
        ids = [str(i) for i in (ids or [])]
        drone = source == "drone"
        label = "Drone signal" if drone else source.capitalize()
        what = (f"{len(ids)} new plastic find{'s' if len(ids) != 1 else ''}"
                + (f": {ids[0]}" if len(ids) == 1 else "")) if drone else "from the app"
        now = time.time()
        if not force and not self.settings.get("alert_on_signal", True):
            return False, f"{label} ({what}) — alert NOT triggered: Visual alert is OFF"
        run_s = float(self.settings.get("alert_duration_s", 8))
        with self.lock:
            was = self.on
            self.on = True
            self.run_s = run_s
            self.until = now + run_s
            self.started_at = self.started_at if was else now
        self._wake.set()
        # Trigger ESP32 over Wi-Fi
        _trigger_esp32(f"alert?duration={int(run_s)}")
        link = self._get_link()
        self._set_relay(link, 1)
        if was:
            msg = f"{label} ({what}) — visual alert stays active, {run_s:g} s again"
        else:
            msg = f"{label} ({what}) — VISUAL ALERT ACTIVE (LED strip & buzzer pulsing rhythm for {run_s:g} s)"
        self._event(msg)
        return True, msg

    def stop(self, why="stopped"):
        with self.lock:
            was = self.on
            self.on = False
            self.until = 0.0
            self.started_at = None
        # Stop ESP32 over Wi-Fi
        _trigger_esp32("stop")
        link = self._get_link()
        self._set_relay(link, 0)
        time.sleep(0.04)
        self._set_relay(link, 0)
        if was:
            self._event(f"VISUAL ALERT OFF ({why}) — LED strip & buzzer silenced")
        return was

    def view(self):
        now = time.time()
        st = self.settings
        with self.lock:
            on, until, run_s = self.on, self.until, self.run_s
            state = self.relay_state
        return {
            "enabled": bool(st.get("alert_on_signal", True)),
            "on": on,
            "duration_s": float(st.get("alert_duration_s", 8)),
            "left_s": round(max(0.0, until - now), 1) if on else None,
            "relay_pin": 50,
            "relay_state": state,
        }


ALERT = AlertBlinker()

# ---------------------------------------------------------------- the boat's own camera -> motor -> scoop
# The app watches the boat's camera, tracks what it sees and sends ONE verified
# item (src/lib/boatTarget.js: right class, sure enough, seen in several passes
# running, with its distance ahead in metres). This is what acts on it:
#
#   plastic verified ──▶ motor on (camera_motor_pct)
#          │                 the boat moves towards it, distance updated 6x/s
#          │
#          ├─ reaches camera_scoop_m, in front of the boat ──▶ motor OFF, scoop
#          │                                                   (every check in
#          │                                                    camera_checks)
#          └─ out of sight longer than camera_lock_lost_s ───▶ motor OFF
#
# Nothing here starts the motor on a raw detection box. The app's lock has
# already applied class, confidence and persistence; this applies them AGAIN
# (never trust one side alone), plus the boat-only conditions the app cannot
# see: armed, in MANUAL, slow enough, scoop free.
CAMERA_TICK_S = 0.2


class CameraCollect:
    """Verified plastic from the boat's camera: go to it, scoop it, move on."""

    def __init__(self):
        self.lock = threading.RLock()
        self.state = "idle"          # idle | approach | collecting | cooldown
        self.target = None           # the app's verified item (its last report)
        self.t_seen = 0.0            # when it was last reported
        self.t_obs = 0.0             # when ANY observation last arrived
        self.cooldown_until = 0.0
        self.motor_mine = False      # this is running the motor (not the drone path)
        self.collected = 0
        self.refused = None          # why the last scoop did not happen
        self.last_reason = None
        self.close_hits = 0          # readings in a row with the plastic VERY close / inside the scoop
        self.seen_outside = False    # the locked item was seen out on the water, outside the scoop
        self.scoop_why = None        # why the scoop is not closing on the item right now
        self._note_key, self._note_t = None, 0.0
        self._cycle_gen = None
        self._started = False

    # ------------------------------------------------------------ thread
    def start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._run, name="camera-collect", daemon=True).start()

    def _run(self):
        while True:
            time.sleep(CAMERA_TICK_S)
            try:
                self._tick()
            except Exception:                                        # noqa: BLE001
                log.exception("camera collect")

    def _tick(self):
        """Safety net, 5x a second: nothing may keep the motor on by itself.

        The app stops sending (its tab closed, the laptop slept, the link
        dropped), or the plastic goes out of sight — either way the motor stops
        here, without waiting for the run timer."""
        now = time.time()
        with self.lock:
            state, t_seen, t_obs, mine = self.state, self.t_seen, self.t_obs, self.motor_mine
            lost_s = self._lost_s()
            stale_s = float(OPS_SETTINGS["camera_stale_s"])
        if state == "cooldown" and now >= self.cooldown_until:
            with self.lock:
                if self.state == "cooldown":
                    self.state = "idle"
        if state == "collecting":
            self._watch_cycle()
            return
        if state not in ("approach",):
            return
        if now - t_obs > stale_s:
            self._lose(f"the app stopped sending what the camera sees ({now - t_obs:.1f} s)")
        elif now - t_seen > lost_s:
            self._lose(f"the plastic went out of sight for {now - t_seen:.1f} s")
        elif mine:
            # Keep the run alive while the boat is still going for it, without
            # filling the event log: the motor's own timer is the backstop.
            self._push(quiet=True)

    @staticmethod
    def _lost_s():
        cfg = getattr(_main(), "cfg", None) or {}
        try:
            return float(cfg.get("camera_lock_lost_s", 1.2))
        except (TypeError, ValueError):
            return 1.2

    # ------------------------------------------------------------ what the app saw
    def observe(self, payload):
        """One observation from the app. `plastic` is its verified item, or None."""
        now = time.time()
        with self.lock:
            self.t_obs = now
        item = payload.get("plastic") if isinstance(payload, dict) else None
        valid, why = self._valid(item)
        if not valid:
            with self.lock:
                self.last_reason = why
                state, t_seen = self.state, self.t_seen
            if isinstance(item, dict) and OPS_SETTINGS.get("camera_scoop_inside", True) and self.in_scoop(item):
                self._note(why)
            if state == "approach" and now - t_seen > self._lost_s():
                self._lose(why or "the plastic went out of sight")
            return
        with self.lock:
            if self.state in ("collecting", "cooldown"):
                return                                   # busy with the last one
            same = self.target and self.target.get("id") == item.get("id")
            self.target, self.t_seen, self.last_reason = item, now, None
            if not same:
                self.close_hits = 0
                self.seen_outside = False
            if not same and self.state == "approach":
                self.event_new(item)
            elif self.state == "idle":
                self.state = "approach"
                self.event_new(item)
        # 1. The motor pushes the boat towards the plastic (the app only locks
        #    plastic that MATCHES the drone's picture when there is one).
        # 2. The scoop moves only when that plastic is TRAPPED inside the scoop:
        #    seen out on the water first, then inside the scoop's mouth, several
        #    readings in a row — never on one reading, never on something that
        #    was sitting in the scoop all along.
        ready, why = self.ready_to_scoop(item, count=True)
        with self.lock:
            self.scoop_why = why
        if why and OPS_SETTINGS.get("camera_scoop_inside", True) and self.in_scoop(item)                 and not why.startswith("inside the scoop "):
            self._note(why)
        if ready:
            self._collect(item)
        else:
            self._push()

    def _note(self, why):
        """The waste is in the scoop's mouth but the scoop will not close: say
        why in the event log (once per reason, at most every 5 s)."""
        now = time.time()
        with self.lock:
            if why == self._note_key and now - self._note_t < 5.0:
                return
            self._note_key, self._note_t, self.scoop_why = why, now, why
        OPS.event(f"Boat camera: waste in the scoop but not scooping — {why}", "warn")

    @staticmethod
    def scoop_zone():
        st = OPS_SETTINGS
        return (float(st["scoop_zone_x1"]), float(st["scoop_zone_y1"]),
                float(st["scoop_zone_x2"]), float(st["scoop_zone_y2"]))

    def in_scoop(self, item):
        """Is the item's box centre inside the scoop's mouth? None: the app sent no box."""
        box = item.get("box") if isinstance(item, dict) else None
        try:
            x1, y1, x2, y2 = (float(v) for v in box)
        except (TypeError, ValueError):
            return None
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        zx1, zy1, zx2, zy2 = self.scoop_zone()
        return zx1 <= cx <= zx2 and zy1 <= cy <= zy2

    def ready_to_scoop(self, item, count=False):
        """(ready, why not). With count=True this is one new reading: it moves the
        in-a-row counter. Otherwise it only reports the current state."""
        st = OPS_SETTINGS
        need = max(1, int(st.get("camera_scoop_confirm", 3)))
        if st.get("camera_scoop_inside", True):
            inside = self.in_scoop(item)
            # Only a reading where the item is in sight NOW counts: the app keeps a
            # lock alive (with its last box) for a moment after losing sight of it.
            seen_now = item.get("visible") is not False
            # Seen out on the water first: optional, so a bottle put straight
            # into the scoop (or one the camera first sees already there) counts.
            need_out = bool(st.get("camera_scoop_seen_first", False))
            with self.lock:
                if inside is False and seen_now:
                    self.seen_outside = True
                if count:
                    self.close_hits = self.close_hits + 1                         if (inside and seen_now and (self.seen_outside or not need_out)) else 0
                hits, outside = self.close_hits, self.seen_outside
            if inside is None:
                return False, "the app sends no box position (update the app)"
            if need_out and not outside:
                return False, "not seen out on the water first (it may be part of the boat)"
            if not inside:
                return False, "not inside the scoop yet"
            if hits < need:
                return False, f"inside the scoop {hits}x in a row (needs {need})"
            return True, None
        d = item.get("distance_m")
        very_close = d is not None and float(d) <= float(st["camera_scoop_m"]) and bool(item.get("centred"))
        with self.lock:
            if count:
                self.close_hits = self.close_hits + 1 if very_close else 0
            hits = self.close_hits
        if not very_close:
            return False, "not very close yet"
        if hits < need:
            return False, f"very close {hits}x in a row (needs {need})"
        return True, None

    def event_new(self, item):
        d = item.get("distance_m")
        OPS.event(f"Boat camera: plastic verified ({item.get('label') or 'plastic'}, "
                  f"{float(item.get('score') or 0) * 100:.0f}%, seen {item.get('hits')}x)"
                  + (f" — {d:.2f} m ahead" if d is not None else ""))
        if OPS_SETTINGS.get("camera_alert"):
            try:
                ALERT.signal([str(item.get("id"))], source="boat camera")
            except Exception:                                        # noqa: BLE001
                log.exception("camera alert")

    def _valid(self, item):
        """The app's item, checked again here. (ok, why not)."""
        if not isinstance(item, dict):
            return False, "no plastic in view"
        if not item.get("confirmed"):
            return False, "not verified yet"
        cfg = getattr(_main(), "cfg", None) or {}
        try:
            conf = float(cfg.get("camera_plastic_conf", 0.45))
            hits = int(cfg.get("camera_plastic_hits", 2))
            max_m = float(cfg.get("camera_target_max_m", 15.0))
            if cfg.get("camera_long_range"):  # Boat tab "Long range": far plastic counts too
                max_m = max(max_m, float(cfg.get("camera_long_range_max_m", 30.0)))
            max_frac = float(cfg.get("camera_max_box_frac", 0.25))
        except (TypeError, ValueError):
            conf, hits, max_m, max_frac = 0.45, 2, 15.0, 0.25
        try:
            frac = float(item.get("box_frac"))
        except (TypeError, ValueError):
            frac = None
        # Waste trapped in the scoop is right under the lens, so it is big in the
        # picture: there it may cover up to 90 % (a whole-picture box still can't).
        if frac is not None and frac > max_frac and OPS_SETTINGS.get("camera_scoop_inside", True)                 and self.in_scoop(item):
            max_frac = max(max_frac, 0.9)
        if frac is not None and frac > max_frac:
            return False, f"box covers {frac * 100:.0f}% of the picture - the scene, not an item"
        if float(item.get("score") or 0) < conf:
            return False, f"only {float(item.get('score') or 0) * 100:.0f}% sure (needs {conf * 100:.0f}%)"
        if int(item.get("hits") or 0) < hits and float(item.get("score") or 0) < 0.8:
            return False, f"seen {item.get('hits')}x (needs {hits})"
        # Any plastic the camera sees runs the motor, near or far, with or
        # without a distance; the scoop alone needs a known, short distance.
        return True, None

    # ------------------------------------------------------------ motor
    def _push(self, quiet=False):
        if not OPS_SETTINGS.get("camera_motor", True):
            with self.lock:
                self.last_reason = "Camera motor is OFF"
            return
        with self.lock:
            item = self.target
        if not item:
            return
        # Already running with time to spare: leave it alone.
        with MOTOR.lock:
            on, until, run_s = MOTOR.on, MOTOR.until, MOTOR.run_s or 10.0
        if on and until - time.time() > max(1.0, run_s / 3.0):
            with self.lock:
                self.motor_mine = True
            return
        started, msg = MOTOR.signal([str(item.get("id"))], source="boat camera", gate="camera_motor",
                                    pct=float(OPS_SETTINGS["camera_motor_pct"]), quiet=quiet)
        with self.lock:
            self.motor_mine = bool(started)
            if not started:
                self.last_reason = msg

    def _stop_motor(self, why):
        with self.lock:
            mine = self.motor_mine
            self.motor_mine = False
        if mine:
            MOTOR.stop(why)

    def _lose(self, why):
        with self.lock:
            if self.state != "approach":
                return
            self.state = "idle"
            self.target = None
            self.close_hits = 0
            self.seen_outside = False
            self.last_reason = why
        self._stop_motor(why)
        OPS.event(f"Boat camera: plastic lost — {why}", "warn")

    # ------------------------------------------------------------ scoop
    def _collect(self, item):
        M = _main()
        vm = getattr(M, "vision", None) if M else None
        if vm is None:
            return
        with self.lock:
            self.state = "collecting"
            self.close_hits = 0
            self.seen_outside = False
        # Stop pushing first: the boat coasts the last stretch into the item
        # instead of driving over it while the scoop is still moving.
        inside = OPS_SETTINGS.get("camera_scoop_inside", True)
        self._stop_motor("plastic is inside the scoop" if inside else "plastic is very close")
        d = item.get("distance_m")
        OPS.event("Boat camera: plastic trapped inside the scoop — motor off, scooping" if inside
                  else f"Boat camera: plastic very close" + (f" ({d:.2f} m)" if d is not None else "")
                  + " — motor off, scooping")
        with OPS.lock:
            self._cycle_gen = OPS.gen + 1
        OPS.request_collect(vm, f"camera-{item.get('id')}", None, source="camera", target=item,
                            on_refused=self._refused)

    def _refused(self):
        with self.lock:
            self.refused = time.time()
        self._done(collected=False)

    def _watch_cycle(self):
        """The scoop cycle runs in its own thread; see when it has finished."""
        with OPS.lock:
            state = OPS.cycle.get("state")
        if state in ("checking", "waiting", "to_extreme", "holding", "to_zero"):
            return
        self._done(collected=state == "done")

    def _done(self, collected):
        with self.lock:
            if self.state != "collecting":
                return
            self.target = None
            self.state = "cooldown"
            self.cooldown_until = time.time() + float(OPS_SETTINGS["camera_cooldown_s"])
            if collected:
                self.collected += 1
        OPS.event("Boat camera: collected — ready for the next plastic" if collected
                  else "Boat camera: the scoop did not run — ready for the next plastic",
                  "info" if collected else "warn")

    # ------------------------------------------------------------ operator / the app's view
    def abort(self, why="operator"):
        with self.lock:
            busy = self.state in ("approach", "collecting")
            self.state = "idle"
            self.target = None
            self.close_hits = 0
            self.seen_outside = False
            self.cooldown_until = 0.0
        self._stop_motor(why)
        return busy

    def view(self):
        now = time.time()
        with self.lock:
            state, item, t_seen, t_obs = self.state, self.target, self.t_seen, self.t_obs
            reason, collected = self.last_reason, self.collected
            cool = max(0.0, self.cooldown_until - now)
        st = OPS_SETTINGS
        return {
            "enabled": bool(st.get("camera_motor", True)),
            "scoop_enabled": bool(st.get("camera_scoop", True)),
            "state": state,
            "target": item,
            "distance_m": (item or {}).get("distance_m"),
            "seen_ago_s": round(now - t_seen, 2) if t_seen else None,
            "app_ago_s": round(now - t_obs, 2) if t_obs else None,
            "scoop_m": float(st["camera_scoop_m"]),
            "close_hits": self.close_hits,
            "close_need": int(st.get("camera_scoop_confirm", 3)),
            "scoop_inside": bool(st.get("camera_scoop_inside", True)),
            "in_scoop": self.in_scoop(item) if item else None,
            "seen_outside": self.seen_outside,
            "seen_first": bool(st.get("camera_scoop_seen_first", False)),
            "scoop_why": self.scoop_why if item else None,
            "motor_pct": float(st["camera_motor_pct"]),
            "cooldown_s": round(cool, 1) if cool else None,
            "collected": collected,
            "why": reason,
        }


CAMERA = CameraCollect()

# Patched in when the boat program starts (Collector.start runs in its lifespan),
# so vision.py is loaded by main.py itself first.
_col_start = collector.Collector.start


def _col_start_ops(self):
    _col_start(self)
    vision_mod = sys.modules.get("vision")
    if vision_mod is not None and not getattr(vision_mod.VisionManager, "_ops_patched", False):
        orig = vision_mod.VisionManager._live_state

        def _live_state_ops(vm, state, note=None, **fields):
            orig(vm, state, note, **fields)
            if state == "COLLECTING" and vm.hm.get("source") == "live" and vm.hm.get("wid"):
                OPS.request_collect(vm, vm.hm["wid"], vm.hm.get("match"))

        vision_mod.VisionManager._live_state = _live_state_ops
        vision_mod.VisionManager._ops_patched = True

    def _rc_rate_loop():
        asked = 0.0
        while not self._stop.is_set():
            if self.link.fc_connected and time.time() - asked > 10:   # a Pixhawk reboot forgets it
                asked = time.time()
                try:
                    self.link.set_message_rate(RC_CHANNELS_MSG, RC_CHANNELS_HZ)
                except Exception:                                    # noqa: BLE001
                    pass
            self._stop.wait(1.0)

    threading.Thread(target=_rc_rate_loop, name="rc-rate", daemon=True).start()
    OPS.start()
    MOTOR.start()
    ALERT.start()
    CAMERA.start()
    CAPTAIN.start()


collector.Collector.start = _col_start_ops

# ---------------------------------------------------------------- START without the Pixhawk
# The Boat tab's START always starts live collect. If the Pixhawk isn't ready
# (not connected, no GPS, won't arm, not GUIDED) its checks are skipped: the
# boat still takes drone finds, shows the drone's picture and matches on the
# camera — it just can't drive itself until the Pixhawk is armed in GUIDED,
# then normal driving takes over by itself. The Pixhawk's OWN failsafes
# (radio lost -> HOLD) are untouched.
import live_collect  # noqa: E402

_lc_start, _lc_tick = live_collect.LiveCollect.start, live_collect.LiveCollect._tick


def _lc_start_skip(self, when_empty="wait", speed_mps=None):
    try:
        msg = _lc_start(self, when_empty, speed_mps)
        self.pixhawk_skipped = False
        return msg
    except LinkError as exc:
        why = str(exc)
        if when_empty not in ("wait", "return") or "mission" in why or "returning home" in why:
            raise
        with self._lock:
            resumed = self.state == "paused"
            self.when_empty = when_empty
            self.state, self.reason = "running", None
            self.current, self.phase = None, None
            self._t_goto = 0.0
            self.started_at = self.started_at if (resumed and self.started_at) else time.time()
            for t in self.targets.values():
                if t["status"] == "active":
                    t["status"] = "pending"
            self.pixhawk_skipped = True
            self._event(f"Started — Pixhawk checks skipped ({why})", "warn")
        if self.vision is not None:
            try:
                self.vision.operator_start()
            except Exception:                                        # noqa: BLE001
                pass
        return f"Started (Pixhawk skipped: {why})"


def _lc_tick_skip(self):
    if getattr(self, "pixhawk_skipped", False) and self.state == "running":
        s = self.link.snapshot()
        if not (s["fc_connected"] and s["armed"] and s.get("flight_mode") == "GUIDED"):
            return                       # no pausing on Pixhawk state; nothing to drive yet
        with self._lock:
            self.pixhawk_skipped = False     # armed in GUIDED now: normal driving takes over
            self._t_mode = time.time()
            self._event("Pixhawk ready (armed, GUIDED) — boat driving to the waste")
    return _lc_tick(self)


live_collect.LiveCollect.start = _lc_start_skip
live_collect.LiveCollect._tick = _lc_tick_skip

# ---------------------------------------------------------------- drone signal -> motor
# A NEW drone find arriving (POST /api/live/targets -> "added") is the signal
# that starts the motor push. The same plastic sent again (updated / merged)
# does not restart it. Every operator command that pauses / stops live collect
# (STOP = Hold, brake, emergency stop, arm / disarm, mode from the app, Pause,
# Stop) also hands the throttle straight back to the transmitter.
_lc_add, _lc_operator = live_collect.LiveCollect.add_targets, live_collect.LiveCollect.operator
_lc_pause, _lc_stop = live_collect.LiveCollect.pause, live_collect.LiveCollect.stop


def _lc_add_signal(self, items):
    res = _lc_add(self, items)
    if res.get("added"):
        try:
            # Not forced: Auto motor OFF means OFF, and a drone find never arms
            # the boat or changes its mode — it only runs a motor the operator
            # has already armed in MANUAL.
            MOTOR.signal(res["added"], source="drone")
        except Exception:                                            # noqa: BLE001 - never break the intake
            log.exception("motor signal")
        try:
            ALERT.signal(res["added"], source="drone")
        except Exception:                                            # noqa: BLE001
            log.exception("alert signal")
    return res


# ---------------------------------------------------------------- what the boat's camera sees
# Every observation from the app goes to CameraCollect, which acts only on the
# ONE item the app has verified as plastic (payload["plastic"]). The raw boxes
# are what the operator sees on screen and what the drone-target homing uses;
# they never move anything by themselves.
_orig_vision_observe = vision.VisionManager.observe


def _vision_observe_with_triggers(self, payload):
    res = _orig_vision_observe(self, payload)
    try:
        CAMERA.observe(payload if isinstance(payload, dict) else {})
    except Exception:                                                # noqa: BLE001 - never break seeing
        log.exception("camera collect observe")
    return res


vision.VisionManager.observe = _vision_observe_with_triggers


def _lc_operator_motor(self, reason):
    CAMERA.abort(f"operator: {reason}")
    MOTOR.stop(f"operator: {reason}")
    ALERT.stop(f"operator: {reason}")
    return _lc_operator(self, reason)


def _lc_pause_motor(self, reason="paused from the app", hold=True):
    CAMERA.abort(reason)
    MOTOR.stop(reason)
    ALERT.stop(reason)
    return _lc_pause(self, reason, hold)


def _lc_stop_motor(self, rtl=False):
    CAMERA.abort("live collect stopped")
    MOTOR.stop("live collect stopped")
    ALERT.stop("live collect stopped")
    return _lc_stop(self, rtl)


live_collect.LiveCollect.add_targets = _lc_add_signal
live_collect.LiveCollect.operator = _lc_operator_motor
live_collect.LiveCollect.pause = _lc_pause_motor
live_collect.LiveCollect.stop = _lc_stop_motor

# ---------------------------------------------------------------- AI captain's world (laptop -> boat phone)
# The trained captain runs on the boat phone (VARUNA Boat Link 2.4+). The phone
# knows its own GPS and compass; what it cannot know is WHERE the plastic is.
# Once a second this sends it: the drone's finds (lat/lng), what the boat's
# camera sees right now (metres ahead / to the right), home, and how full the
# bin is. It only ever describes the world: it cannot switch the captain to
# full control (that is on the phone screen only) - the one command it can
# send is STOP (POST /api/ops/captain {"action": "stop"}).
CAPTAIN_FEED_S = 1.0
CAPTAIN_SIM_BIN = 30            # the captain was trained with a 30-item bin
CAPTAIN_CAM_MAX_M = 25.0
CAPTAIN_TARGET_MAX_AGE_S = 2 * 3600   # older drone finds are not sent


class CaptainFeed:
    def __init__(self):
        self.lock = threading.Lock()
        self.enabled = os.environ.get("VARUNA_CAPTAIN_FEED", "1") != "0"
        self.sent = 0
        self.last_ok_t = 0.0
        self.last_err = None
        self.last_world = None
        self.phone_captain = None     # the phone's /captain.json
        self.phone_captain_t = 0.0
        self._home = None             # first good boat position, when the Pixhawk has no home
        self._started = False

    def start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._run, name="captain-feed", daemon=True).start()

    def _run(self):
        while True:
            time.sleep(CAPTAIN_FEED_S)
            if not (self.enabled and OPS.phone_url):
                continue
            try:
                world = self.world()
                if world is None:
                    continue
                self._post("/captain/world", world)
                with self.lock:
                    self.sent += 1
                    self.last_ok_t, self.last_err, self.last_world = time.time(), None, world
                self._read_phone()
            except Exception as exc:                                 # noqa: BLE001 - phone away = try again
                with self.lock:
                    self.last_err = str(exc)[:200]

    def _post(self, path, body):
        req = urllib.request.Request(OPS.phone_url + path, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=1.5) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def _read_phone(self):
        with urllib.request.urlopen(OPS.phone_url + "/captain.json", timeout=1.5) as r:
            j = json.loads(r.read().decode("utf-8"))
        with self.lock:
            self.phone_captain, self.phone_captain_t = j, time.time()

    # ------------------------------------------------------------ what the captain should know
    def world(self):
        M = _main()
        if M is None or not hasattr(M, "link"):
            return None
        s = M.link.snapshot()
        now = time.time()
        lat, lng, _src = OPS.boat_position(s)
        if s.get("home_lat") is not None:
            home = [s["home_lat"], s["home_lng"]]
        else:
            if self._home is None and lat is not None:
                self._home = [lat, lng]
            home = self._home
        plastic = []
        for t in list(M.live.targets.values()):
            if t.get("status") in live_collect.ACTIVE and t.get("lat") is not None:
                seen = t.get("detected_at") or t.get("added_at") or now
                age = max(0.0, now - seen)
                if age <= CAPTAIN_TARGET_MAX_AGE_S:          # days-old finds have drifted away
                    plastic.append({"lat": t["lat"], "lng": t["lng"], "age_s": round(age, 1)})
        plastic.sort(key=lambda p: p["age_s"])
        plastic.extend(self._camera_items(M, now))
        bin_info = M.vision.catch_summary().get("bin", {})
        cap = bin_info.get("capacity") or M.cfg.get("bin_capacity_items") or 75
        count = int(bin_info.get("count") or 0)
        w = {"plastic": plastic[:24], "weeds": [], "shore": [],
             "bin": int(round(CAPTAIN_SIM_BIN * min(1.0, count / float(cap)))),
             "go_home": bool(bin_info.get("full")) or getattr(M.live, "state", None) == "returning"}
        if home:
            w["home"] = [float(home[0]), float(home[1])]
        return w

    @staticmethod
    def _camera_items(M, now):
        """Plastic the boat's camera sees right now, metres ahead / to the right of the boat."""
        vm = M.vision
        with vm._obs_lock:
            obs, at = vm.obs, vm.obs_at
        if not obs or now - at > vision.OBS_FRESH_S:
            return []
        cfg = M.cfg
        w, h = obs.get("frame_w") or cfg["camera_width"], obs.get("frame_h") or cfg["camera_height"]
        cam = camera_model.CameraModel.from_cfg(cfg, w, h)
        ramp_y = cfg["ramp_top"] * h
        out = []
        for b in obs.get("targets") or []:
            try:
                x = (float(b["x1"]) + float(b["x2"])) / 2
                y = float(b["y2"])           # where the item meets the water
                if (float(b["y1"]) + float(b["y2"])) / 2 > ramp_y:
                    continue                 # already on the ramp
            except (KeyError, TypeError, ValueError):
                continue
            g = cam.pixel_to_ground(x, min(y, ramp_y))
            if g is None or not 0 < g[0] <= CAPTAIN_CAM_MAX_M:
                continue
            out.append({"fwd_m": round(g[0], 2), "right_m": round(g[1], 2), "age_s": 0})
        return out[:8]

    # ------------------------------------------------------------ for the app
    def stop(self, why):
        if not OPS.phone_url:
            return False, "No boat phone configured (BOAT_PHONE_URL)."
        try:
            self._post("/captain/stop", {"why": why})
        except Exception as exc:                                     # noqa: BLE001
            return False, f"Could not reach the boat phone: {exc}"
        OPS.event(f"AI captain stopped ({why})", "warn")
        return True, "Captain stopped - back to watch only."

    def view(self):
        with self.lock:
            fresh = time.time() - self.phone_captain_t < 5
            lw = self.last_world or {}
            return {"enabled": self.enabled, "phone": bool(OPS.phone_url), "sent": self.sent,
                    "last_sent_s": round(time.time() - self.last_ok_t, 1) if self.last_ok_t else None,
                    "error": self.last_err,
                    "plastic": len(lw.get("plastic") or []), "bin": lw.get("bin"), "go_home": lw.get("go_home"),
                    "captain": self.phone_captain if fresh else None}


CAPTAIN = CaptainFeed()


# ---------------------------------------------------------------- /api/ops/... for the app
import fastapi  # noqa: E402
from fastapi import APIRouter, Body  # noqa: E402

ops_router = APIRouter()


@ops_router.get("/api/ops/status")
def ops_status():
    out = OPS.status()
    if isinstance(out, dict) and out.get("success", True) is not False:
        out["captain"] = CAPTAIN.view()
    return out


@ops_router.get("/api/ops/captain")
def ops_captain():
    return {"success": True, **CAPTAIN.view()}


@ops_router.post("/api/ops/captain")
def ops_captain_cmd(body: dict = Body(...)):
    """AI captain on the boat phone: stop only. Full control is switched on at the phone itself."""
    if str(body.get("action", "")) != "stop":
        return {"success": False, "message": "Only stop is possible from here; full control is on the boat phone."}
    ok, msg = CAPTAIN.stop("operator (app)")
    return {"success": ok, "message": msg}


@ops_router.post("/api/ops/settings")
def ops_settings(body: dict = Body(...)):
    new, err = update_ops(body)
    if err:
        return {"success": False, "message": err, "settings": dict(new)}
    OPS.event("Settings changed: " + ", ".join(f"{k}={v}" for k, v in body.items()))
    if "motor_on_signal" in body and not new["motor_on_signal"]:
        MOTOR.stop("Auto motor switched OFF")
    if "alert_on_signal" in body and not new["alert_on_signal"]:
        ALERT.stop("Visual alert switched OFF")
    if "camera_motor" in body and not new["camera_motor"]:
        CAMERA.abort("Camera motor switched OFF")
    return {"success": True, "message": "Saved.", "settings": dict(new)}


@ops_router.post("/api/ops/alert")
def ops_alert(body: dict = Body(...)):
    """Visual alert (LED strip + buzzer): test | stop."""
    action = str(body.get("action", ""))
    if action == "stop":
        was = ALERT.stop("operator (app)")
        return {"success": True, "message": "Alert stopped (LED strip & buzzer OFF)." if was
                else "The alert was not active."}
    if action == "test":
        started, msg = ALERT.signal(["test"], source="operator test", force=True)
        return {"success": started, "message": msg}
    return {"success": False, "message": "action must be test or stop"}


@ops_router.post("/api/ops/motor")
def ops_motor(body: dict = Body(...)):
    """Motor on drone signal: test (acts exactly like a new drone find) | stop."""
    action = str(body.get("action", ""))
    if action == "stop":
        was = MOTOR.stop("operator (app)")
        return {"success": True, "message": "Motor stopped — throttle back on the transmitter." if was
                else "The motor was not running."}
    if action == "test":
        started, msg = MOTOR.signal(["test"], source="operator test", force=True)
        return {"success": started, "message": msg}
    return {"success": False, "message": "action must be test or stop"}


@ops_router.post("/api/ops/scoop")
def ops_scoop(body: dict = Body(...)):
    """Operator scoop control: extreme | zero | abort."""
    action = str(body.get("action", ""))
    M = _main()
    col = M.collector
    if action == "abort":
        CAMERA.abort("operator")
        was = OPS.abort("operator")
        return {"success": True, "message": "Scoop cycle aborted, scoop gliding back to 0." if was
                else "No cycle running — scoop gliding back to 0."}
    if action in ("extreme", "zero"):
        OPS.abort("operator moved the scoop") if OPS.cycle["state"] in ("waiting", "to_extreme", "holding", "to_zero") else None
        try:
            msg = col.set(action == "extreme", "operator (app)")
        except LinkError as exc:
            return {"success": False, "message": str(exc)}
        OPS.event(f"Operator: scoop to {action}")
        return {"success": True, "message": msg}
    return {"success": False, "message": "action must be extreme, zero or abort"}


@ops_router.get("/api/ops/events")
def ops_events(limit: int = 200):
    with OPS.lock:
        return {"success": True, "events": list(OPS.events)[-max(1, min(limit, 400)):]}


_fastapi_init = fastapi.FastAPI.__init__


def _fastapi_init_ops(self, *a, **k):
    _fastapi_init(self, *a, **k)
    self.include_router(ops_router)


fastapi.FastAPI.__init__ = _fastapi_init_ops

if __name__ == "__main__":
    # Exactly like "py main.py ...": main() reads the arguments, then uvicorn
    # imports main.py afresh, using the classes extended above.
    import runpy
    runpy.run_path(os.path.join(HERE, "main.py"), run_name="__main__")
