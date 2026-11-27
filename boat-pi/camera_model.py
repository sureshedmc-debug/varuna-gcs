"""
Where a pixel of the boat camera lands on the water, and back.

The camera sits `height_m` above the water and points `tilt_deg` below the
horizon, straight ahead. A pixel is a ray from the lens; following it down to
the water gives a point `forward` metres ahead and `right` metres to the side
of the boat. With the boat's position and heading at the moment the frame was
taken, that becomes a latitude/longitude.

Pixels are square, so the vertical field of view follows from the horizontal
one and the picture's shape. Lens distortion is ignored (fine for a ±10 %
range estimate at the short distances homing works at).
"""

import math

EARTH_R = 6371000.0


class CameraModel:
    def __init__(self, hfov_deg, tilt_deg, height_m, width, height):
        self.w, self.h = float(width), float(height)
        self.th = math.tan(math.radians(hfov_deg) / 2)          # tan(half horizontal FOV)
        self.tv = self.th * self.h / self.w                       # tan(half vertical FOV)
        self.tilt = math.radians(tilt_deg)
        self.cam_h = float(height_m)

    @classmethod
    def from_cfg(cls, cfg, width=None, height=None):
        return cls(cfg["camera_hfov_deg"], cfg["camera_tilt_deg"], cfg["camera_height_m"],
                   width or cfg["camera_width"], height or cfg["camera_height"])

    def pixel_to_ground(self, x, y):
        """(forward_m, right_m) on the water for pixel (x, y), or None above the horizon."""
        cx = (x / self.w - 0.5) * 2 * self.th
        cy = (y / self.h - 0.5) * 2 * self.tv
        c, s = math.cos(self.tilt), math.sin(self.tilt)
        forward = c - cy * s
        down = s + cy * c
        if down <= 1e-6:
            return None
        k = self.cam_h / down
        return forward * k, cx * k

    def ground_to_pixel(self, forward, right):
        """Pixel (x, y) where a water point `forward` ahead and `right` to the side
        appears, or None if it is behind the camera."""
        c, s = math.cos(self.tilt), math.sin(self.tilt)
        cz = forward * c + self.cam_h * s
        if cz <= 1e-6:
            return None
        cy = -forward * s + self.cam_h * c
        x = (right / cz / self.th / 2 + 0.5) * self.w
        y = (cy / cz / self.tv / 2 + 0.5) * self.h
        return x, y

    def ground_scale(self, forward):
        """Metres per pixel (horizontally) at a point `forward` metres ahead."""
        c, s = math.cos(self.tilt), math.sin(self.tilt)
        cz = forward * c + self.cam_h * s
        return cz * 2 * self.th / self.w


def offset(lat, lng, north_m, east_m):
    dlat = north_m / EARTH_R
    dlng = east_m / (EARTH_R * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lng + math.degrees(dlng)


def to_world(lat, lng, heading_deg, forward, right):
    """Boat-relative (forward, right) metres → latitude/longitude."""
    h = math.radians(heading_deg or 0.0)
    north = forward * math.cos(h) - right * math.sin(h)
    east = forward * math.sin(h) + right * math.cos(h)
    return offset(lat, lng, north, east)


def to_boat(lat, lng, heading_deg, plat, plng):
    """Latitude/longitude → boat-relative (forward, right) metres."""
    north = math.radians(plat - lat) * EARTH_R
    east = math.radians(plng - lng) * EARTH_R * math.cos(math.radians((lat + plat) / 2))
    h = math.radians(heading_deg or 0.0)
    forward = north * math.cos(h) + east * math.sin(h)
    right = -north * math.sin(h) + east * math.cos(h)
    return forward, right


def dist_m(lat1, lng1, lat2, lng2):
    north = math.radians(lat2 - lat1) * EARTH_R
    east = math.radians(lng2 - lng1) * EARTH_R * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(north, east)
