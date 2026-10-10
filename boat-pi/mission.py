"""
Plastic-collection missions.

The VARUNA app sends the plastic locations it wants collected. This module
turns them into an ArduRover mission (one NAV_WAYPOINT per item with a hold
time so the collector can scoop it, then RETURN_TO_LAUNCH), uploads it to the
Pixhawk, starts/pauses it, and tracks which items have been reached so the app
can mark them collected.
"""

import json
import logging
import threading
import time
import uuid

from pymavlink import mavutil

from mav_link import LinkError, haversine_m

mavlink = mavutil.mavlink
log = logging.getLogger("boat.mission")

ACTIVE_STATES = ("running", "paused", "returning")


class MissionManager:
    def __init__(self, link, cfg, data_dir):
        self.link = link
        self.cfg = cfg
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.plan_path = data_dir / "current_mission.json"
        self.history_path = data_dir / "missions.json"
        self._lock = threading.Lock()
        self.plan = self._load(self.plan_path, None)
        self.history = self._load(self.history_path, [])
        # Set by vision.py: returns "homing" / "wildlife" / "measure" while the
        # camera automation is steering or holding the boat, else None. During
        # that time the mission is still running even though the Pixhawk is in
        # GUIDED or HOLD.
        self.automation = None
        link.on_item_reached(self._on_reached)

    # ------------------------------------------------------------------ storage
    @staticmethod
    def _load(path, default):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    @staticmethod
    def _save(path, data):
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _persist(self):
        try:
            if self.plan is not None:
                self._save(self.plan_path, self.plan)
            self._save(self.history_path, self.history[-20:])
        except OSError as exc:
            log.warning("Could not save mission state: %s", exc)

    # ------------------------------------------------------------------ building
    def _build_items(self, waypoints, hold_s, speed_mps, rtl):
        s = self.link.snapshot()
        home_lat = s["home_lat"] if s["home_lat"] is not None else waypoints[0]["lat"]
        home_lng = s["home_lng"] if s["home_lng"] is not None else waypoints[0]["lng"]
        nav = mavlink.MAV_CMD_NAV_WAYPOINT
        # Item 0 is the home slot: ArduPilot overwrites it with the real home.
        items = [{"command": nav, "lat": home_lat, "lng": home_lng, "alt": 0}]
        if speed_mps and speed_mps > 0:
            items.append({"command": mavlink.MAV_CMD_DO_CHANGE_SPEED, "frame": mavlink.MAV_FRAME_MISSION,
                          "param1": 1, "param2": speed_mps, "param3": -1})
        servo = self.cfg["collector_servo"]
        if servo:
            items.append({"command": mavlink.MAV_CMD_DO_SET_SERVO, "frame": mavlink.MAV_FRAME_MISSION,
                          "param1": servo, "param2": self.cfg["collector_pwm_on"]})
        seq_map = {}
        for wp in waypoints:
            seq_map[len(items)] = wp["id"]
            own_hold = wp.get("hold_s")
            items.append({"command": nav, "param1": hold_s if own_hold is None else float(own_hold),
                          "lat": wp["lat"], "lng": wp["lng"], "alt": 0})
        if servo:
            items.append({"command": mavlink.MAV_CMD_DO_SET_SERVO, "frame": mavlink.MAV_FRAME_MISSION,
                          "param1": servo, "param2": self.cfg["collector_pwm_off"]})
        rtl_seq = None
        if rtl:
            rtl_seq = len(items)
            items.append({"command": mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH, "lat": 0, "lng": 0, "alt": 0})
        return items, seq_map, rtl_seq

    def _validate(self, waypoints):
        if not waypoints:
            raise LinkError("Select at least one plastic item to collect.")
        if len(waypoints) > self.cfg["max_waypoints"]:
            raise LinkError(f"Too many items ({len(waypoints)}); the limit is {self.cfg['max_waypoints']} per mission.")
        s = self.link.snapshot()
        ref = (s["lat"], s["lng"]) if s["lat"] is not None else (s["home_lat"], s["home_lng"])
        for i, wp in enumerate(waypoints, 1):
            lat, lng = wp["lat"], wp["lng"]
            if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
                raise LinkError(f"Item {i} has an invalid position ({lat}, {lng}).")
            if ref[0] is not None:
                d = haversine_m(ref[0], ref[1], lat, lng)
                if d > self.cfg["max_distance_m"]:
                    raise LinkError(f"Item {i} is {d:.0f} m from the boat — beyond the {self.cfg['max_distance_m']:.0f} m safety limit.")

    # ------------------------------------------------------------------ actions
    def upload(self, name, waypoints, hold_s=None, speed_mps=None, rtl=True, homing=True, measure_at_first=False):
        hold_s = self.cfg["default_hold_s"] if hold_s is None else max(0.0, min(120.0, float(hold_s)))
        speed_mps = self.cfg["default_speed_mps"] if speed_mps is None else max(0.0, min(5.0, float(speed_mps)))
        for wp in waypoints:
            wp["id"] = str(wp.get("id") or uuid.uuid4().hex[:8])
        # Paused (HOLD) is fine: the new mission replaces the old one and only
        # starts on Start. Only a boat that is driving a mission right now is refused.
        st = self.status()
        if st["state"] in ("running", "returning") and self.link.snapshot()["armed"]:
            raise LinkError("A mission is still running. Pause it or stop the boat before uploading a new one.")
        self._validate(waypoints)
        items, seq_map, rtl_seq = self._build_items(waypoints, hold_s, speed_mps, rtl)
        count = self.link.upload_mission(items)
        with self._lock:
            self.plan = {
                "id": uuid.uuid4().hex[:10],
                "name": str(name or "Collection")[:80],
                "waypoints": [{"id": w["id"], "lat": w["lat"], "lng": w["lng"]} for w in waypoints],
                "hold_s": hold_s,
                "speed_mps": speed_mps,
                "rtl": bool(rtl),
                "item_count": count,
                "seq_map": {str(k): v for k, v in seq_map.items()},
                "first_seq": min(seq_map),
                "rtl_seq": rtl_seq,
                "reached": [],
                "missed": [],
                "how": {},                 # item id → "camera" (homing) / "gps" (reached by the Pixhawk)
                "homing": bool(homing),
                "measure_at_first": bool(measure_at_first),
                "measured": False,
                "seq_synced": False,
                "state": "uploaded",
                "uploaded_at": time.time(),
                "started_at": None,
                "ended_at": None,
            }
            self.history.append({"name": self.plan["name"], "waypoint_count": len(waypoints),
                                 "uploaded_at": self.plan["uploaded_at"], "id": self.plan["id"]})
            self._persist()
        return self.plan

    def start(self):
        with self._lock:
            plan = self.plan
        if plan is None:
            raise LinkError("Upload a collection mission first.")
        st = self.status()["state"]
        if st == "completed":
            raise LinkError("This mission is already complete — upload a new one.")
        if st in ("running", "returning"):
            return "The mission is already running."
        if not self.link.fc_connected:
            raise LinkError("The Pixhawk is not connected.")
        # Arm in HOLD (never in AUTO, so it can't lurch off mid-command), then go.
        # If anything after arming fails, disarm again: a failed start must never
        # leave the operator with a boat whose motors are live.
        armed_here = False
        if not self.link.snapshot()["armed"]:
            self.link.set_mode("HOLD")
            self.link.arm(True)
            armed_here = True
        try:
            if st == "uploaded":
                # Start at item 1, not at the first waypoint: items before it are
                # the speed change and the collector switch-on, which would be
                # skipped otherwise.
                self.link.set_current_item(1, plan["first_seq"])
            self.link.set_mode("AUTO")
        except LinkError:
            if armed_here:
                try:
                    self.link.arm(False)
                    log.info("Start failed — disarmed the boat again.")
                except LinkError:
                    log.warning("Start failed and the boat could not be disarmed.")
            raise
        with self._lock:
            if self.plan is plan:
                plan["state"] = "running"
                plan["started_at"] = plan["started_at"] or time.time()
                self._persist()
        return "Collection started — the boat is heading to the first item." if st == "uploaded" else "Collection resumed."

    def pause(self):
        msg = self.link.set_mode("HOLD")
        return f"Paused. {msg}"

    def clear(self):
        with self._lock:
            if self.plan and self.status_unlocked()["state"] in ("running", "returning"):
                raise LinkError("Pause the mission before clearing it.")
            self.plan = None
            try:
                self.plan_path.unlink()
            except OSError:
                pass
        return "Mission cleared."

    # ------------------------------------------------------------------ progress
    def _on_reached(self, seq):
        with self._lock:
            plan = self.plan
            if not plan:
                return
            wid = plan["seq_map"].get(str(seq))
            if wid and wid not in plan["reached"] and wid not in plan.get("missed", []):
                plan["reached"].append(wid)
                plan.setdefault("how", {})[wid] = "gps"
                log.info("Reached item %s (%d/%d)", wid, len(plan["reached"]), len(plan["waypoints"]))
                self._persist()
            elif seq == plan.get("rtl_seq"):
                plan["rtl_reached"] = True
                self._persist()

    def status(self):
        with self._lock:
            return self.status_unlocked()

    def status_unlocked(self):
        plan = self.plan
        if not plan:
            return {"state": "none", "name": None, "total": 0, "reached": [], "reached_count": 0,
                    "current_index": None, "waypoints": []}
        s = self.link.snapshot()
        total = len(plan["waypoints"])
        all_reached = len(plan["reached"]) + len(plan.get("missed", [])) >= total  # every item collected or given up on
        state = plan["state"]
        owner = self.automation() if self.automation else None
        if state in ACTIVE_STATES and owner and s["armed"]:
            # The camera automation has the boat (homing in GUIDED, a wildlife
            # or water-test hold): the collection is still under way.
            state = plan["state"] if plan["state"] in ("running", "returning") else "running"
            if state != plan["state"]:
                plan["state"] = state
                self._persist()
        elif state in ACTIVE_STATES:
            mode, armed, seq = s["flight_mode"], s["armed"], s["mission_seq"]
            # Backup for a lost MISSION_ITEM_REACHED (lossy telemetry link): once the
            # Pixhawk is driving to a later item, every waypoint before it was reached.
            # Only once the Pixhawk has reported this mission's start: until then
            # MISSION_CURRENT may still be the previous mission's position.
            if seq is not None and not plan.get("seq_synced", True) and seq <= plan["first_seq"]:
                plan["seq_synced"] = True
            if mode == "AUTO" and armed and seq is not None and plan.get("seq_synced", True):
                missed = plan.get("missed", [])
                passed = [wid for k, wid in plan["seq_map"].items()
                          if int(k) < seq and wid not in plan["reached"] and wid not in missed]
                if passed:
                    plan["reached"].extend(passed)
                    for wid in passed:
                        plan.setdefault("how", {}).setdefault(wid, "gps")
                    all_reached = len(plan["reached"]) + len(plan.get("missed", [])) >= total  # every item collected or given up on
                    self._persist()
            if all_reached and (plan.get("rtl_reached") or not (mode in ("AUTO", "RTL") and armed)):
                state = "completed"
            elif mode == "AUTO" and armed:
                state = "returning" if plan["rtl_seq"] is not None and seq == plan["rtl_seq"] else "running"
            elif mode in ("RTL", "SMART_RTL") and armed:
                state = "returning"
            elif s["fc_connected"]:
                state = "paused"
            if state != plan["state"]:
                plan["state"] = state
                if state == "completed":
                    plan["ended_at"] = time.time()
                    self._disarm_when_done(s)
                self._persist()
        current_index = None
        if state in ("running",) and s["mission_seq"] is not None:
            wid = plan["seq_map"].get(str(s["mission_seq"]))
            if wid:
                current_index = next((i for i, w in enumerate(plan["waypoints"], 1) if w["id"] == wid), None)
        return {
            "id": plan["id"],
            "state": state,
            "name": plan["name"],
            "total": total,
            "reached": list(plan["reached"]),
            "reached_count": len(plan["reached"]),
            "missed": list(plan.get("missed", [])),
            "how": dict(plan.get("how", {})),
            "homing": plan.get("homing", True),
            "measure_at_first": plan.get("measure_at_first", False),
            "phase": owner,
            "current_index": current_index,
            "hold_s": plan["hold_s"],
            "speed_mps": plan["speed_mps"],
            "waypoints": plan["waypoints"],
            "uploaded_at": plan["uploaded_at"],
            "started_at": plan["started_at"],
            "ended_at": plan["ended_at"],
        }

    def _disarm_when_done(self, snap):
        """Motors off once the collection is finished, so the boat is safe to
        handle. It floats; use the app's commands to move it again.

        Runs in its own thread: status() is called with the mission lock held
        and from the web server's event loop, and HOLD + disarm wait several
        seconds for the Pixhawk's answers."""
        if not self.cfg.get("disarm_on_complete", True) or not snap["armed"]:
            return

        def disarm():
            try:
                self.link.set_mode("HOLD")
                self.link.arm(False)
                log.info("Collection complete — motors disarmed.")
            except LinkError as exc:
                log.warning("Collection complete but could not disarm: %s", exc)
        threading.Thread(target=disarm, name="disarm-on-complete", daemon=True).start()

    # ------------------------------------------------------------------ used by vision.py
    def waypoint_at(self, seq):
        """(item id, lat, lng) of the collection point at mission item `seq`, else None."""
        with self._lock:
            plan = self.plan
            if not plan or seq is None:
                return None
            wid = plan["seq_map"].get(str(seq))
            if not wid:
                return None
            wp = next((w for w in plan["waypoints"] if w["id"] == wid), None)
            return (wid, wp["lat"], wp["lng"]) if wp else None

    def item_done(self, wid):
        with self._lock:
            plan = self.plan
            return bool(plan) and (wid in plan["reached"] or wid in plan.get("missed", []))

    def mark_item(self, wid, collected, how="camera"):
        """Homing finished an item: collected (the catch counter saw it) or missed."""
        with self._lock:
            plan = self.plan
            if not plan:
                return
            if collected:
                if wid not in plan["reached"]:
                    plan["reached"].append(wid)
                if wid in plan.get("missed", []):
                    plan["missed"].remove(wid)
            elif wid not in plan["reached"] and wid not in plan.setdefault("missed", []):
                plan["missed"].append(wid)
            plan.setdefault("how", {})[wid] = how
            log.info("Item %s %s (%s)", wid, "collected" if collected else "missed", how)
            self._persist()

    def plan_flags(self):
        with self._lock:
            plan = self.plan
            if not plan:
                return None
            return {"homing": plan.get("homing", True), "measure_at_first": plan.get("measure_at_first", False),
                    "measured": plan.get("measured", False), "speed_mps": plan.get("speed_mps"),
                    "reached": len(plan["reached"]), "state": plan["state"]}

    def set_measured(self):
        with self._lock:
            if self.plan:
                self.plan["measured"] = True
                self._persist()

    def list_missions(self):
        return list(reversed(self.history[-20:]))
