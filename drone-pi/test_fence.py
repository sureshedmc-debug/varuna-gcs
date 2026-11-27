"""
Mission fence: geometry, and the upload → start → finish flow against a fake
Pixhawk link (no hardware needed).

    python test_fence.py
"""

import math
import sys
import tempfile
import time
from pathlib import Path

from pymavlink import mavutil

import fence as F
import mission as M
from mav_link import LinkError, haversine_m

mavlink = mavutil.mavlink
failures = 0


def check(cond, text):
    global failures
    print(("PASS " if cond else "FAIL ") + text)
    if not cond:
        failures += 1


HOME = (17.4239, 78.4738)


def offset(lat, lng, north_m, east_m):
    return (lat + math.degrees(north_m / 6371000.0),
            lng + math.degrees(east_m / (6371000.0 * math.cos(math.radians(lat)))))


# ---------------------------------------------------------------- geometry
wps = [offset(*HOME, 120, 40), offset(*HOME, 200, -80), offset(*HOME, 60, -150), offset(*HOME, -40, 90)]
poly = F.mission_fence([HOME] + wps, 30)
check(3 <= len(poly) <= F.MAX_VERTICES, f"polygon has {len(poly)} corners")
check(all(F.inside(poly, *p) for p in [HOME] + wps), "home and every waypoint are inside the fence")
check(all(F.distance_to_edge_m(poly, *p) >= 29.0 for p in [HOME] + wps), "every point is at least ~30 m from the edge")
legs = [HOME] + wps + [HOME]
mid_ok = True
for a, b in zip(legs, legs[1:]):
    for k in range(1, 10):
        t = k / 10
        p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        mid_ok &= F.inside(poly, *p) and F.distance_to_edge_m(poly, *p) >= 29.0
check(mid_ok, "every leg (and the way home) stays 30 m inside the fence")
far = offset(*HOME, 400, 0)
check(not F.inside(poly, *far), "a point 400 m north is outside")
widest = max(haversine_m(HOME[0], HOME[1], *p) for p in poly)
check(widest < 300, f"fence is tight around the plan (farthest corner {widest:.0f} m from home)")

one = F.mission_fence([HOME, offset(*HOME, 100, 0)], 30)
check(F.inside(one, *offset(*HOME, 50, 0)) and not F.inside(one, *offset(*HOME, 50, 40)),
      "a single leg gets a 30 m wide corridor (stadium shape)")
items = F.fence_items(poly)
check(all(i["command"] == mavlink.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION and i["param1"] == len(poly)
          for i in items), "fence items are inclusion-polygon vertices with the vertex count")


# ---------------------------------------------------------------- flow with a fake Pixhawk
class FakeLink:
    def __init__(self):
        self.params = {"FENCE_TYPE": 3.0, "FENCE_ENABLE": 1.0, "FENCE_ALT_MAX": 100.0}
        self.uploads = []        # (mission_type, items)
        self.commands = []
        self.state = dict(fc_connected=True, armed=False, landed_state="on_ground", relative_alt=0.0,
                          flight_mode="STABILIZE", mission_seq=None, home_lat=HOME[0], home_lng=HOME[1],
                          lat=HOME[0], lng=HOME[1])
        self.fence_enabled = True

    def on_item_reached(self, cb):
        pass

    def snapshot(self):
        return dict(self.state)

    def _require_fc(self):
        pass

    def get_param(self, name, timeout=3.0):
        return self.params.get(name)

    def set_param(self, name, value, timeout=3.0):
        self.params[name] = float(value)
        return float(value)

    def command_long(self, command, params, timeout=3.0):
        self.commands.append((command, list(params)))
        if command == mavlink.MAV_CMD_DO_FENCE_ENABLE:
            self.fence_enabled = bool(params[0])
        return mavlink.MAV_RESULT_ACCEPTED

    def upload_mission(self, items, timeout=30.0, mission_type=mavlink.MAV_MISSION_TYPE_MISSION):
        self.uploads.append((mission_type, items))
        return len(items)

    def set_mode(self, name):
        self.state["flight_mode"] = name
        return f"Mode {name}"

    def arm(self, arm, force=False):
        self.state["armed"] = bool(arm)

    def set_current_item(self, seq):
        self.state["mission_seq"] = seq
        return True

    def mission_start(self):
        self.state.update(landed_state="in_air", relative_alt=10.0)


cfg = {"max_waypoints": 100, "max_altitude_m": 120, "max_distance_m": 1500, "takeoff_alt_m": 10,
       "loiter_time_s": 10, "mission_fence_m": 30}
link = FakeLink()
mm = M.MissionManager(link, cfg, Path(tempfile.mkdtemp()))
raw = [{"lat": p[0], "lng": p[1], "alt": 20, "speed": 18, "action": "waypoint"} for p in wps]
mm.upload("Fence test", raw)
types = [t for t, _ in link.uploads]
check(types == [mavlink.MAV_MISSION_TYPE_FENCE, mavlink.MAV_MISSION_TYPE_MISSION], "upload sends the fence, then the mission")
st = mm.status()
check(st["fence"] and len(st["fence"]) == len(link.uploads[0][1]), "status carries the fence polygon for the app")
check(not st["fence_active"] and link.params["FENCE_TYPE"] == 3, "fence not switched yet before Start")

try:
    mm.upload("Too high", [{"lat": wps[0][0], "lng": wps[0][1], "alt": 118, "action": "waypoint"}])
    check(False, "a waypoint 2 m under the 120 m height fence is refused")
except LinkError as exc:
    check("height fence" in str(exc), f"a waypoint 2 m under the height fence is refused ({exc})")

mm.upload("Fence test", raw)
mm.start()
check(link.params["FENCE_TYPE"] == 5 and link.params["FENCE_ALT_MAX"] == 120,
      "Start switches the fence to height limit + mission polygon (FENCE_TYPE 5, 120 m)")
check(link.fence_enabled and mm.status()["fence_active"], "fence is enabled and marked active")
check(link.state["armed"] and link.state["flight_mode"] == "AUTO", "drone armed and in AUTO")

# Mission ends: landed and disarmed → fence goes back to type 3 in the background.
link.state.update(armed=False, landed_state="on_ground", relative_alt=0.0, flight_mode="LAND")
check(mm.status()["state"] == "completed", "mission completes once landed and disarmed")
for _ in range(50):
    if link.params["FENCE_TYPE"] == 3 and not mm.status()["fence_active"]:
        break
    time.sleep(0.1)
check(link.params["FENCE_TYPE"] == 3 and link.fence_enabled, "after the mission the fence is back to height + circle (type 3)")

# Fence off in the config: no fence upload, no fence switching.
cfg["mission_fence_m"] = 0
link2 = FakeLink()
mm2 = M.MissionManager(link2, cfg, Path(tempfile.mkdtemp()))
mm2.upload("No fence", raw)
mm2.start()
check([t for t, _ in link2.uploads] == [mavlink.MAV_MISSION_TYPE_MISSION] and link2.params["FENCE_TYPE"] == 3,
      "mission_fence_m = 0: only the mission is uploaded and the fence is left alone")

print("\nALL PASS" if not failures else f"\n{failures} FAILED")
sys.exit(1 if failures else 0)
