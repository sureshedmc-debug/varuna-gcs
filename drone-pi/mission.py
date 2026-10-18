"""
Drone missions, from the VARUNA app's Missions tab to the Pixhawk (ArduCopter).

The app sends waypoints as {lat, lng, alt (m), speed (km/h), action}. Action is
"waypoint", "loiter" (hover there for loiter_time_s) or "land". This module
builds the ArduCopter mission:

    0  home placeholder (ArduPilot overwrites it with the real home)
    1  TAKEOFF to the first point's altitude
    2  CHANGE_SPEED to the mission speed
    …  one item per waypoint (speed changes inserted when the speed changes)
    n  RETURN_TO_LAUNCH, unless the last point is a "land"

then uploads it, starts it (GUIDED → arm → AUTO → MISSION_START), and tracks
progress so the app can show it.
"""

import json
import logging
import threading
import time
import uuid

from pymavlink import mavutil

from mav_link import LinkError, haversine_m

mavlink = mavutil.mavlink
log = logging.getLogger("drone.mission")

ACTIVE = ("running", "paused", "returning", "landing")


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
            self._save(self.history_path, self.history[-30:])
        except OSError as exc:
            log.warning("Could not save mission state: %s", exc)

    def _history_set(self, plan_id, **fields):
        for h in self.history:
            if h.get("id") == plan_id:
                h.update(fields)
                h["updated_at"] = _iso()

    # ------------------------------------------------------------------ building
    def _validate(self, waypoints):
        if not waypoints:
            raise LinkError("Add at least one waypoint.")
        if len(waypoints) > self.cfg["max_waypoints"]:
            raise LinkError(f"Too many waypoints ({len(waypoints)}); the limit is {self.cfg['max_waypoints']}.")
        s = self.link.snapshot()
        ref = (s["home_lat"], s["home_lng"]) if s["home_lat"] is not None else (s["lat"], s["lng"])
        max_alt = float(self.cfg["max_altitude_m"])
        for i, wp in enumerate(waypoints, 1):
            lat, lng, alt = wp["lat"], wp["lng"], wp["alt"]
            if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
                raise LinkError(f"Waypoint {i} has an invalid position ({lat}, {lng}).")
            if alt > max_alt:
                raise LinkError(f"Waypoint {i} is at {alt:g} m — above the {max_alt:g} m limit (System → Live tuning).")
            if wp["action"] != "land" and alt < 2:
                raise LinkError(f"Waypoint {i} is at {alt:g} m — fly at least 2 m above home.")
            if ref[0] is not None:
                d = haversine_m(ref[0], ref[1], lat, lng)
                if d > self.cfg["max_distance_m"]:
                    raise LinkError(f"Waypoint {i} is {d:.0f} m from home — beyond the {self.cfg['max_distance_m']:.0f} m limit.")

    def _build(self, waypoints):
        s = self.link.snapshot()
        home_lat = s["home_lat"] if s["home_lat"] is not None else waypoints[0]["lat"]
        home_lng = s["home_lng"] if s["home_lng"] is not None else waypoints[0]["lng"]
        nav = mavlink.MAV_CMD_NAV_WAYPOINT
        first_alt = max(2.0, waypoints[0]["alt"])
        items = [{"command": nav, "lat": home_lat, "lng": home_lng, "alt": 0},
                 {"command": mavlink.MAV_CMD_NAV_TAKEOFF, "lat": 0, "lng": 0, "alt": first_alt}]
        seq_map, speed = {}, None
        landed = False
        for wp in waypoints:
            if wp["speed_mps"] and wp["speed_mps"] != speed:
                speed = wp["speed_mps"]
                items.append({"command": mavlink.MAV_CMD_DO_CHANGE_SPEED, "frame": mavlink.MAV_FRAME_MISSION,
                              "param1": 1, "param2": speed, "param3": -1})
            seq_map[len(items)] = wp["id"]
            if wp["action"] == "loiter":
                items.append({"command": mavlink.MAV_CMD_NAV_LOITER_TIME, "param1": self.cfg["loiter_time_s"],
                              "lat": wp["lat"], "lng": wp["lng"], "alt": wp["alt"]})
            elif wp["action"] == "land":
                items.append({"command": mavlink.MAV_CMD_NAV_LAND, "lat": wp["lat"], "lng": wp["lng"], "alt": 0})
                landed = True
                break  # nothing after a landing would ever be flown
            else:
                items.append({"command": nav, "lat": wp["lat"], "lng": wp["lng"], "alt": wp["alt"]})
        rtl_seq = None
        if not landed:
            rtl_seq = len(items)
            items.append({"command": mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH, "lat": 0, "lng": 0, "alt": 0})
        return items, seq_map, rtl_seq, len(items) - 1

    # ------------------------------------------------------------------ actions
    def upload(self, name, raw_waypoints):
        waypoints = []
        for i, w in enumerate(raw_waypoints, 1):
            action = str(w.get("action") or "waypoint").lower()
            if action not in ("waypoint", "loiter", "land"):
                action = "waypoint"
            alt = w.get("alt")
            alt = float(self.cfg["takeoff_alt_m"]) if alt in (None, "") else float(alt)
            kmh = w.get("speed")
            waypoints.append({
                "id": str(w.get("id") or i), "lat": float(w["lat"]), "lng": float(w["lng"]),
                "alt": alt, "action": action,
                "speed_mps": round(float(kmh) / 3.6, 2) if kmh not in (None, "", 0) else None,
            })
        st = self.status()["state"]
        if st in ACTIVE and self.link.snapshot()["armed"]:
            raise LinkError("A mission is running. Land or stop it before uploading a new one.")
        self._validate(waypoints)
        items, seq_map, rtl_seq, last_seq = self._build(waypoints)
        count = self.link.upload_mission(items)
        with self._lock:
            pid = uuid.uuid4().hex[:10]
            self.plan = {
                "id": pid, "name": str(name or "Mission")[:80], "waypoints": waypoints,
                "item_count": count, "seq_map": {str(k): v for k, v in seq_map.items()},
                "first_seq": 1, "rtl_seq": rtl_seq, "last_seq": last_seq,
                "reached": [], "state": "uploaded", "flew": False, "seq_synced": False,
                "uploaded_at": time.time(), "started_at": None, "ended_at": None,
            }
            first = waypoints[0]
            self.history.append({
                "id": pid, "name": self.plan["name"], "status": "uploaded",
                "waypoint_count": len(waypoints), "location": f"{first['lat']:.5f}, {first['lng']:.5f}",
                "created_at": _iso(), "updated_at": _iso(),
            })
            self._persist()
        return self.plan

    def start(self):
        with self._lock:
            plan = self.plan
        if plan is None:
            raise LinkError("Upload a mission first.")
        st = self.status()["state"]
        if st == "completed":
            raise LinkError("This mission has already been flown — upload it again to repeat it.")
        if st in ("running", "returning", "landing"):
            return "The mission is already running."
        self.link._require_fc()
        snap = self.link.snapshot()
        flying = snap["armed"] and snap["landed_state"] != "on_ground" and snap["relative_alt"] > 1.0
        armed_here = False
        try:
            if not flying:
                # On the ground: arm in GUIDED (never directly in AUTO), then go.
                self.link.set_mode("GUIDED")
                if not snap["armed"]:
                    self.link.arm(True)
                    armed_here = True
                self.link.set_current_item(plan["first_seq"])
                self.link.set_mode("AUTO")
                self.link.mission_start()
            else:
                if st == "uploaded":
                    self.link.set_current_item(plan["first_seq"])
                self.link.set_mode("AUTO")
        except LinkError:
            if armed_here:
                try:
                    self.link.arm(False)
                    log.info("Start failed — disarmed again.")
                except LinkError:
                    log.warning("Start failed and the motors could not be disarmed.")
            raise
        with self._lock:
            if self.plan is plan:
                plan["state"] = "running"
                plan["flew"] = True
                plan["started_at"] = plan["started_at"] or time.time()
                self._history_set(plan["id"], status="running")
                self._persist()
        return "Mission started — taking off." if not flying else "Mission resumed."

    def pause(self):
        # GUIDED holds position and height on its own. (LOITER would follow the
        # RC throttle stick — with no transmitter, or the stick down, the
        # copter would descend and land.)
        return "Paused, hovering in place. " + self.link.set_mode("GUIDED")

    def clear(self):
        with self._lock:
            if self.plan and self.status_unlocked()["state"] in ("running", "returning", "landing"):
                raise LinkError("Stop the mission before clearing it.")
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
            if wid and wid not in plan["reached"]:
                plan["reached"].append(wid)
                log.info("Reached waypoint %s (%d/%d)", wid, len(plan["reached"]), len(plan["waypoints"]))
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
        state = plan["state"]
        if state in ACTIVE:
            mode, armed, seq = s["flight_mode"], s["armed"], s["mission_seq"]
            # Furthest item flown. ArduCopter resets its mission pointer to item 1
            # after landing, so the current value alone can't say how far it got.
            # Only trust MISSION_CURRENT once it shows this mission's start: right
            # after a new upload it may still hold the previous mission's position.
            if seq is not None and not plan.get("seq_synced", True) and seq <= plan["first_seq"]:
                plan["seq_synced"] = True
            if armed and mode == "AUTO" and seq is not None and plan.get("seq_synced", True):
                plan["max_seq"] = max(plan.get("max_seq") or 0, seq)
                # Backup for a MISSION_ITEM_REACHED lost on the radio link: once the
                # Pixhawk flies to a later item, every waypoint before it was reached.
                passed = [wid for k, wid in plan["seq_map"].items() if int(k) < seq and wid not in plan["reached"]]
                if passed:
                    plan["reached"].extend(passed)
                    self._persist()
            on_ground = s["landed_state"] == "on_ground" or (not armed)
            if not armed and on_ground:
                state = "completed"          # landed and disarmed: the flight is over
                # A final LAND item never gets MISSION_ITEM_REACHED: it counts as
                # reached once the copter was on it and has landed.
                land_id = plan["seq_map"].get(str(plan["last_seq"]))
                if (plan["rtl_seq"] is None and land_id and land_id not in plan["reached"]
                        and (plan.get("max_seq") or 0) >= plan["last_seq"]):
                    plan["reached"].append(land_id)
            elif mode == "AUTO":
                if plan["rtl_seq"] is not None and seq is not None and seq >= plan["rtl_seq"]:
                    state = "returning"
                elif seq is not None and seq >= plan["last_seq"] and plan["rtl_seq"] is None:
                    state = "landing"
                else:
                    state = "running"
            elif mode in ("RTL", "SMART_RTL", "AUTO_RTL"):
                state = "returning"
            elif mode == "LAND":
                state = "landing"
            elif s["fc_connected"]:
                state = "paused"
            if state != plan["state"]:
                plan["state"] = state
                if state == "completed":
                    plan["ended_at"] = time.time()
                self._history_set(plan["id"], status="completed" if state == "completed" else
                                  "running" if state in ACTIVE else state)
                self._persist()
        current_index = None
        if state == "running" and s["mission_seq"] is not None:
            wid = plan["seq_map"].get(str(s["mission_seq"]))
            if wid:
                current_index = next((i for i, w in enumerate(plan["waypoints"], 1) if w["id"] == wid), None)
        return {
            "id": plan["id"], "state": state, "name": plan["name"], "total": total,
            "reached": list(plan["reached"]), "reached_count": len(plan["reached"]),
            "current_index": current_index, "waypoints": plan["waypoints"],
            "uploaded_at": plan["uploaded_at"], "started_at": plan["started_at"], "ended_at": plan["ended_at"],
        }

    def list_missions(self):
        return list(reversed(self.history[-30:]))


def _iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
