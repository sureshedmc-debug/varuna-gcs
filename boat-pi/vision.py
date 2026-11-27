"""
Boat camera automation, decided on the boat's Pi.

The AI itself runs in the VARUNA app on the laptop (a Pi Zero is far too slow
for it): the app watches the boat's video and, a few times a second, POSTs
what it saw to /api/vision/observe — plastic in the water, animals in the
danger zone — with the capture time of that frame. Everything that MOVES the
boat is decided here, on the boat, so it behaves sensibly when the link drops:

  * wildlife guard    animal in the danger zone → HOLD; zone clear 5 s → carry on
  * last-metre homing near a plastic point → GUIDED onto the item → back to AUTO
                      (or, in live collect, back to the live queue — live_collect.py)
  * water measurement HOLD, average the turbidity sensor, carry on
  * vision watchdog   the app's vision stopped arriving → slow down / hold / continue

In live collect the homing is the boat half of the drone-to-boat workflow:
it only accepts plastic that MATCHES the drone's reference crop
(target_match.py; candidates are cut out of the Pi's own copy of the frame the
app analysed, or sent by the app as `crop`), drives through it, then VERIFIES
the pick-up: the catch counter saw it on the ramp, or — with verify_lookback —
the boat turns back to the spot and looks. Still there: retry, up to
collect_max_retries, then RETRY_REQUIRED. Never seen: NOT_FOUND.

Priority: operator commands > wildlife > water measurement > homing > mission.
Any operator command (pause, hold, RTL, stop, a mode change, disarm) stands the
automation down until the operator presses Start/Resume again.

All decisions run in one thread (`_tick`, 5 times a second). The web handlers
only record observations and requests, so two threads never command the
Pixhawk against each other.
"""

import base64
import json
import logging
import math
import threading
import time
from collections import Counter, deque
from datetime import datetime

import target_match
from camera_model import CameraModel, dist_m, offset, to_boat, to_world
from mav_link import LinkError

log = logging.getLogger("boat.vision")

TICK_S = 0.2
OBS_FRESH_S = 1.5           # an observation older than this is ignored
STILL_THERE_M = 3.0         # verification: a matching item this close to the spot is the one we missed
LOOK_HEADING_DEG = 25.0     # look-back: facing the spot within this
LOOK_PAN_M = 2.5            # look-back: also look at points this far either side of the spot
LOOK_TURN_S = 1.2           # ...turning towards each for this long
MATCH_LOG_S = 3.0           # "seen, but not the drone's item": at most this often in the events
APP_MATCH_WAIT_S = 3.0      # homing start: wait this long for the app's match scores before scoring here
SWEEP_R_M = 3.0             # search: at the point and nothing matching yet, sweep around it this far
SWEEP_LEG_S = 10.0          # ...moving to the next sweep point after this long at the latest
MAX_PHOTO_BYTES = 400_000


def _decode_photo(b64):
    """A small JPEG sent by the app (base64, optionally a data: URL), or None."""
    if not b64 or not isinstance(b64, str):
        return None
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    try:
        data = base64.b64decode(b64, validate=False)
    except (ValueError, TypeError):
        return None
    if len(data) > MAX_PHOTO_BYTES or data[:2] != b"\xff\xd8":
        return None
    return data


def _today(t):
    return datetime.fromtimestamp(t).date()


class PhotoLog:
    """Append-only log of events with an optional photo each (catch, wildlife)."""

    def __init__(self, data_dir, name, keep=5000):
        self.dir = data_dir / name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / f"{name}.jsonl"
        self.items = deque(maxlen=keep)
        self._lock = threading.Lock()
        self._seq = 0
        try:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    try:
                        self.items.append(json.loads(line))
                    except ValueError:
                        pass
        except OSError:
            pass
        if self.items:
            self._seq = max(int(str(i.get("id", "0")).lstrip("abcdefghijklmnopqrstuvwxyz") or 0) for i in self.items)

    def add(self, item, photo=None, prefix="i"):
        with self._lock:
            self._seq += 1
            item = {"id": f"{prefix}{self._seq}", **item, "photo": False}
            data = _decode_photo(photo)
            if data:
                try:
                    (self.dir / f"{item['id']}.jpg").write_bytes(data)
                    item["photo"] = True
                except OSError as exc:
                    log.warning("Could not save photo: %s", exc)
            self.items.append(item)
            try:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(item) + "\n")
            except OSError as exc:
                log.warning("Could not save %s: %s", self.path.name, exc)
            return item

    def update(self, item_id, photo):
        """Attach a photo to an item logged earlier (the app sends it a moment later)."""
        data = _decode_photo(photo)
        if not data:
            return False
        with self._lock:
            for it in self.items:
                if it["id"] == item_id and not it["photo"]:
                    try:
                        (self.dir / f"{item_id}.jpg").write_bytes(data)
                        it["photo"] = True
                        return True
                    except OSError:
                        return False
        return False

    def photo_path(self, item_id):
        p = self.dir / f"{item_id}.jpg"
        return p if p.is_file() else None

    def recent(self, limit=50):
        return list(self.items)[-limit:][::-1]


class VisionManager:
    def __init__(self, link, missions, cfg, data_dir, turbidity):
        self.link = link
        self.missions = missions
        self.live = None                     # live_collect.LiveCollect, set by main.py
        self.cfg = cfg
        self.turbidity = turbidity
        self.catch = PhotoLog(data_dir, "catch")
        self.sightings = PhotoLog(data_dir, "wildlife", keep=2000)
        self.state_path = data_dir / "vision_state.json"
        self.bin_count, self.bin_emptied_at = 0, None
        self._load_state()
        missions.automation = self.owner

        self._obs_lock = threading.Lock()
        self.obs = None
        self.obs_at = 0.0
        self.link_seen = False
        self.operator_paused = False
        self.lost_action = None              # what was done when the vision link went quiet
        self.lost_ack = False                # operator chose to carry on without the camera
        self.last_hazard_photo = (None, 0.0) # newest animal photo from the app, and when
        self.last_catch_t = 0.0
        self.events = deque(maxlen=30)
        self._requests = deque()

        self.wl = {"state": "clear", "since": None, "clear_since": None, "prev_mode": None,
                   "label": None, "sighting": None, "pauses": 0, "paused_s": 0.0, "day": None,
                   # after the operator's Resume / Skip: no new hold until the zone has been clear once
                   "suppress_until": 0.0, "suppress_clear": None}
        self.hm = self._idle_homing()
        self.hm_skip = set()                 # items homing already tried (no second attempt)
        self.camera = None                   # set by main.py: frame_near(t) for cutting out candidates
        self.matcher = target_match.make_matcher(cfg)
        self._scored = (None, [])            # (frame_time, candidates) of the last scored observation
        self.stats = {"attempts": 0, "collected": 0, "missed": 0, "aborted": 0}
        self.ms = None                       # measurement in progress
        self.last_reading = None
        self._rebuild_counts()

        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------------ persistence
    def _load_state(self):
        try:
            st = json.loads(self.state_path.read_text(encoding="utf-8"))
            self.bin_count = int(st.get("bin_count", 0))
            self.bin_emptied_at = st.get("bin_emptied_at")
        except (OSError, ValueError):
            pass

    def _save_state(self):
        try:
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"bin_count": self.bin_count, "bin_emptied_at": self.bin_emptied_at}),
                           encoding="utf-8")
            tmp.replace(self.state_path)
        except OSError as exc:
            log.warning("Could not save the bin count: %s", exc)

    def _rebuild_counts(self):
        """Running per-label counts, so status calls (4×/s) don't rescan the log."""
        items = list(self.catch.items)
        self.c_day = _today(time.time())
        self.c_today = Counter(i["label"] for i in items if _today(i["t"]) == self.c_day)
        self.c_all = Counter(i["label"] for i in items)
        self.c_since = Counter(i["label"] for i in items
                               if not self.bin_emptied_at or i["t"] >= self.bin_emptied_at)

    def _roll_day(self):
        day = _today(time.time())
        if day != self.c_day:
            self.c_day = day
            self.c_today = Counter()

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        self._thread = threading.Thread(target=self._run, name="vision", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("Vision step failed")
            self._stop.wait(TICK_S)

    def _event(self, text, level="info"):
        self.events.append({"t": round(time.time(), 1), "text": text, "level": level})
        (log.warning if level == "warn" else log.info)(text)

    # ------------------------------------------------------------------ who has the boat
    def owner(self):
        """"wildlife" / "measure" / "homing" while the automation holds or steers
        the boat, else None. Read by the mission manager (no locks taken)."""
        if self.wl["state"] != "clear":
            return "wildlife"
        if self.ms is not None and self.ms.get("changed"):
            return "measure"
        if self.hm["state"] != "idle":
            return "homing"
        if self.lost_action == "hold" and not self.operator_paused:
            return "camera_lost"             # held because the app's vision stopped
        return None

    def operator(self, reason):
        """An operator command is about to be sent: stand the automation down
        immediately (the flag stops any further automation command)."""
        self.operator_paused = True
        self._requests.append(("stand_down", reason))

    def operator_start(self):
        """Start/Resume pressed: the automation may act again. If the camera
        link is down right now, the operator has chosen to carry on without
        it: no new camera-lost hold or slow-down until the link comes back."""
        self.operator_paused = False
        alive = self.link_seen and time.time() - self.obs_at < self.cfg["vision_timeout_s"]
        if self.lost_action or (self.link_seen and not alive):
            self.lost_ack = True
        self.lost_action = None

    def after_start(self):
        """Called after a successful Start: ArduRover resets the cruise speed
        whenever it enters AUTO, so send the mission's speed again."""
        s = self.link.snapshot()
        if s["armed"] and s["flight_mode"] == "AUTO":
            self._cmd("Mission speed", self.link.set_speed, self._plan_speed())

    def new_plan(self):
        self.hm_skip.clear()
        self.stats = {"attempts": 0, "collected": 0, "missed": 0, "aborted": 0}

    # ------------------------------------------------------------------ inputs from the app
    def observe(self, payload):
        now = time.time()
        with self._obs_lock:
            self.obs = payload
            self.obs_at = now
            self.link_seen = True
        photo = payload.get("hazard_photo")
        if photo:
            self.last_hazard_photo = (photo, now)
            sid = self.wl.get("sighting")
            if sid:
                self.sightings.update(sid, photo)
        out = {"phase": self.owner(), "homing": self.hm["state"], "wildlife": self.wl["state"]}
        if self.hm.get("source") == "live" and self.hm["state"] not in ("idle", "resuming") and self.hm["wid"]:
            # The app compares its boxes with the drone's crop of this find (and sends `match`).
            out["homing_id"] = self.hm["wid"]
            out["homing_class"] = (self.hm.get("ref") or {}).get("object_class")
        return out

    def add_catch(self, label, score=None, frame_time=None, photo=None, source="camera"):
        pose = self.link.pose_at(frame_time) if frame_time else None
        if pose is None:
            s = self.link.snapshot()
            pose = (s["lat"], s["lng"], s["heading"])
        item = self.catch.add({
            "t": round(time.time(), 1), "label": str(label or "item")[:40],
            "score": None if score is None else round(float(score), 3),
            "lat": pose[0], "lng": pose[1], "source": source,
        }, photo, prefix="c")
        self.bin_count += 1
        self._save_state()
        self._roll_day()
        for c in (self.c_today, self.c_all, self.c_since):
            c[item["label"]] += 1
        self.last_catch_t = time.time()
        cap = self.cfg["bin_capacity_items"]
        if self.bin_count == int(cap * 0.9):
            self._event(f"Bin 90% full ({self.bin_count} of {cap} items)", "warn")
        elif self.bin_count == cap:
            self._event("Bin full — bring the boat home to empty it", "warn")
        return item

    def empty_bin(self):
        n = self.bin_count
        self.bin_count = 0
        self.bin_emptied_at = round(time.time(), 1)
        self.c_since = Counter()
        self._save_state()
        self._event(f"Bin emptied ({n} items)")
        return n

    def wildlife_action(self, action):
        if self.wl["state"] == "clear":
            raise LinkError("The boat isn't paused for wildlife.")
        if action not in ("wait", "resume", "skip"):
            raise LinkError("Choose wait, resume or skip.")
        self._requests.append(("wildlife", action))
        return {"wait": "Waiting for the animal to move.", "resume": "Resuming now.",
                "skip": "Skipping this item and moving on."}[action]

    def request_measure(self, reason="operator"):
        if self.ms is not None:
            raise LinkError("A water measurement is already running.")
        if not self.turbidity.fresh():
            raise LinkError(self.turbidity.summary()["error"] or "The turbidity sensor isn't reading.")
        self._requests.append(("measure", reason))
        return f"Measuring the water here for {self.cfg['measure_s']:g} s."

    # ------------------------------------------------------------------ the decision loop
    def _tick(self):
        now = time.time()
        s = self.link.snapshot()
        alive = self.link_seen and now - self.obs_at < self.cfg["vision_timeout_s"]
        self._handle_requests(now, s)
        if self.operator_paused:
            self._stand_down_state(now)
        if not s["fc_connected"]:
            return
        # A fresh snapshot for every step: a step may have just changed the mode
        # (e.g. wildlife resuming GUIDED), and the next must not act on the old one.
        self._wildlife(now, s, alive)
        s = self.link.snapshot()
        self._measure(now, s)
        s = self.link.snapshot()
        self._measure_at_first(now, s)
        s = self.link.snapshot()
        self._homing(now, s, alive)
        s = self.link.snapshot()
        self._watchdog(now, s, alive)

    def _cmd(self, what, fn, *args):
        """Send one automation command; refused while the operator is in charge."""
        if self.operator_paused:
            return False
        try:
            fn(*args)
            return True
        except LinkError as exc:
            self._event(f"{what} failed: {exc}", "warn")
            return False

    def _plan_speed(self):
        if self.live is not None and self.live.state in ("running", "returning"):
            return self.live._speed()
        flags = self.missions.plan_flags() or {}
        return flags.get("speed_mps") or self.cfg["default_speed_mps"]

    def _resume_mode(self, what, mode):
        """Switch the Pixhawk back to `mode` and send the right speed AFTER it:
        ArduRover resets the cruise speed whenever it enters AUTO or GUIDED."""
        if not self._cmd(what, self.link.set_mode, mode):
            return False
        if mode == "GUIDED" and self.hm["state"] != "idle":
            speed = self.cfg["homing_speed_mps"]
        elif self.lost_action == "slow":
            speed = self.cfg["vision_lost_speed_mps"]
        else:
            speed = self._plan_speed()
        self._cmd("Set speed", self.link.set_speed, speed)
        return True

    def _shift_homing(self, paused_s, now):
        """A hold doesn't count against homing's timers."""
        h = self.hm
        if h["state"] in ("idle", "resuming") or paused_s <= 0:
            return
        h["t_state"] += paused_s
        h["capture_t"] += paused_s if h["capture_t"] else 0.0
        h["t_seen"] = now
        h["last_goto"] = 0.0                  # re-send the homing target straight away

    def _handle_requests(self, now, s):
        while self._requests:
            kind, arg = self._requests.popleft()
            if kind == "stand_down":
                self._stand_down_state(now)
                self._event(f"Camera automation paused: {arg}")
            elif kind == "wildlife":
                self._wildlife_request(now, s, arg)
            elif kind == "measure":
                self._start_measure(now, s, arg)

    def _stand_down_state(self, now):
        """Forget everything in progress without sending commands (the operator has the boat)."""
        if self.wl["state"] != "clear":
            self.wl["paused_s"] += now - (self.wl["since"] or now)
            self.wl.update(state="clear", since=None, clear_since=None, prev_mode=None, sighting=None)
        if self.hm["state"] != "idle":
            if self.hm["wid"]:
                self.hm_skip.add(self.hm["wid"])
            self.hm = self._idle_homing()
        if self.ms is not None and self.ms.get("changed"):
            self.ms["changed"] = False       # finish the reading, but don't move the boat afterwards

    # ------------------------------------------------------------------ wildlife
    def _hazards(self, now):
        with self._obs_lock:
            obs, at = self.obs, self.obs_at
        if not obs or now - at > OBS_FRESH_S:
            return []
        return [h for h in obs.get("hazards") or [] if h.get("in_zone")]

    def _wildlife(self, now, s, alive):
        w = self.wl
        day = _today(now)
        if w["day"] != day:
            w.update(day=day, pauses=0, paused_s=0.0)
        hazards = self._hazards(now) if alive else []
        if w["state"] == "clear":
            if now < w["suppress_until"]:
                # The operator overrode a hold: ignore the zone until it has been clear for 2 s.
                if hazards:
                    w["suppress_clear"] = None
                else:
                    w["suppress_clear"] = w["suppress_clear"] or now
                    if now - w["suppress_clear"] >= 2.0:
                        w["suppress_until"] = 0.0
                return
            if not (self.cfg["wildlife_enabled"] and hazards and not self.operator_paused):
                return
            if not (s["armed"] and s["flight_mode"] in ("AUTO", "GUIDED")):
                return
            self._hold_for_wildlife(now, s, hazards, s["flight_mode"])
            return
        # Paused (or alerting): the Pixhawk must still be in HOLD — anything else
        # means the operator or a failsafe took over.
        if s["flight_mode"] != "HOLD" or not s["armed"]:
            self._end_wildlife(now, "the boat was taken out of HOLD")
            return
        if not alive:
            w["clear_since"] = None          # can't see — stay put
        elif hazards:
            w["clear_since"] = None
            w["label"] = str(max(hazards, key=lambda h: h.get("score") or 0).get("label") or w["label"])
        else:
            w["clear_since"] = w["clear_since"] or now
            if now - w["clear_since"] >= self.cfg["wildlife_clear_s"]:
                self._resume_after_wildlife(now)
                return
        if w["state"] == "paused" and now - w["since"] >= self.cfg["wildlife_alert_s"]:
            w["state"] = "alert"
            self._event(f"Still blocked by wildlife ({w['label']}) — waiting for the operator", "warn")

    def _hold_for_wildlife(self, now, s, hazards, prev, already_holding=False):
        """Take the boat for a wildlife hold. The state is set BEFORE the HOLD
        command, so the mission never reads as paused/finished in between
        (a finished mission would disarm the boat on the water)."""
        w = self.wl
        top = max(hazards, key=lambda h: h.get("score") or 0)
        label = str(top.get("label") or "animal")
        w.update(state="paused", since=now, clear_since=None, prev_mode=prev, label=label, sighting=None)
        if not already_holding and not self._cmd("Wildlife hold", self.link.set_mode, "HOLD"):
            w.update(state="clear", since=None, prev_mode=None, label=None)
            return False
        photo, at = self.last_hazard_photo
        item = self.sightings.add({"t": round(now, 1), "label": label, "score": top.get("score"),
                                   "lat": s["lat"], "lng": s["lng"]}, photo if now - at < 10 else None, prefix="w")
        w["sighting"] = item["id"]
        w["pauses"] += 1
        self._event(f"Paused for wildlife: {label} ahead")
        return True

    def _resume_after_wildlife(self, now):
        prev = self.wl["prev_mode"] or "AUTO"
        paused = now - (self.wl["since"] or now)
        if self._resume_mode("Resume after wildlife", prev):
            if prev == "GUIDED":
                self._shift_homing(paused, now)
            self._end_wildlife(now, None)
            self._event("Wildlife gone — carrying on")
            return True
        return False

    def _end_wildlife(self, now, why):
        w = self.wl
        w["paused_s"] += now - (w["since"] or now)
        w.update(state="clear", since=None, clear_since=None, prev_mode=None, sighting=None)
        if why:
            self._event(f"Wildlife pause ended: {why}")

    def _wildlife_request(self, now, s, action):
        w = self.wl
        if w["state"] == "clear":
            return
        if action == "wait":
            w.update(state="paused", since=now, clear_since=None)
        elif action == "resume":
            if self._resume_after_wildlife(now):
                w.update(suppress_until=now + 60.0, suppress_clear=None)   # the operator's call wins
        elif action == "skip":
            w.update(suppress_until=now + 60.0, suppress_clear=None)
            if self.hm["state"] != "idle":
                self._end_wildlife(now, None)
                self._finish_homing(now, False, "skipped by the operator (wildlife)")
            elif self.live is not None and self.live.state == "running":
                if self.live.current:
                    try:
                        self.live.skip(self.live.current)
                    except LinkError:
                        pass
                self._resume_mode("Resume", "GUIDED")
                self._end_wildlife(now, None)
                self._event("Skipped this item because of wildlife")
            else:
                wp = self.missions.waypoint_at(s["mission_seq"])
                if wp:
                    self.missions.mark_item(wp[0], False, how="skipped")
                seq = s["mission_seq"]
                if seq is not None:
                    self._cmd("Skip item", self.link.set_current_item, seq + 1)
                self._resume_mode("Resume", "AUTO")
                self._end_wildlife(now, None)
                self._event("Skipped this item because of wildlife")

    # ------------------------------------------------------------------ water measurement
    def _start_measure(self, now, s, reason):
        if self.ms is not None:
            return
        change = (not self.operator_paused and s["armed"] and s["flight_mode"] in ("AUTO", "GUIDED")
                  and self.wl["state"] == "clear")
        prev = s["flight_mode"]
        self.ms = {"until": now + self.cfg["measure_s"], "started": now, "prev": prev, "changed": change,
                   "ntu": [], "v": [], "reason": reason, "last_t": 0.0}
        if change and not self._cmd("Hold for water test", self.link.set_mode, "HOLD"):
            self.ms["changed"] = False       # sample anyway, without holding the boat
        self._event(f"Measuring water turbidity ({reason})")

    def _measure(self, now, s):
        m = self.ms
        if m is None:
            return
        if m["changed"] and s["flight_mode"] != "HOLD" and self.wl["state"] == "clear":
            m["changed"] = False             # someone moved the boat: keep sampling, don't resume later
        t = self.turbidity
        if t.fresh() and t.updated != m["last_t"]:
            m["last_t"] = t.updated
            m["ntu"].append(t.ntu)
            m["v"].append(t.volts)
        if now < m["until"]:
            return
        if m["ntu"]:
            self.last_reading = t.add_reading(m["ntu"], m["v"], m["reason"])
            self._event(f"Water: {self.last_reading['ntu']:g} NTU ({self.last_reading['quality']})")
        else:
            self._event("Water measurement failed: no readings from the sensor", "warn")
        if m["changed"] and self.wl["state"] == "clear":
            hazards = self._hazards(now) if self.cfg["wildlife_enabled"] else []
            if hazards:
                # An animal is in the way right now: stay held, as a wildlife pause.
                self._hold_for_wildlife(now, s, hazards, m["prev"], already_holding=True)
            elif self._resume_mode("Resume after water test", m["prev"]) and m["prev"] == "GUIDED":
                self._shift_homing(now - m["started"], now)
        self.ms = None                        # released only now: the mission never reads as paused in between

    def _measure_at_first(self, now, s):
        flags = self.missions.plan_flags()
        if not flags or not flags["measure_at_first"] or flags["measured"] or flags["reached"] < 1:
            return
        if flags["state"] not in ("running", "returning") or self.ms is not None or self.hm["state"] != "idle":
            return
        self.missions.set_measured()
        if self.turbidity.fresh():
            self._start_measure(now, s, "first collection point")
        else:
            self._event("Skipped the water test at the first point: sensor not reading", "warn")

    # ------------------------------------------------------------------ homing
    @staticmethod
    def _idle_homing():
        return {"state": "idle", "wid": None, "seq": None, "wp": None, "target": None, "t_state": 0.0,
                "t_seen": 0.0, "capture_t": 0.0, "drive": None, "dist": None, "last_goto": 0.0, "reason": None,
                "item": None,
                # drone-to-boat workflow (live collect)
                "ref": None, "ref_sig": None, "match": None, "best_rejected": None, "t_match_log": 0.0,
                "retries": 0, "spot": None, "verify": None, "v_t": 0.0, "view": None, "gps_bad": None,
                "approaching": False, "sweep_goal": None, "sweep_i": 0, "sweep_h0": 0.0, "sweep_t": 0.0}

    def _targets(self, now):
        """Plastic in the latest observation: dicts with the water position
        (lat, lng), the detector's label and score, and — homing onto a drone
        target — `match`, how well it matches the drone's item (None: not judged)."""
        with self._obs_lock:
            obs, at = self.obs, self.obs_at
        if not obs or now - at > OBS_FRESH_S:
            return []
        ft = obs.get("frame_time")
        pose = self.link.pose_at(ft) if ft else None
        if pose is None:
            return []
        w, h = obs.get("frame_w") or self.cfg["camera_width"], obs.get("frame_h") or self.cfg["camera_height"]
        cam = CameraModel.from_cfg(self.cfg, w, h)
        ramp_y = self.cfg["ramp_top"] * h
        out = []
        # The app matched its boxes against the drone's crop of the find being homed onto:
        # use its scores (otherwise the Pi compares them itself, below).
        live = self.hm.get("source") == "live" and self.hm["state"] != "idle"
        app_match = live and obs.get("match_for") == self.hm["wid"]
        if live and obs.get("matcher") and not app_match and now - self.hm.get("t_start", 0) < APP_MATCH_WAIT_S:
            return []                        # the app matches, but hasn't scored for this find yet
        for b in obs.get("targets") or []:
            try:
                x = (float(b["x1"]) + float(b["x2"])) / 2
                y = float(b["y2"])           # where the item meets the water
            except (KeyError, TypeError, ValueError):
                continue
            if (float(b["y1"]) + float(b["y2"])) / 2 > ramp_y:
                continue                     # already on the ramp
            g = cam.pixel_to_ground(x, min(y, ramp_y))
            if g is None or g[0] > 25:
                continue
            lat, lng = to_world(pose[0], pose[1], pose[2], g[0], g[1])
            c = {"lat": lat, "lng": lng, "score": b.get("score") or 0, "label": b.get("label"),
                 "box": b, "match": None, "parts": None}
            if app_match and isinstance(b.get("match"), (int, float)):
                c["match"] = max(0.0, min(1.0, float(b["match"])))
                c["parts"] = {str(obs.get("matcher") or "app"): round(c["match"], 3)}
            out.append(c)
        if self.hm.get("ref") is not None and out and not (app_match and all(c["parts"] for c in out)):
            self._score(ft, out, w, h)
        return out

    def _score(self, ft, cands, w, h):
        """Compare each candidate with the drone's item (once per observed frame)."""
        if self._scored[0] == ft and len(self._scored[1]) == len(cands):
            for c, prev in zip(cands, self._scored[1]):
                c["match"], c["parts"] = prev
            return
        ref = self.hm["ref"]
        frame_img = None
        need_frame = target_match.Image is not None and self.hm["ref_sig"] is not None \
            and any(not c["box"].get("crop") for c in cands)
        if need_frame and self.camera is not None and hasattr(self.camera, "frame_near"):
            # Decode at a quarter size straight from the JPEG: cheap on a Pi Zero.
            frame_img = target_match.open_image(self.camera.frame_near(ft), reduce_to=(w // 4, h // 4))
        for c in cands:
            if c["parts"]:
                continue                     # already scored by the app
            sig = None
            if self.hm["ref_sig"] is not None:
                crop = c["box"].get("crop")
                img = target_match.open_image(target_match.decode_b64(crop)) if crop \
                    else target_match.crop_box(frame_img, c["box"], w, h)
                sig = self.matcher.signature(img)
            if self.hm["ref_sig"] is None and target_match.kind(ref.get("object_class")) is None:
                continue                     # nothing to judge by: position only (as before)
            c["match"], c["parts"] = self.matcher.score(self.hm["ref_sig"], ref.get("object_class"), sig,
                                                        c["label"], c["score"])
        self._scored = (ft, [(c["match"], c["parts"]) for c in cands])

    def _matching(self, cands):
        thr = self.cfg["match_threshold"]
        return [c for c in cands if c["match"] is None or c["match"] >= thr]

    def _live_state(self, state, note=None, **fields):
        if self.hm.get("source") == "live" and self.live is not None and self.hm["wid"]:
            self.live.target_state(self.hm["wid"], state, note, **fields)

    def _homing(self, now, s, alive):
        h = self.hm
        if self.wl["state"] != "clear" or (self.ms is not None and self.ms.get("changed")):
            return                           # a higher priority holds the boat
        if h["state"] == "idle":
            self._maybe_start_homing(now, s, alive)
            return
        if h["state"] == "resuming":
            return
        if not s["armed"] or s["flight_mode"] != "GUIDED":
            self._event(f"Homing stopped: the boat left GUIDED ({s['flight_mode']})")
            if h["wid"]:
                self.hm_skip.add(h["wid"])
            if h.get("source") == "live" and self.live is not None:
                self.live.homing_aborted(h["wid"], f"the boat left GUIDED ({s['flight_mode']})")
            self.hm = self._idle_homing()
            return
        if not alive:
            self._abort_homing("the camera link was lost")
            return
        gps_ok = s["lat"] is not None and (s.get("gps_fix") or 0) >= 3
        if not gps_ok:
            h["gps_bad"] = h["gps_bad"] or now
            if now - h["gps_bad"] >= self.cfg["gps_lost_hold_s"]:
                self._abort_homing("the GPS fix was lost")
            return                           # never steer on a bad position
        h["gps_bad"] = None
        boat = (s["lat"], s["lng"])
        live = h.get("source") == "live"
        targets = self._targets(now)
        if h["state"] == "search":
            near = [t for t in targets if dist_m(t["lat"], t["lng"], *h["wp"]) <= self.cfg["homing_accept_m"]]
            good = self._matching(near)
            if good:
                # The best match; equally good ones (or none judged): the closest to the point.
                best = min(good, key=lambda t: (-(t["match"] or 0), dist_m(t["lat"], t["lng"], *h["wp"])))
                h.update(state="track", target=(best["lat"], best["lng"]), t_seen=now, match=best["match"],
                         approaching=False)
                self._goto(now, h["target"])
                if best["match"] is not None:
                    self._event(f"Homing: the drone's item is in sight (match {best['match']:.2f})")
                    self._live_state("MATCHED", f"match {best['match']:.2f} {best['parts']}",
                                     match_score=best["match"])
                else:
                    self._event("Homing: plastic in sight")
                    self._live_state("MATCHED", "plastic in sight (no reference to compare)")
            elif now - h["t_state"] > self.cfg["homing_search_s"]:
                seen = h["best_rejected"]
                self._finish_homing(now, False, "not seen by the camera" if seen is None else
                                    f"only other items seen (best match {seen:.2f})", state="NOT_FOUND")
            else:
                self._search_move(now, s, boat)
            if near and not good:
                best_bad = max(t["match"] for t in near)
                h["best_rejected"] = max(h["best_rejected"] or 0, best_bad)
                if now - h["t_match_log"] > MATCH_LOG_S:
                    h["t_match_log"] = now
                    self._event(f"Homing: {len(near)} item(s) seen, not the drone's (best match {best_bad:.2f})")
            h["dist"] = dist_m(*boat, *h["wp"])
            return
        if h["state"] == "track":
            good = self._matching(targets)
            if good:
                best = min(good, key=lambda t: dist_m(t["lat"], t["lng"], *h["target"]))
                if dist_m(best["lat"], best["lng"], *h["target"]) <= 2.5:
                    a = 0.5                  # smooth the jitter of single detections
                    h["target"] = (h["target"][0] + a * (best["lat"] - h["target"][0]),
                                   h["target"][1] + a * (best["lng"] - h["target"][1]))
                    h["t_seen"] = now
            if now - h["t_seen"] > self.cfg["homing_lost_s"]:
                h.update(state="search", t_state=now - self.cfg["homing_search_s"] / 2, sweep_goal=None,
                         wp=h["target"] if live else h["wp"])
                self._event("Homing: lost sight of the item, searching again")
                self._live_state("SEARCHING", "lost sight of it")
                return
            if not h["approaching"]:
                h["approaching"] = True
                self._live_state("APPROACHING", "steering onto it with the camera")
            d = dist_m(*boat, *h["target"])
            h["dist"] = d
            if d <= self.cfg["homing_capture_m"]:
                fwd, right = to_boat(s["lat"], s["lng"], s["heading"] or 0, *h["target"])
                scale = (d + self.cfg["homing_drive_through_m"]) / max(d, 0.05)
                drive = to_world(s["lat"], s["lng"], s["heading"] or 0, fwd * scale, right * scale)
                h.update(state="capture", drive=drive, capture_t=now, spot=h["target"])
                self._goto(now, drive)
                self._event("Homing: driving through the item")
                self._live_state("COLLECTING", "driving through it, roller on")
            elif now - h["last_goto"] > 0.25:
                self._goto(now, h["target"])
            return
        if h["state"] == "capture":
            h["dist"] = dist_m(*boat, *h["drive"])
            if h["dist"] < 0.6 or now - h["capture_t"] > 8.0:
                h.update(state="confirm", t_state=now, verify="watch", v_t=now)
                self._goto(now, boat)        # stop here while the counter checks the ramp
                self._live_state("VERIFYING", "watching the ramp")
            return
        if h["state"] == "confirm":
            if self.last_catch_t >= h["capture_t"] - 1.0:
                self._finish_homing(now, True, "collected", state="COLLECTED", verified=True,
                                    note="counted on the ramp")
            elif not live:
                if now - h["t_state"] > self.cfg["homing_confirm_s"]:
                    self._finish_homing(now, False, "nothing came up the ramp")
            else:
                self._verify(now, s, boat, targets)

    def _search_move(self, now, s, boat):
        """Search: go to the point; nothing matching there yet → sweep: out to a
        point SWEEP_R_M away and back through the middle, a quarter turn further
        each time, so the forward camera looks all around the point."""
        h = self.hm
        goal = h["sweep_goal"]
        if goal is None and dist_m(*boat, *h["wp"]) > 1.5:
            if now - h["last_goto"] > 2.0:
                self._goto(now, h["wp"])
            return
        if goal is None:
            h.update(sweep_i=0, sweep_h0=s["heading"] or 0)
        if goal is None or dist_m(*boat, *goal) < 1.0 or now - h["sweep_t"] > SWEEP_LEG_S:
            i = h["sweep_i"]
            h["sweep_i"] += 1
            if i % 2 == 0:
                ang = math.radians(h["sweep_h0"] + 90 + 90 * (i // 2))
                goal = offset(h["wp"][0], h["wp"][1], SWEEP_R_M * math.cos(ang), SWEEP_R_M * math.sin(ang))
            else:
                goal = h["wp"]
            h.update(sweep_goal=goal, sweep_t=now)
            self._goto(now, goal)
        elif now - h["last_goto"] > 2.0:
            self._goto(now, goal)

    # ------------------------------------------------------------------ verification (live collect)
    def _verify(self, now, s, boat, targets):
        """After driving through: is the item gone? Watch the ramp; then, with
        verify_lookback, drive a little on, turn to face the spot and look."""
        h = self.hm
        spot = h["spot"] or h["target"]
        still = [t for t in self._matching(targets)
                 if dist_m(t["lat"], t["lng"], *spot) <= STILL_THERE_M]
        if still and h["verify"] in ("watch", "look", "turn"):
            best = min(still, key=lambda t: dist_m(t["lat"], t["lng"], *spot))
            self._retry(now, (best["lat"], best["lng"]), "it is still on the water")
            return
        if now - h["t_state"] > self.cfg["verify_time_s"]:
            self._finish_homing(now, True, "collected", state="COLLECTED", verified=False,
                                note="verification timed out; not seen again")
            return
        v = h["verify"]
        if v == "watch":
            if now - h["v_t"] < self.cfg["homing_confirm_s"]:
                return
            if not self.cfg["verify_lookback"]:
                self._retry(now, spot, "nothing came up the ramp")
                return
            hdg = s["heading"] or 0
            h["view"] = to_world(spot[0], spot[1], hdg, self.cfg["verify_view_m"], 0)
            h.update(verify="reposition", v_t=now)
            self._goto(now, h["view"])
            self._event("Verify: nothing on the ramp - turning back to look at the spot")
            self._live_state("VERIFYING", "nothing on the ramp: turning back to look")
        elif v == "reposition":
            if dist_m(*boat, *h["view"]) < 1.0 or now - h["v_t"] > 15.0:
                h.update(verify="turn", v_t=now)
                self._goto(now, spot)
            elif now - h["last_goto"] > 2.0:
                self._goto(now, h["view"])
        elif v == "turn":
            fwd, right = to_boat(s["lat"], s["lng"], s["heading"] or 0, *spot)
            facing = fwd > 0 and abs(math.degrees(math.atan2(right, fwd))) <= LOOK_HEADING_DEG
            if facing and not self._in_view(fwd, right) and h.get("v_backoffs", 0) < 2:
                # Facing it, but so close the spot is hidden under the ramp: back off and turn again.
                h["v_backoffs"] = h.get("v_backoffs", 0) + 1
                away = to_world(spot[0], spot[1], (s["heading"] or 0) + 180, self.cfg["verify_view_m"], 0)
                h.update(verify="reposition", v_t=now, view=away)
                self._goto(now, away)
            elif facing or now - h["v_t"] > 15.0:
                h.update(verify="look", v_t=now, look_k=0, look_stop=None)
                self._goto(now, boat)        # stop, facing the spot
            elif now - h["last_goto"] > 1.0:
                self._goto(now, spot)
        elif v == "look":
            # Watch the spot straight on, then panned left and right of it (the
            # item may have been pushed aside, out of a straight-on view).
            third = self.cfg["verify_look_s"] / 3.0
            k = min(2, int((now - h["v_t"]) / third))
            if k != h.get("look_k"):
                h["look_k"] = k
                side = 1 if k == 1 else -1
                aim = to_world(spot[0], spot[1], (s["heading"] or 0) + 90 * side, LOOK_PAN_M, 0)
                self._goto(now, aim)         # turn towards a point beside the spot...
                h["look_stop"] = now + LOOK_TURN_S
            elif h.get("look_stop") and now >= h["look_stop"]:
                h["look_stop"] = None
                self._goto(now, boat)        # ...and stop there to watch
            if now - h["v_t"] >= self.cfg["verify_look_s"]:
                fwd, right = to_boat(s["lat"], s["lng"], s["heading"] or 0, *spot)
                self._finish_homing(now, True, "collected", state="COLLECTED", verified=True,
                                    note=f"gone from the spot (looked back from {math.hypot(fwd, right):.1f} m, "
                                         f"{math.degrees(math.atan2(right, fwd)):+.0f} deg)")

    def _in_view(self, fwd, right):
        """Is a water point (metres ahead / right of the boat) in the camera's picture, above the ramp?"""
        w, h = self.cfg["camera_width"], self.cfg["camera_height"]
        if fwd <= 0.2:
            return False
        p = CameraModel.from_cfg(self.cfg, w, h).ground_to_pixel(fwd, right)
        return bool(p) and 0 <= p[0] <= w and 0 <= p[1] <= self.cfg["ramp_top"] * h * 0.9

    def _retry(self, now, where, why):
        """The pick-up failed: search again from where it was seen, or give up."""
        h = self.hm
        h["retries"] += 1
        n, most = h["retries"], int(self.cfg["collect_max_retries"])
        if n > most:
            self._finish_homing(now, False, f"{why}; tried {n} times", state="RETRY_REQUIRED",
                                lat=where[0], lng=where[1])
            return
        self._event(f"Verify: {why} - retry {n} of {most}", "warn")
        # The target's position becomes where the camera last saw it.
        self._live_state("SEARCHING", f"{why}: retry {n} of {most}", retry_count=n, lat=where[0], lng=where[1])
        h.update(state="search", wp=where, t_state=now, verify=None, spot=None, match=None,
                 best_rejected=None, last_goto=0.0, approaching=False, sweep_goal=None, v_backoffs=0)
        self._goto(now, where)

    def _maybe_start_homing(self, now, s, alive):
        if self.live is not None and self.live.state == "running":
            self._maybe_start_live_homing(now, s, alive)
            return
        flags = self.missions.plan_flags()
        if not (self.cfg["homing_enabled"] and flags and flags["homing"]) or self.operator_paused or not alive:
            return
        if not s["armed"] or s["flight_mode"] != "AUTO" or s["lat"] is None:
            return
        wp = self.missions.waypoint_at(s["mission_seq"])
        if not wp:
            return
        wid, lat, lng = wp
        if wid in self.hm_skip or self.missions.item_done(wid):
            return
        if dist_m(s["lat"], s["lng"], lat, lng) > self.cfg["homing_start_m"]:
            return
        self.hm_skip.add(wid)                # one homing attempt per item
        item = self._item_number(wid)
        # Own the boat first, then switch (the mission must never read as paused in between).
        self.hm = {**self._idle_homing(), "state": "search", "wid": wid, "seq": s["mission_seq"],
                   "wp": (lat, lng), "t_state": now, "item": item}
        if not self._cmd("Homing: switch to GUIDED", self.link.set_mode, "GUIDED"):
            self.hm = self._idle_homing()
            self._cmd("Back to AUTO", self.link.set_mode, "AUTO")
            return
        self._cmd("Homing: slow down", self.link.set_speed, self.cfg["homing_speed_mps"])
        self._goto(now, (lat, lng))
        self.stats["attempts"] += 1
        self._event(f"Homing: taking over for item {item}")

    def _maybe_start_live_homing(self, now, s, alive):
        """Live collect: the boat is already in GUIDED, heading to the item; take
        over for the last metres when it is close and the camera is watching."""
        if not self.cfg["homing_enabled"] or self.operator_paused or not alive:
            return
        if not s["armed"] or s["flight_mode"] != "GUIDED" or s["lat"] is None:
            return
        wp = self.live.wants_homing(s)
        if not wp:
            return
        wid, lat, lng = wp
        item = self.live.item_number(wid)
        want = target_match.MATCHERS.get(str(self.cfg.get("match_method") or "colour").lower(),
                                         target_match.ColourMatcher)
        if type(self.matcher) is not want:
            self.matcher = want()            # match_method was changed
        ref = self.live.target_info(wid) or {"id": wid}
        ref_sig = None
        if ref.get("reference_path"):
            try:
                with open(ref["reference_path"], "rb") as f:
                    ref_sig = self.matcher.signature(target_match.open_image(f.read()))
            except OSError:
                ref_sig = None
        self.hm = {**self._idle_homing(), "state": "search", "wid": wid, "seq": None, "source": "live",
                   "wp": (lat, lng), "t_state": now, "t_start": now, "item": item, "ref": ref, "ref_sig": ref_sig,
                   "retries": int(ref.get("retry_count") or 0)}
        self._scored = (None, [])
        self._cmd("Homing: slow down", self.link.set_speed, self.cfg["homing_speed_mps"])
        self._goto(now, (lat, lng))
        self.stats["attempts"] += 1
        how = ("comparing with the drone's image" if ref_sig is not None else
               f"looking for a {ref['object_class']}" if ref.get("object_class") else "no reference image")
        self._event(f"Homing: taking over for item {item} ({how})")
        self._live_state("SEARCHING", f"within {self.cfg['homing_start_m']:g} m: camera search, {how}")

    def _goto(self, now, point):
        self.hm["last_goto"] = now
        self._cmd("Homing target", self.link.goto, point[0], point[1])

    def _finish_homing(self, now, collected, reason, state=None, verified=None, note=None, **fields):
        h = self.hm
        wid, seq = h["wid"], h["seq"]
        if h.get("source") == "live":
            self.stats["collected" if collected else "missed"] += 1
            self._event(f"Homing: item {h.get('item')} {state or ('collected' if collected else 'missed')}"
                        f" - {note or reason}", "info" if collected else "warn")
            self.hm["state"] = "resuming"
            self._cmd("Live collect speed", self.link.set_speed, self._plan_speed())
            self.live.homing_finished(wid, collected, "camera", state=state, verified=verified,
                                      note=note or reason, retry_count=h.get("retries", 0), **fields)
            self.hm = self._idle_homing()
            return
        self.missions.mark_item(wid, collected, how="camera" if collected else "missed")
        self.stats["collected" if collected else "missed"] += 1
        self._event(f"Homing: item {self._item_number(wid)} {'collected' if collected else 'missed'} — {reason}",
                    "info" if collected else "warn")
        # Still "homing" while handing back, so the mission never reads as paused in between.
        self.hm["state"] = "resuming"
        if seq is not None:
            self._cmd("Next item", self.link.set_current_item, seq + 1)
        self._resume_mode("Back to the mission", "AUTO")
        self.hm = self._idle_homing()

    def _abort_homing(self, reason):
        self._event(f"Homing stopped: {reason} — continuing by GPS", "warn")
        self.stats["aborted"] = self.stats.get("aborted", 0) + 1
        if self.hm.get("source") == "live":
            wid = self.hm["wid"]
            self.hm["state"] = "resuming"
            self._cmd("Live collect speed", self.link.set_speed, self._plan_speed())
            self.live.homing_aborted(wid, reason)
            self.hm = self._idle_homing()
            return
        self.hm["state"] = "resuming"
        self._resume_mode("Back to the mission", "AUTO")
        self.hm = self._idle_homing()

    def _item_number(self, wid):
        if self.hm.get("source") == "live" and self.live is not None:
            return self.live.item_number(wid)
        st = self.missions.status()
        for i, w in enumerate(st.get("waypoints") or [], 1):
            if w["id"] == wid:
                return i
        return "?"

    # ------------------------------------------------------------------ vision link watchdog
    def _watchdog(self, now, s, alive):
        if not self.link_seen:
            return                           # no camera/AI in use on this run: nothing to fall back from
        if alive:
            self.lost_ack = False
            if self.lost_action:
                action, self.lost_action = self.lost_action, None
                if action == "slow" and s["flight_mode"] == "AUTO":
                    self._cmd("Restore mission speed", self.link.set_speed, self._plan_speed())
                elif action == "hold" and s["flight_mode"] == "HOLD" and s["armed"]:
                    self.lost_action = "hold"          # still the owner while switching back
                    self._resume_mode("Resume (camera back)", "AUTO")
                    self.lost_action = None
                self._event("Camera link back")
            return
        if self.lost_action or self.operator_paused or self.lost_ack:
            return
        if not (self.cfg["wildlife_enabled"] or self.cfg["homing_enabled"]):
            return
        flags = self.missions.plan_flags()
        if not flags or flags["state"] not in ("running", "returning") or not s["armed"] or s["flight_mode"] != "AUTO":
            return
        action = self.cfg["on_vision_lost"]
        self.lost_action = action
        if action == "slow":
            self._cmd("Slow down", self.link.set_speed, self.cfg["vision_lost_speed_mps"])
            self._event(f"Camera link lost — slowed to {self.cfg['vision_lost_speed_mps']:g} m/s", "warn")
        elif action == "hold":
            if self._cmd("Hold", self.link.set_mode, "HOLD"):
                self._event("Camera link lost — holding until it's back; press Resume to carry on without the camera", "warn")
            else:
                self.lost_action = None
        else:
            self._event("Camera link lost — carrying on by GPS only", "warn")

    # ------------------------------------------------------------------ views
    def catch_summary(self, limit=0):
        self._roll_day()
        cap = self.cfg["bin_capacity_items"]
        out = {
            "bin": {"count": self.bin_count, "capacity": cap,
                    "pct": round(100 * self.bin_count / cap) if cap else 0,
                    "full": self.bin_count >= cap, "emptied_at": self.bin_emptied_at},
            "today": {"total": sum(self.c_today.values()), "by_label": dict(self.c_today)},
            "since_empty": {"total": sum(self.c_since.values()), "by_label": dict(self.c_since)},
            "all_time": {"total": sum(self.c_all.values()), "by_label": dict(self.c_all)},
        }
        if limit:
            out["items"] = self.catch.recent(limit)
        return out

    def wildlife_summary(self, limit=0):
        w = self.wl
        now = time.time()
        out = {
            "enabled": self.cfg["wildlife_enabled"],
            "state": w["state"], "label": w["label"] if w["state"] != "clear" else None,
            "since": w["since"], "waiting_s": round(now - w["since"], 1) if w["since"] else 0,
            "clear_in_s": (round(max(0.0, self.cfg["wildlife_clear_s"] - (now - w["clear_since"])), 1)
                           if w["clear_since"] else None),
            "pauses_today": w["pauses"],
            "paused_s_today": round(w["paused_s"] + (now - w["since"] if w["since"] else 0), 1),
        }
        if limit:
            out["sightings"] = self.sightings.recent(limit)
        return out

    def homing_summary(self):
        h = self.hm
        return {
            "enabled": self.cfg["homing_enabled"], "state": h["state"],
            "item": h.get("item"), "item_id": h["wid"],
            "distance_m": None if h["dist"] is None else round(h["dist"], 1),
            "target": None if not h["target"] else {"lat": h["target"][0], "lng": h["target"][1]},
            "match": h.get("match"), "match_threshold": self.cfg["match_threshold"],
            "has_reference": h.get("ref_sig") is not None, "retries": h.get("retries", 0),
            "verify": h.get("verify"), "matcher": self.matcher.name,
            **self.stats,
        }

    def summary(self):
        now = time.time()
        m = self.ms
        return {
            "link": {"alive": self.link_seen and now - self.obs_at < self.cfg["vision_timeout_s"],
                     "seen": self.link_seen, "age_s": round(now - self.obs_at, 1) if self.obs_at else None},
            "phase": self.owner(),
            "operator_paused": self.operator_paused,
            "lost_action": self.lost_action,
            "homing": self.homing_summary(),
            "wildlife": self.wildlife_summary(),
            "measure": None if m is None else {"remaining_s": round(max(0.0, m["until"] - now), 1),
                                               "reason": m["reason"], "samples": len(m["ntu"])},
            "catch": {k: v for k, v in self.catch_summary().items() if k in ("bin", "today")},
            "last_reading": self.last_reading,
            "events": list(self.events)[-6:],
        }
