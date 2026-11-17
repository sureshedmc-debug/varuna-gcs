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
import collector  # noqa: E402
import mav_link  # noqa: E402
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
         ["curl", "-sSN", "--max-time", "0", "--connect-timeout", "5", url]),
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
    "require_match": True,           # the camera's item must match the drone's picture
}
OPS_LIMITS = {"scoop_speed_pct": (5, 100), "scoop_servo_s_per_60": (0.05, 1.0),
              "scoop_deg_per_1000us": (30, 270), "scoop_hold_s": (0, 30), "scoop_delay_s": (-1, 15),
              "collect_max_speed_mps": (0.1, 3.0), "collect_max_gps_m": (2.0, 30.0)}
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
        if self.cycle["state"] in ("checking", "waiting", "to_extreme", "holding") and live.state != "running":
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

    def request_collect(self, vm, tid, match):
        with self.lock:
            busy = self.cycle["state"] in ("checking", "waiting", "to_extreme", "holding", "to_zero")
            if not busy:
                self.gen += 1
                gen = self.gen
                self.cycle = {"state": "checking", "t": time.time(), "tid": tid, "match": match}
        if busy:
            self.event(f"Collection request for {tid} ignored: the scoop is already in a cycle", "warn")
            return
        threading.Thread(target=self._cycle, args=(gen, vm, tid, match), name="scoop-cycle", daemon=True).start()

    def _set_cycle(self, gen, state, **kw):
        with self.lock:
            if gen == self.gen:
                self.cycle = {**self.cycle, "state": state, "t": time.time(), **kw}
                return True
            return False

    def _cycle(self, gen, vm, tid, match):
        ok, checks = self.checks(vm, tid, match)
        self.last_check = {"t": round(time.time(), 1), "tid": tid, "ok": ok,
                           "checks": [{"text": c, "ok": bool(v)} for c, v in checks]}
        if not ok:
            failed = "; ".join(c for c, v in checks if not v)
            self.event(f"Scoop NOT activated for {tid}: {failed}", "warn")
            self._set_cycle(gen, "refused", why=failed)
            return
        col = vm.live.collector
        st, cfg = OPS_SETTINGS, vm.cfg
        self.event(f"Scoop collection initiated — target {tid}" + (f", match {match * 100:.0f}%" if match is not None else ""))
        delay = st["scoop_delay_s"]
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
        }


OPS = Ops()

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

# ---------------------------------------------------------------- /api/ops/... for the app
import fastapi  # noqa: E402
from fastapi import APIRouter, Body  # noqa: E402

ops_router = APIRouter()


@ops_router.get("/api/ops/status")
def ops_status():
    return OPS.status()


@ops_router.post("/api/ops/settings")
def ops_settings(body: dict = Body(...)):
    new, err = update_ops(body)
    if err:
        return {"success": False, "message": err, "settings": dict(new)}
    OPS.event("Settings changed: " + ", ".join(f"{k}={v}" for k, v in body.items()))
    return {"success": True, "message": "Saved.", "settings": dict(new)}


@ops_router.post("/api/ops/scoop")
def ops_scoop(body: dict = Body(...)):
    """Operator scoop control: extreme | zero | abort."""
    action = str(body.get("action", ""))
    M = _main()
    col = M.collector
    if action == "abort":
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
