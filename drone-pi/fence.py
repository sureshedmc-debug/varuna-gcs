"""
Geofence drawn around a mission.

The fence is the smallest convex area that holds home and every waypoint,
widened by `margin_m` on all sides (the convex hull of a small circle around
each point). Every straight leg between waypoints, and the return home, lies
inside it, so a normal flight never touches it; if the drone strays past it
(a GPS jump, wind, a bad waypoint), the Pixhawk's fence action takes over.

The app draws the same shape (src/lib/missionFence.js) — keep the two in step.
"""

import math

from pymavlink import mavutil

mavlink = mavutil.mavlink

EARTH_R = 6371000.0
CIRCLE_STEPS = 16          # points on each corner's arc (every 22.5°)
MAX_VERTICES = 70          # ArduPilot keeps the fence in its parameter storage; stay well clear


def _to_xy(lat, lng, lat0, lng0):
    x = math.radians(lng - lng0) * EARTH_R * math.cos(math.radians(lat0))
    y = math.radians(lat - lat0) * EARTH_R
    return x, y


def _to_ll(x, y, lat0, lng0):
    lat = lat0 + math.degrees(y / EARTH_R)
    lng = lng0 + math.degrees(x / (EARTH_R * math.cos(math.radians(lat0))))
    return lat, lng


def _hull(pts):
    """Convex hull, counter-clockwise (Andrew's monotone chain)."""
    pts = sorted(set(pts))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def mission_fence(points, margin_m):
    """[(lat, lng), ...] → fence polygon [(lat, lng), ...] around them, margin_m wide."""
    if not points:
        return []
    lat0 = sum(p[0] for p in points) / len(points)
    lng0 = sum(p[1] for p in points) / len(points)
    steps = CIRCLE_STEPS
    while True:
        ring = []
        for lat, lng in points:
            x, y = _to_xy(lat, lng, lat0, lng0)
            for k in range(steps):
                a = 2 * math.pi * k / steps
                # Round to 1 cm so near-duplicate points don't make sliver edges.
                ring.append((round(x + margin_m * math.cos(a), 2), round(y + margin_m * math.sin(a), 2)))
        hull = _hull(ring)
        if len(hull) <= MAX_VERTICES or steps <= 8:
            break
        steps //= 2
    return [tuple(round(v, 7) for v in _to_ll(x, y, lat0, lng0)) for x, y in hull]


def fence_items(polygon):
    """Fence polygon → items for MavLink.upload_mission(..., mission_type=FENCE)."""
    n = len(polygon)
    return [{"command": mavlink.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION, "frame": mavlink.MAV_FRAME_GLOBAL,
             "param1": n, "lat": lat, "lng": lng, "alt": 0} for lat, lng in polygon]


def inside(polygon, lat, lng):
    """Point-in-polygon (ray casting), for checks and tests."""
    lat0, lng0 = polygon[0]
    pts = [_to_xy(a, b, lat0, lng0) for a, b in polygon]
    x, y = _to_xy(lat, lng, lat0, lng0)
    hit = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def distance_to_edge_m(polygon, lat, lng):
    """Shortest distance from a point to the polygon's boundary (metres)."""
    lat0, lng0 = polygon[0]
    pts = [_to_xy(a, b, lat0, lng0) for a, b in polygon]
    px, py = _to_xy(lat, lng, lat0, lng0)
    best = float("inf")
    for i in range(len(pts)):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % len(pts)]
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best
