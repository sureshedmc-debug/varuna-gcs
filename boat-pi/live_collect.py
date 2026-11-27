"""
Live collect: the boat goes after plastic as the drone finds it, without a
planned mission.

The VARUNA app sends each plastic position the drone's AI finds (POST
/api/live/targets), while the boat is already out. This module keeps them in a
queue and drives the boat itself, in GUIDED:

  * always to the NEAREST item still to collect (re-chosen after every item,
    so new finds close by are picked up on the way);
  * the intake roller (collector_servo) goes on within live_roller_on_m of an
    item and off when nothing is close any more;
  * the last few metres: the camera homing in vision.py takes over (it steers
    onto the item it actually sees and waits for the catch counter). Without
    the camera, the boat drives through the GPS point and waits live_dwell_s;
  * each item ends collected ("camera": the catch counter saw it come up the
    ramp, "gps": the boat drove through the spot) or missed (the camera never
    saw it, or it took longer than live_target_timeout_s);
  * nothing left: the boat stops and holds where it is, waiting for more —
    or, with when_empty "return", goes home after live_return_after_s.

The operator stays in charge: any mode change, Hold, RTL, stop or disarm from
the app, the controller or a failsafe pauses live collect (nothing more is
commanded until Start). Wildlife holds and water tests in vision.py take
priority and are waited out. Live collect and a planned mission never run at
the same time.

Everything that commands the Pixhawk runs in one thread (`_tick`); the web
handlers only change the queue and the state.

Drone-to-boat visual collection: each target is the drone's detection record
(id, position, object_class, confidence, timestamp and a reference crop of
the item), and carries a workflow `state` next to the queue `status`:

    DETECTED -> SENT -> NAVIGATING -> SEARCHING -> MATCHED -> APPROACHING ->
    COLLECTING -> VERIFYING -> COLLECTED   (or NOT_FOUND / RETRY_REQUIRED)

DETECTED (drone, with its timestamp) and SENT (arrived on the boat) are
recorded when it arrives; NAVIGATING while the boat drives to the GPS point;
the camera states are set by the homing in vision.py, which compares what the
camera sees with the reference crop (target_match.py), verifies the pick-up
and re-tries a failed one up to collect_max_retries times. Every transition
is logged and kept in the target's `history`. `status` (pending / active /
collected / missed) stays as the app's queue view.

GPS lost for gps_lost_hold_s: the boat holds (HOLD) and carries on by itself
once the fix has been back for a few seconds.
"""

import hashlib
import json
import logging
import math
import re
import threading
import time
from collections import deque

import target_match
from mav_link import LinkError, haversine_m

log = logging.getLogger("boat.live")

TICK_S = 0.25
GOTO_EVERY_S = 2.0          # re-send the GUIDED target (in case one was lost)
MODE_GRACE_S = 3.0          # after our own mode change, before the reported mode must match
STATES = ("off", "running", "paused", "returning")
ACTIVE = ("pending", "active")
WORKFLOW = ("DETECTED", "SENT", "NAVIGATING", "SEARCHING", "MATCHED", "APPROACHING", "COLLECTING",
            "VERIFYING", "COLLECTED", "NOT_FOUND", "RETRY_REQUIRED", "SKIPPED")
FINAL = ("COLLECTED", "NOT_FOUND", "RETRY_REQUIRED", "SKIPPED")
GPS_BACK_S = 3.0            # the fix must be back this long before carrying on


def _offset(lat, lng, north_m, east_m):
    dlat = north_m / 6371000.0
    dlng = east_m / (6371000.0 * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lng + math.degrees(dlng)


def _bearing(lat1, lng1, lat2, lng2):
    y = math.sin(math.radians(lng2 - lng1)) * math.cos(math.radians(lat2))
    x = (math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
         - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lng2 - lng1)))
    return math.degrees(math.atan2(y, x)) % 360


class LiveCollect:
    def __init__(self, link, missions, cfg, data_dir):
        self.link = link
        self.missions = missions
        self.cfg = cfg
        self.vision = None                   # set by main.py (camera homing, catch counter)
        self.collector = None                # collector.Collector: the intake roller
        self.on_targets_added = None         # simulator hook: put plastic in the simulated river
        self.path = data_dir / "live_collect.json"
        self._lock = threading.RLock()
        self.state = "off"
        self.reason = None                   # why it is paused / stopped
        self.when_empty = "wait"
        self.targets = {}                    # id → target (insertion-ordered)
        self.current = None
        self.phase = None                    # waiting | approach | camera | through | dwell
        self.events = deque(maxlen=40)
        self.started_at = None
        self.speed = None                    # cruise speed for live collect (None: default_speed_mps)
        self._t_mode = 0.0                   # when we last changed the mode ourselves
        self._t_goto = 0.0
        self._t_target = 0.0
        self._t_phase = 0.0
        self._through = None
        self._empty_since = None
        self._camera_tried = set()           # items the camera homing already had a go at
        self._gps_bad_since = None
        self._gps_ok_since = None
        self.ref_dir = data_dir / "targets"  # the drone's reference crops, one JPEG per target
        self._load()
        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------------ persistence
    def _load(self):
        """The queue survives a Pi restart (live collect itself restarts off)."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for t in data.get("targets", []):
                if t.get("status") == "active":
                    t["status"] = "pending"
                t.setdefault("retry_count", 0)
                t.setdefault("history", [])
                if not t.get("state"):
                    t["state"] = {"collected": "COLLECTED", "missed": "NOT_FOUND"}.get(t.get("status"), "SENT")
                elif t["state"] not in FINAL:
                    t["state"] = "SENT"     # was on its way when the Pi stopped: queued again
                self.targets[t["id"]] = t
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _save(self):
        try:
            keep = list(self.targets.values())[-300:]
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"targets": keep}), encoding="utf-8")
            for attempt in range(3):
                try:
                    tmp.replace(self.path)
                    break
                except PermissionError:         # Windows: a virus scanner briefly holding the file
                    if attempt == 2:
                        raise
                    time.sleep(0.05)
        except OSError as exc:
            log.warning("Could not save the live-collect queue: %s", exc)

    def _event(self, text, level="info"):
        self.events.append({"t": round(time.time(), 1), "text": text, "level": level})
        (log.warning if level == "warn" else log.info)("Live collect: %s", text)

    # ------------------------------------------------------------------ workflow state
    def _set_state(self, t, state, note=None, at=None):
        """Lock held. Move a target to a workflow state; every transition is logged."""
        prev = t.get("state")
        if prev == state and not note:
            return
        t["state"] = state
        h = t.setdefault("history", [])
        h.append({"t": round(at or time.time(), 2), "state": state, **({"note": note} if note else {})})
        del h[:-40]
        log.info("Target %s: %s -> %s%s", t["id"], prev or "-", state, f" ({note})" if note else "")

    def target_state(self, tid, state, note=None, **fields):
        """For vision.py: the camera homing moved a target on (SEARCHING, MATCHED...)."""
        with self._lock:
            t = self.targets.get(tid)
            if t is None or t.get("state") in FINAL:
                return
            t.update(fields)
            self._set_state(t, state, note)

    def target_info(self, tid):
        """What the camera homing needs to recognise a target."""
        with self._lock:
            t = self.targets.get(tid)
            if t is None:
                return None
            p = self.reference_path(tid)
            return {"id": tid, "lat": t["lat"], "lng": t["lng"], "object_class": t.get("object_class"),
                    "confidence": t.get("confidence"), "retry_count": t.get("retry_count", 0),
                    "reference_path": str(p) if p else None}

    # ------------------------------------------------------------------ reference crops
    def _ref_file(self, tid):
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", tid)[:60]
        return self.ref_dir / f"{safe}-{hashlib.md5(tid.encode()).hexdigest()[:8]}.jpg"

    def reference_path(self, tid):
        p = self._ref_file(str(tid))
        return p if p.exists() else None

    def _save_reference(self, tid, data):
        raw = target_match.decode_b64(data)
        if not raw or not (raw[:2] == b"\xff\xd8" or raw[:4] == b"\x89PNG"):
            return False
        try:
            self.ref_dir.mkdir(parents=True, exist_ok=True)
            self._ref_file(tid).write_bytes(raw)
            return True
        except OSError as exc:
            log.warning("Could not save the reference image of %s: %s", tid, exc)
            return False

    def _drop_references(self, tids):
        for tid in tids:
            try:
                self._ref_file(tid).unlink()
            except OSError:
                pass

    # ------------------------------------------------------------------ lifecycle
    def start_thread(self):
        self._thread = threading.Thread(target=self._run, name="live-collect", daemon=True)
        self._thread.start()

    def stop_thread(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("Live collect step failed")
            self._stop.wait(TICK_S)

    # ------------------------------------------------------------------ queue (from the app)
    def add_targets(self, items):
        """Add / update plastic positions. Returns what happened to each."""
        s = self.link.snapshot()
        ref = (s["lat"], s["lng"]) if s["lat"] is not None else (s["home_lat"], s["home_lng"])
        added, updated, merged, rejected = [], [], [], []
        new_points = []
        with self._lock:
            for it in items or []:
                try:
                    tid = str(it["id"])[:80]
                    lat = float(it["lat"] if it.get("lat") is not None else it["latitude"])
                    lng = float(it["lng"] if it.get("lng") is not None else it["longitude"])
                except (KeyError, TypeError, ValueError):
                    rejected.append({"id": str(it.get("id")) if isinstance(it, dict) else None, "reason": "no position"})
                    continue
                if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0) or not tid:
                    rejected.append({"id": tid, "reason": "invalid position"})
                    continue
                cls = str(it.get("object_class") or it.get("label") or "")[:40] or None
                ref_img = it.get("reference_image")
                t = self.targets.get(tid)
                if t is not None:
                    if cls and not t.get("object_class"):
                        t["object_class"] = cls
                    if ref_img and not t.get("has_reference") and self._save_reference(tid, ref_img):
                        t["has_reference"] = True
                    if t["status"] in ACTIVE and haversine_m(t["lat"], t["lng"], lat, lng) > 0.3:
                        t["lat"], t["lng"] = lat, lng   # the app refined the spot (more drone sightings)
                        updated.append(tid)
                        if tid == self.current:
                            self._t_goto = 0.0          # steer to the new spot straight away
                    continue
                if ref[0] is not None:
                    d = haversine_m(ref[0], ref[1], lat, lng)
                    if d > self.cfg["max_distance_m"]:
                        rejected.append({"id": tid, "reason": f"{d:.0f} m away (limit {self.cfg['max_distance_m']:.0f} m)"})
                        continue
                twin = next((o for o in self.targets.values() if o["status"] in ACTIVE
                             and haversine_m(o["lat"], o["lng"], lat, lng) <= self.cfg["live_merge_m"]), None)
                if twin is not None:
                    merged.append({"id": tid, "into": twin["id"]})
                    twin.setdefault("aliases", []).append(tid)
                    continue
                try:
                    detected_at = float(it["timestamp"]) if it.get("timestamp") is not None else None
                    if detected_at and detected_at > 1e11:
                        detected_at /= 1000.0           # the app's milliseconds
                except (TypeError, ValueError):
                    detected_at = None
                t = self.targets[tid] = {
                    "id": tid, "lat": lat, "lng": lng, "status": "pending", "how": None,
                    "source": str(it.get("source") or "app")[:20], "confidence": it.get("confidence"),
                    "object_class": cls, "detected_at": detected_at,
                    "has_reference": bool(ref_img) and self._save_reference(tid, ref_img),
                    "added_at": round(time.time(), 1), "done_at": None,
                    "state": None, "retry_count": 0, "match_score": None, "verified": None, "history": [],
                }
                conf = it.get("confidence")
                self._set_state(t, "DETECTED", f"drone: {cls or 'plastic'}"
                                + (f", {float(conf):.2f}" if isinstance(conf, (int, float)) else ""),
                                at=detected_at)
                self._set_state(t, "SENT", "received by the boat"
                                + (", with the drone's image" if t["has_reference"] else ""))
                added.append(tid)
                new_points.append({"id": tid, "lat": lat, "lng": lng, "object_class": cls})
            if added or updated:
                self._save()
            if added:
                self._event(f"{len(added)} new item{'s' if len(added) > 1 else ''} from the drone")
        if new_points and self.on_targets_added:
            try:
                self.on_targets_added(new_points)
            except Exception:
                log.exception("Simulator hook failed")
        return {"added": added, "updated": updated, "merged": merged, "rejected": rejected}

    def clear(self, done_only=False):
        with self._lock:
            if self.state in ("running", "returning") and not done_only:
                raise LinkError("Pause or stop live collect before clearing its queue.")
            before = len(self.targets)
            keep = {k: v for k, v in self.targets.items() if done_only and v["status"] in ACTIVE}
            self._drop_references([k for k in self.targets if k not in keep])
            self.targets = keep
            if not done_only:
                self.current = None
            self._save()
            return before - len(self.targets)

    def skip(self, tid):
        with self._lock:
            t = self.targets.get(str(tid))
            if t is None or t["status"] not in ACTIVE:
                raise LinkError("That item isn't waiting to be collected.")
            if tid == self.current and self.phase == "camera":
                raise LinkError("The camera is homing onto it right now — wait a moment.")
            self._finish(t, False, "skipped", state="SKIPPED")
            return "Skipped."

    def retry(self, tid):
        """Put a target that wasn't collected (NOT_FOUND / RETRY_REQUIRED / skipped) back in the queue."""
        with self._lock:
            t = self.targets.get(str(tid))
            if t is None:
                raise LinkError("No such item.")
            if t["status"] in ACTIVE:
                return "It is already waiting to be collected."
            if t["status"] == "collected":
                raise LinkError("That item was collected.")
            t["status"], t["how"], t["done_at"], t["retry_count"] = "pending", None, None, 0
            self._camera_tried.discard(t["id"])
            self._set_state(t, "SENT", "retry requested")
            self._save()
            return "Back in the queue."

    # ------------------------------------------------------------------ start / pause / stop
    def start(self, when_empty="wait", speed_mps=None):
        if when_empty not in ("wait", "return"):
            raise LinkError("when_empty must be wait or return.")
        if not self.link.fc_connected:
            raise LinkError("The Pixhawk is not connected.")
        if self.missions.status()["state"] in ("running", "returning") and self.link.snapshot()["armed"]:
            raise LinkError("A planned mission is running. Pause it before starting live collect.")
        s = self.link.snapshot()
        if s["lat"] is None:
            raise LinkError("No GPS position yet — live collect needs a GPS fix (GUIDED mode).")
        with self._lock:
            if self.state == "returning":
                raise LinkError("The boat is returning home. Stop live collect first.")
            self.when_empty = when_empty
            if speed_mps:
                self.speed = max(0.2, min(3.0, float(speed_mps)))
            armed_here = False
            if not s["armed"]:
                # Arm in HOLD (never in GUIDED, so it can't lurch off mid-command).
                self.link.set_mode("HOLD")
                self.link.arm(True)
                armed_here = True
            try:
                self._t_mode = time.time()
                self.link.set_mode("GUIDED")
                self.link.set_speed(self._speed())
            except LinkError:
                if armed_here:
                    try:
                        self.link.arm(False)
                    except LinkError:
                        pass
                raise
            if self.vision is not None:
                self.vision.operator_start()
            resumed = self.state == "paused"
            self.state, self.reason = "running", None
            self.current, self.phase = None, None
            self._t_goto = 0.0
            self.started_at = self.started_at if resumed else time.time()
            for t in self.targets.values():
                if t["status"] == "active":
                    t["status"] = "pending"
            self._event("Resumed" if resumed else "Started — going after the drone's plastic finds")
            n = sum(1 for t in self.targets.values() if t["status"] in ACTIVE)
            return f"Live collect {'resumed' if resumed else 'started'}: {n} item{'s' if n != 1 else ''} waiting."

    def pause(self, reason="paused from the app", hold=True):
        with self._lock:
            if self.state not in ("running", "returning"):
                return "Live collect isn't running."
            self._pause(reason)
        if hold:
            try:
                self.link.set_mode("HOLD")
            except LinkError as exc:
                self._event(f"Could not switch to HOLD: {exc}", "warn")
        return "Live collect paused. The boat is holding."

    def operator(self, reason):
        """An operator command (mode, Hold, RTL, stop, disarm) is about to be sent:
        stop commanding the boat at once."""
        with self._lock:
            if self.state in ("running", "returning"):
                self._pause(f"operator: {reason}")

    def _pause(self, reason):
        """Lock held. Stop commanding; the current item goes back in the queue."""
        self.state, self.reason = "paused", reason
        t = self.targets.get(self.current) if self.current else None
        if t is not None and t["status"] == "active":
            t["status"] = "pending"
            self._set_state(t, "SENT", f"paused: {reason}")
        self.current, self.phase = None, None
        self._set_roller(False)
        self._event(f"Paused ({reason})", "warn")

    def stop(self, rtl=False):
        with self._lock:
            if self.state == "off":
                return "Live collect isn't running."
            t = self.targets.get(self.current) if self.current else None
            if t is not None and t["status"] == "active":
                t["status"] = "pending"
                self._set_state(t, "SENT", "live collect stopped")
            self.current, self.phase = None, None
            self._set_roller(False)
            self.state, self.reason = "off", "stopped"
        try:
            self.link.set_mode("RTL" if rtl else "HOLD")
        except LinkError as exc:
            self._event(f"Could not switch to {'RTL' if rtl else 'HOLD'}: {exc}", "warn")
        self._event("Stopped — " + ("returning home" if rtl else "holding"))
        return "Live collect stopped. " + ("The boat is returning home." if rtl else "The boat is holding.")

    # ------------------------------------------------------------------ used by vision.py (camera homing)
    def wants_homing(self, s):
        """(id, lat, lng) for the camera homing to take over, or None."""
        with self._lock:
            if self.state != "running" or self.phase != "approach" or not self.current:
                return None
            if self.current in self._camera_tried or s["lat"] is None:
                return None
            t = self.targets.get(self.current)
            if t is None or haversine_m(s["lat"], s["lng"], t["lat"], t["lng"]) > self.cfg["homing_start_m"]:
                return None
            self._camera_tried.add(self.current)
            self.phase = "camera"
            self._t_phase = time.time()
            # The homing drives straight through the item: the roller must already be turning.
            self._set_roller(True)
            return t["id"], t["lat"], t["lng"]

    def homing_finished(self, tid, collected, how, state=None, verified=None, note=None, **fields):
        """The camera homing is done with an item: COLLECTED (counted on the ramp,
        or verified gone from the spot), NOT_FOUND (the camera never saw it near
        the drone's position) or RETRY_REQUIRED (pick-up failed too often)."""
        with self._lock:
            t = self.targets.get(tid)
            if t is None:
                return
            t.update(fields)
            self._finish(t, bool(collected), (how or "camera") if collected else "missed",
                         state=state, verified=verified, note=note)
            self._t_goto = 0.0

    def homing_aborted(self, tid, why="camera homing stopped"):
        """The homing stopped without an answer (camera link lost): carry on by GPS."""
        with self._lock:
            if tid == self.current and self.phase == "camera":
                self.phase = "approach"
                self._t_goto = 0.0
                t = self.targets.get(tid)
                if t is not None:
                    self._set_state(t, "NAVIGATING", f"{why} - going on by GPS")

    def item_number(self, tid):
        for i, k in enumerate(self.targets, 1):
            if k == tid:
                return i
        return "?"

    # ------------------------------------------------------------------ the decision loop
    def _speed(self):
        return self.speed or self.cfg["default_speed_mps"]

    def _goto(self, lat, lng, now):
        self._t_goto = now
        try:
            self.link.goto(lat, lng)
        except LinkError as exc:
            self._event(f"Could not send the target: {exc}", "warn")

    @property
    def roller(self):
        return bool(self.collector and self.collector.on)

    def _set_roller(self, on):
        """What live collect wants the roller to do (collector.py: the operator's
        R1 still wins until the next change)."""
        if self.collector is not None:
            self.collector.auto(on)

    def _finish(self, t, collected, how, state=None, verified=None, note=None):
        t["status"] = "collected" if collected else "missed"
        t["how"] = how
        t["done_at"] = round(time.time(), 1)
        if verified is not None:
            t["verified"] = bool(verified)
        self._set_state(t, state or ("COLLECTED" if collected else "NOT_FOUND"), note or how)
        if t["id"] == self.current:
            self.current, self.phase = None, None
        self._save()
        self._event(f"Item {self.item_number(t['id'])} {'collected' if collected else how}"
                    + (f" ({how})" if collected else ""), "info" if collected else "warn")

    def _nearest(self, boat):
        pending = [t for t in self.targets.values() if t["status"] == "pending"]
        if not pending:
            return None
        return min(pending, key=lambda t: haversine_m(boat[0], boat[1], t["lat"], t["lng"]))

    def _tick(self):
        now = time.time()
        with self._lock:
            if self.state not in ("running", "returning"):
                return
            s = self.link.snapshot()
            if not s["fc_connected"]:
                return
            if not s["armed"]:
                self._pause("the boat was disarmed")
                return
            gps_ok = s["lat"] is not None and (s.get("gps_fix") or 0) >= 3
            if gps_ok:
                self._gps_bad_since = None
            elif self._gps_bad_since is None:
                self._gps_bad_since = now
            if self.phase == "gps_lost":
                self._gps_wait(now, s, gps_ok)
                return
            owner = self.vision.owner() if self.vision is not None else None
            if owner == "homing" and self.phase == "camera":
                return                       # the camera homing is steering onto the current item
            if owner in ("wildlife", "measure", "camera_lost", "homing"):
                return                       # a higher priority holds the boat: wait it out
            mode = s["flight_mode"]
            if self.state == "returning":
                if mode != "RTL" and now - self._t_mode > MODE_GRACE_S:
                    self._pause(f"mode changed to {mode}")
                elif s["home_lat"] is not None and s["lat"] is not None and \
                        haversine_m(s["lat"], s["lng"], s["home_lat"], s["home_lng"]) < 3 and s["groundspeed"] < 0.2:
                    self.state, self.reason = "off", "back home"
                    self._event("Back home — live collect finished")
                return
            if mode != "GUIDED":
                if now - self._t_mode > MODE_GRACE_S:
                    self._pause(f"mode changed to {mode}")
                return
            if not gps_ok:
                if self.state == "running" and now - self._gps_bad_since >= self.cfg["gps_lost_hold_s"]:
                    self._gps_lost(now)
                return                       # never steer on a bad position
            boat = (s["lat"], s["lng"])
            t = self.targets.get(self.current) if self.current else None
            if t is None or t["status"] not in ACTIVE:
                t = self._nearest(boat)
                if t is None:
                    self._idle(now, boat, s)
                    return
                self.current = t["id"]
                t["status"] = "active"
                self.phase = "approach"
                self._t_target = self._t_phase = now
                self._t_goto = 0.0
                self._empty_since = None
                d = haversine_m(*boat, t["lat"], t["lng"])
                self._set_state(t, "NAVIGATING", f"{d:.0f} m away")
                self._event(f"Heading to item {self.item_number(t['id'])} ({d:.0f} m)")
            d = haversine_m(*boat, t["lat"], t["lng"])
            t["distance_m"] = round(d, 1)
            if self.phase == "camera":
                # vision.py handed it back without an answer (or never took it)
                self.phase = "approach"
            if self.phase == "approach":
                if d <= self.cfg["live_roller_on_m"]:
                    self._set_roller(True)
                elif d > self.cfg["live_roller_on_m"] + 3:
                    self._set_roller(False)
                if now - self._t_target > self.cfg["live_target_timeout_s"]:
                    self._finish(t, False, "missed", state="RETRY_REQUIRED", note="not reached in time")
                    self._event("…it took too long to reach", "warn")
                    return
                if d <= self.cfg["live_arrive_m"]:
                    brg = _bearing(*boat, t["lat"], t["lng"]) if d > 0.2 else (s["heading"] or 0)
                    k = self.cfg["homing_drive_through_m"]
                    self._through = _offset(t["lat"], t["lng"], k * math.cos(math.radians(brg)),
                                            k * math.sin(math.radians(brg)))
                    self._set_roller(True)
                    self.phase, self._t_phase = "through", now
                    self._set_state(t, "COLLECTING", "GPS only: driving through the spot")
                    self._goto(*self._through, now)
                elif now - self._t_goto > GOTO_EVERY_S:
                    self._goto(t["lat"], t["lng"], now)
                return
            if self.phase == "through":
                if haversine_m(*boat, *self._through) < 0.6 or now - self._t_phase > 8.0:
                    self._goto(*boat, now)               # stop here while the ramp brings it up
                    self.phase, self._t_phase = "dwell", now
                    self._set_state(t, "VERIFYING", "waiting for the catch counter")
                return
            if self.phase == "dwell":
                caught = self.vision is not None and self.vision.last_catch_t >= self._t_phase - 2.0
                if caught:
                    self._finish(t, True, "camera", verified=True, note="counted on the ramp")
                elif now - self._t_phase >= self.cfg["live_dwell_s"]:
                    self._finish(t, True, "gps", verified=False, note="drove through the spot (not seen)")

    def _gps_lost(self, now):
        """Lock held. No GPS fix for gps_lost_hold_s: hold until it is back."""
        self._t_mode = now
        try:
            self.link.set_mode("HOLD")
        except LinkError as exc:
            self._event(f"GPS lost, and HOLD failed: {exc}", "warn")
            return
        t = self.targets.get(self.current) if self.current else None
        if t is not None and t["status"] == "active":
            self._set_state(t, "NAVIGATING", "GPS lost - holding")
        self.phase, self._gps_ok_since = "gps_lost", None
        self._set_roller(False)
        self._event("GPS fix lost - holding until it is back", "warn")

    def _gps_wait(self, now, s, gps_ok):
        """Lock held. Holding for the GPS: carry on once the fix has been back GPS_BACK_S."""
        if s["flight_mode"] != "HOLD" and now - self._t_mode > MODE_GRACE_S:
            self._pause(f"mode changed to {s['flight_mode']}")
            return
        if not gps_ok:
            self._gps_ok_since = None
            return
        self._gps_ok_since = self._gps_ok_since or now
        if now - self._gps_ok_since < GPS_BACK_S:
            return
        try:
            self._t_mode = now
            self.link.set_mode("GUIDED")
            self.link.set_speed(self._speed())
        except LinkError as exc:
            self._event(f"GPS back, but GUIDED failed: {exc}", "warn")
            return
        t = self.targets.get(self.current) if self.current else None
        self.phase = "approach" if t is not None and t["status"] == "active" else None
        if t is not None and self.phase:
            self._t_target = now             # the time spent holding doesn't count
            self._set_state(t, "NAVIGATING", "GPS back")
        self._t_goto = 0.0
        self._event("GPS fix back - carrying on")

    def _idle(self, now, boat, s):
        """Nothing left to collect: stop and hold here (GUIDED to our own spot), or go home."""
        if self.phase != "waiting":
            self.phase = "waiting"
            self.current = None
            self._empty_since = now
            self._set_roller(False)
            self._goto(*boat, now)
            self._event("Nothing left — waiting for the drone to find more plastic")
            return
        if self.when_empty == "return" and now - (self._empty_since or now) > self.cfg["live_return_after_s"]:
            try:
                self._t_mode = now
                self.link.set_mode("RTL")
                self.state = "returning"
                self._event("Nothing new for a while — returning home")
            except LinkError as exc:
                self._event(f"Could not return home: {exc}", "warn")
                self._empty_since = now

    # ------------------------------------------------------------------ views
    def summary(self, full=False):
        with self._lock:
            ts = list(self.targets.values())
            counts = {k: sum(1 for t in ts if t["status"] == k) for k in ("pending", "active", "collected", "missed")}
            cur = self.targets.get(self.current) if self.current else None
            out = {
                "state": self.state, "reason": self.reason, "phase": self.phase, "when_empty": self.when_empty,
                "roller": self.roller, "roller_output": self.collector.output if self.collector else 0,
                "collector_kind": ("scoop" if self.collector.scoop else "roller") if self.collector else None,
                "counts": counts, "started_at": self.started_at,
                "current": None if cur is None else {"id": cur["id"], "lat": cur["lat"], "lng": cur["lng"],
                                                     "number": self.item_number(cur["id"]),
                                                     "distance_m": cur.get("distance_m"),
                                                     "state": cur.get("state"),
                                                     "object_class": cur.get("object_class"),
                                                     "retry_count": cur.get("retry_count", 0),
                                                     "match_score": cur.get("match_score")},
                "states": {k: n for k in WORKFLOW
                           if (n := sum(1 for t in ts if t.get("state") == k))},
                # ids the app marks as collected (with the aliases merged into them)
                "collected": [i for t in ts if t["status"] == "collected" for i in [t["id"], *t.get("aliases", [])]],
                "events": list(self.events)[-6:],
            }
            if full:
                out["targets"] = [self._view(t) for t in ts]
            return out

    @staticmethod
    def _view(t, history=False):
        v = {k: t.get(k) for k in ("id", "lat", "lng", "status", "how", "source", "added_at", "done_at",
                                   "distance_m", "state", "object_class", "confidence", "detected_at",
                                   "retry_count", "match_score", "verified", "has_reference")}
        v["latitude"], v["longitude"], v["timestamp"] = t["lat"], t["lng"], t.get("detected_at")
        if history:
            v["history"] = list(t.get("history") or [])
        return v

    def target_detail(self, tid):
        with self._lock:
            t = self.targets.get(str(tid))
            return None if t is None else self._view(t, history=True)
