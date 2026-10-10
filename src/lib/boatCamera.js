// Pixel → water distance for the boat's forward-down camera. Same maths as
// boat-pi/camera_model.py (keep the two in step): the camera sits height_m
// above the water and points tilt_deg below the horizon. Used to label boxes
// on the Boat Vision tab with how far ahead they are.

export function groundFromPixel(cfg, x, y, w, h) {
  const th = Math.tan(((cfg.camera_hfov_deg || 66) * Math.PI) / 360)
  const tv = (th * h) / w
  const tilt = ((cfg.camera_tilt_deg ?? 15) * Math.PI) / 180
  const cx = (x / w - 0.5) * 2 * th
  const cy = (y / h - 0.5) * 2 * tv
  const forward = Math.cos(tilt) - cy * Math.sin(tilt)
  const down = Math.sin(tilt) + cy * Math.cos(tilt)
  if (down <= 1e-6) return null
  const k = (cfg.camera_height_m || 0.6) / down
  return { forward: forward * k, right: cx * k }
}

/** Metres ahead of a box (where it meets the water), or null above the horizon. */
export function boxDistance(cfg, box, w, h) {
  const g = groundFromPixel(cfg, (box.x1 + box.x2) / 2, Math.min(box.y2, (cfg.ramp_top || 0.78) * h), w, h)
  return g ? Math.hypot(g.forward, g.right) : null
}

/** Is the box (its waterline point) inside the wildlife danger zone? */
export function inDangerZone(cfg, box, w, h) {
  const cx = (box.x1 + box.x2) / 2 / w
  const cy = box.y2 / h
  return cx >= (cfg.zone_x1 ?? 0.25) && cx <= (cfg.zone_x2 ?? 0.75) && cy >= (cfg.zone_y1 ?? 0.3) && cy <= (cfg.ramp_top ?? 0.78) + 0.02
}
