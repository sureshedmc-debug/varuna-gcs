// The geofence the drone Pi draws around a mission (drone-pi/fence.py — keep
// the two in step): the convex hull of a circle of `marginM` around home and
// every waypoint. The Pi uploads it to the Pixhawk with the mission; the app
// draws the same shape on the planning map so you see it before you upload.

const EARTH_R = 6371000
const CIRCLE_STEPS = 16
const MAX_VERTICES = 70

/** Default margin, until the Pi's live setting (mission_fence_m) has been read. */
export const DEFAULT_FENCE_M = 30

function hull(pts) {
  const uniq = [...new Map(pts.map((p) => [`${p[0]},${p[1]}`, p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (uniq.length <= 2) return uniq
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** points: [[lat, lng], …] → fence polygon [[lat, lng], …], or null for no points / margin 0. */
export function missionFence(points, marginM = DEFAULT_FENCE_M) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (!pts.length || !(marginM > 0)) return null
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const lng0 = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const kx = (Math.PI / 180) * EARTH_R * Math.cos((lat0 * Math.PI) / 180)
  const ky = (Math.PI / 180) * EARTH_R
  let steps = CIRCLE_STEPS
  let h
  for (;;) {
    const ring = []
    for (const [lat, lng] of pts) {
      const x = (lng - lng0) * kx
      const y = (lat - lat0) * ky
      for (let k = 0; k < steps; k++) {
        const a = (2 * Math.PI * k) / steps
        ring.push([Math.round((x + marginM * Math.cos(a)) * 100) / 100, Math.round((y + marginM * Math.sin(a)) * 100) / 100])
      }
    }
    h = hull(ring)
    if (h.length <= MAX_VERTICES || steps <= 8) break
    steps /= 2
  }
  return h.map(([x, y]) => [lat0 + y / ky, lng0 + x / kx])
}
