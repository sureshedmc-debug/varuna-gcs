// Where a detected item actually is on the water, from where its box sits in
// the drone's straight-down camera picture.
//
// The drone's GPS gives the point straight below the drone; an item near the
// edge of the picture can be 10–15 m away from it at 20 m altitude. This traces
// the ray from the camera through the box's centre down to the water, using the
// drone's altitude, heading and tilt (roll / pitch) and the camera's field of
// view, so the boat is sent to the item rather than to where the drone was.
//
// Pinhole camera, no lens distortion; the water is taken to be at the take-off
// height (the altitude is relative to home). Typically within a few metres —
// limited by the drone's GPS, compass and barometer.

import { MIN_SIZE_ALT_M, MAX_SIZE_ALT_M } from './sizeEstimate'

const D2R = Math.PI / 180
const M_PER_DEG_LAT = 111320
const MIN_DOWN = 0.25 // rays flatter than ~75° from vertical: too far out to trust

/**
 * Ground position of one pixel of the drone picture.
 * @param {object} o
 * @param {number} o.px, o.py               pixel (x right, y down) in the frame
 * @param {number} o.frameW, o.frameH       frame size in pixels
 * @param {number} o.lat, o.lng             drone position
 * @param {number} o.altitudeM              drone height above the water (relative altitude)
 * @param {number} o.headingDeg             drone nose direction, degrees from north
 * @param {number} [o.rollDeg=0]            right wing down = positive
 * @param {number} [o.pitchDeg=0]           nose up = positive
 * @param {number} o.fovHDeg                camera horizontal field of view
 * @param {number} [o.rotationDeg=0]        which way the TOP of the picture faces,
 *                                          clockwise from the drone's nose (0 = front)
 * @param {boolean} [o.levelled=false]      camera on a stabilising gimbal: ignore roll / pitch
 * @returns {{lat:number, lng:number, offsetM:number}|null} null when an input is missing or unusable
 */
export function projectPixel(o) {
  const { px, py, frameW, frameH, lat, lng, altitudeM, headingDeg, fovHDeg } = o
  const alt = Number(altitudeM)
  const nums = [px, py, frameW, frameH, lat, lng, alt, headingDeg, fovHDeg]
  if (!nums.every((v) => v != null && Number.isFinite(Number(v)))) return null
  if (alt < MIN_SIZE_ALT_M || alt > MAX_SIZE_ALT_M || frameW <= 0 || frameH <= 0) return null
  if (lat === 0 && lng === 0) return null

  // Ray through the pixel, in the camera: u right, v up (picture), 1 = straight down.
  const f = frameW / 2 / Math.tan((Number(fovHDeg) * D2R) / 2)
  const u = (px - frameW / 2) / f
  const v = (frameH / 2 - py) / f

  // Camera → drone body (x forward, y right, z down).
  const r = (Number(o.rotationDeg) || 0) * D2R
  let x = v * Math.cos(r) - u * Math.sin(r)
  let y = v * Math.sin(r) + u * Math.cos(r)
  let z = 1

  // Body → level frame (still facing the nose): roll about x, then pitch about y.
  if (!o.levelled) {
    const phi = (Number(o.rollDeg) || 0) * D2R
    const th = (Number(o.pitchDeg) || 0) * D2R
    const y1 = y * Math.cos(phi) - z * Math.sin(phi)
    const z1 = y * Math.sin(phi) + z * Math.cos(phi)
    const x2 = x * Math.cos(th) + z1 * Math.sin(th)
    const z2 = -x * Math.sin(th) + z1 * Math.cos(th)
    x = x2
    y = y1
    z = z2
  }
  const len = Math.hypot(x, y, z)
  if (z / len < MIN_DOWN) return null

  // Down to the water, then turn by the heading into north / east metres.
  const fwd = (alt * x) / z
  const right = (alt * y) / z
  const h = Number(headingDeg) * D2R
  const north = fwd * Math.cos(h) - right * Math.sin(h)
  const east = fwd * Math.sin(h) + right * Math.cos(h)
  return {
    lat: lat + north / M_PER_DEG_LAT,
    lng: lng + east / (M_PER_DEG_LAT * Math.cos(lat * D2R)),
    offsetM: Math.hypot(north, east),
  }
}

function metresBetween(a, b) {
  const dy = (a.lat - b.lat) * M_PER_DEG_LAT
  const dx = (a.lng - b.lng) * M_PER_DEG_LAT * Math.cos(a.lat * D2R)
  return Math.hypot(dx, dy)
}

/**
 * Project every box's centre and group boxes whose items lie within `mergeM`
 * of each other on the water — each group is one place to collect from.
 * @param {Array<{x1,y1,x2,y2}>} boxes
 * @param {object} view  everything projectPixel needs except px / py
 * @param {number} [mergeM=5]
 * @returns {Array<{lat:number, lng:number, offsetM:number, boxes:Array}>|null}
 *   null if the picture can't be projected (missing altitude / heading …)
 */
export function projectBoxes(boxes, view, mergeM = 5) {
  const groups = []
  for (const b of boxes) {
    const p = projectPixel({ ...view, px: (b.x1 + b.x2) / 2, py: (b.y1 + b.y2) / 2 })
    if (!p) return null
    const g = groups.find((c) => metresBetween(c, p) <= mergeM)
    if (g) {
      g.boxes.push(b)
      const n = g.boxes.length
      g.lat += (p.lat - g.lat) / n
      g.lng += (p.lng - g.lng) / n
      g.offsetM = Math.max(g.offsetM, p.offsetM)
    } else {
      groups.push({ lat: p.lat, lng: p.lng, offsetM: p.offsetM, boxes: [b] })
    }
  }
  return groups
}
