// Turns a real water-body outline (GeoJSON from OpenStreetMap, see
// waterBody.js) into mission waypoints. Pure, deterministic geometry: the AI
// assistant only ever chooses *which* lake and *which* pattern — every
// coordinate the drone will fly comes from here, never from the language model.
//
// Patterns:
//   shoreline — a loop just inside the water's edge (where floating trash collects)
//   sweep     — back-and-forth lines covering the whole surface ("lawn-mower")

import { buffer } from '@turf/buffer'
import { area } from '@turf/area'
import { along } from '@turf/along'
import { length } from '@turf/length'
import { circle } from '@turf/circle'
import { intersect } from '@turf/intersect'
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon'
import { lineString, point, featureCollection } from '@turf/helpers'

export const MAX_ALT = 120 // hard max height cap (m) — shared with MissionScreen
export const MAX_SPEED = 15 // max speed (km/h) — shared with MissionScreen
export const MAX_WAYPOINTS = 60
export const MAX_RANGE_M = 3000 // no waypoint further than this from home
export const WORK_RADIUS_M = 800 // huge water bodies (rivers, big lakes) are clipped to this around the reference point
export const LONG_FLIGHT_MIN = 15 // warn above this estimated flight time
const CLIMB_RATE = 3 // m/s, same as the simulator
const RTL_SPEED_KMH = 25 // return-to-home cruise speed, same as the simulator

const R = 6371000
const toRad = (d) => (d * Math.PI) / 180
export function distanceM(a, b) {
  // a, b: [lat, lng]
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

// ---- local flat frame (metres) around an origin, good to well under 1% at lake scale
function makeFrame([lat0, lng0]) {
  const kx = Math.cos(toRad(lat0)) * 111320
  const ky = 110540
  return {
    toXY: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky],
    toLngLat: ([x, y]) => [lng0 + x / kx, lat0 + y / ky],
  }
}

// Largest polygon of a (Multi)Polygon feature, as a Polygon feature.
function largestPolygon(feat) {
  if (!feat?.geometry) return null
  const g = feat.geometry
  if (g.type === 'Polygon') return feat
  if (g.type !== 'MultiPolygon') return null
  let best = null
  let bestA = -1
  for (const coords of g.coordinates) {
    const f = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } }
    const a = area(f)
    if (a > bestA) {
      bestA = a
      best = f
    }
  }
  return best
}

// Shrink the outline inward so the drone stays over water, backing off the
// inset for small ponds rather than failing.
function insetPolygon(poly, insetM) {
  for (const d of [insetM, insetM / 2, insetM / 4]) {
    if (d <= 0.5) break
    try {
      const b = largestPolygon(buffer(poly, -d, { units: 'meters' }))
      if (b && area(b) > 50) return { poly: b, inset: d }
    } catch {
      /* buffer can fail on odd geometry — try a smaller inset */
    }
  }
  return { poly, inset: 0 }
}

/**
 * Clip a huge water body (river, reservoir) to a working circle around `ref`
 * ([lat,lng]) so the plan stays a sensible size. Returns { poly, clipped }.
 */
export function clipToWorkArea(poly, ref, radiusM = WORK_RADIUS_M) {
  const pts = poly.geometry.coordinates[0]
  const far = pts.some(([lng, lat]) => distanceM(ref, [lat, lng]) > radiusM)
  if (!far) return { poly, clipped: false }
  try {
    const c = circle([ref[1], ref[0]], radiusM, { units: 'meters', steps: 64 })
    const cut = largestPolygon(intersect(featureCollection([poly, c])))
    if (cut) return { poly: cut, clipped: true }
  } catch {
    /* fall through */
  }
  return { poly, clipped: false }
}

// Rotate the ring index so the loop starts at the vertex nearest `home`.
function startNearest(ptsLatLng, home) {
  if (!home || !ptsLatLng.length) return ptsLatLng
  let bi = 0
  let bd = Infinity
  ptsLatLng.forEach((p, i) => {
    const d = distanceM(home, p)
    if (d < bd) {
      bd = d
      bi = i
    }
  })
  return [...ptsLatLng.slice(bi), ...ptsLatLng.slice(0, bi)]
}

// True if the straight leg a→b ([lat,lng]) stays over water: sampled every ~4 m.
export function legInside(a, b, poly) {
  const n = Math.max(1, Math.ceil(distanceM(a, b) / 4))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const lat = a[0] + (b[0] - a[0]) * t
    const lng = a[1] + (b[1] - a[1]) * t
    if (!booleanPointInPolygon(point([lng, lat]), poly)) return false
  }
  return true
}

// Points every `stepM` metres along a closed ring of [lng,lat] → [[lat,lng], ...] (open, no repeat).
function densifyRing(ring, stepM) {
  const out = []
  for (let i = 0; i < ring.length - 1; i++) {
    const a = [ring[i][1], ring[i][0]]
    const b = [ring[i + 1][1], ring[i + 1][0]]
    const n = Math.max(1, Math.ceil(distanceM(a, b) / stepM))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

/** Loop just inside the shoreline, every leg kept over water. Returns [[lat,lng], ...]. */
export function shorelinePattern(poly, { insetM = 10, spacingM, home } = {}) {
  const inner = insetPolygon(poly, insetM).poly
  const ring = inner.geometry.coordinates[0]
  const total = length(lineString(ring), { units: 'meters' })
  const step = Math.max(3, total / 1500) // dense path along the inset shore
  const dense = startNearest(densifyRing(ring, step), home)
  const want = spacingM || Math.max(25, total / 24)
  // Greedy: from each point, jump as far along the shore as possible (up to the
  // wanted spacing, or longer if needed to fit) without the leg crossing land.
  for (const factor of [1, 1.6, 2.5, 4]) {
    const maxStep = Math.max(2, Math.round((want * factor) / step))
    const wps = [dense[0]]
    let i = 0
    while (i < dense.length - 1) {
      let j = Math.min(i + maxStep, dense.length - 1)
      while (j > i + 1 && !legInside(dense[i], dense[j], poly)) j--
      wps.push(dense[j])
      i = j
    }
    if (wps.length + 1 <= MAX_WAYPOINTS) return [...wps, wps[0]] // close the loop back at the start
  }
  return [] // shore too convoluted to fit the waypoint cap — caller shrinks the area
}

// Principal (long) axis angle of a set of XY points, radians.
function longAxis(xy) {
  const mx = xy.reduce((a, p) => a + p[0], 0) / xy.length
  const my = xy.reduce((a, p) => a + p[1], 0) / xy.length
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const [x, y] of xy) {
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
    sxy += (x - mx) * (y - my)
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy)
}

/** Back-and-forth sweep over ONE connected stretch of water (never jumping
 *  across land between separate arms/bays). Returns { waypoints, spacingM, partial }. */
export function sweepPattern(poly, { insetM = 10, spacingM = 20, home } = {}) {
  const inner = insetPolygon(poly, insetM).poly
  const [c0lng, c0lat] = inner.geometry.coordinates[0][0]
  const frame = makeFrame([c0lat, c0lng])
  const rings = inner.geometry.coordinates.map((ring) => ring.map(frame.toXY)) // outer + holes (islands)
  const theta = longAxis(rings[0])
  const cos = Math.cos(-theta)
  const sin = Math.sin(-theta)
  const rot = ([x, y]) => [x * cos - y * sin, x * sin + y * cos]
  const unrot = ([x, y]) => [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)]
  const rr = rings.map((r) => r.map(rot)) // long axis now along X
  const ys = rr[0].map((p) => p[1])
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const toLatLng = (p) => {
    const [lng, lat] = frame.toLngLat(unrot(p))
    return [lat, lng]
  }

  let spacing = Math.max(5, spacingM)
  for (let attempt = 0; attempt < 12; attempt++) {
    // Inside segments of every lane (scanline, even-odd so islands are respected).
    const lanes = []
    for (let y = minY + spacing / 2; y < maxY; y += spacing) {
      const xs = []
      for (const ring of rr) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [ax, ay] = ring[i]
          const [bx, by] = ring[i + 1]
          if (ay <= y !== by <= y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay))
        }
      }
      xs.sort((a, b) => a - b)
      const segs = []
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] >= 3) segs.push([xs[i], xs[i + 1]])
      lanes.push({ y, segs })
    }
    // Seed on the longest segment anywhere, then grow up and down lane by lane,
    // each time taking the segment that overlaps the previous one most, so the
    // sweep stays in one connected body of water. Stop where it no longer connects.
    let seed = null
    lanes.forEach((l, li) =>
      l.segs.forEach((sg) => {
        if (!seed || sg[1] - sg[0] > seed.sg[1] - seed.sg[0]) seed = { li, sg }
      }),
    )
    if (!seed) return { waypoints: [], spacingM: Math.round(spacing) }
    const pickNext = (prev, lane) => {
      let best = null
      let bestOv = 0
      for (const sg of lane.segs) {
        const ov = Math.min(prev[1], sg[1]) - Math.max(prev[0], sg[0])
        if (ov > bestOv) {
          bestOv = ov
          best = sg
        }
      }
      return best
    }
    const chain = [{ y: lanes[seed.li].y, sg: seed.sg }]
    for (let li = seed.li + 1, prev = seed.sg; li < lanes.length; li++) {
      const sg = pickNext(prev, lanes[li])
      if (!sg) break
      chain.push({ y: lanes[li].y, sg })
      prev = sg
    }
    for (let li = seed.li - 1, prev = seed.sg; li >= 0; li--) {
      const sg = pickNext(prev, lanes[li])
      if (!sg) break
      chain.unshift({ y: lanes[li].y, sg })
      prev = sg
    }
    // Serpentine through the chain; end early if a turn between lanes would cross land.
    const wps = []
    let flip = false
    let truncated = false
    for (const { y, sg } of chain) {
      const a = toLatLng([sg[0], y])
      const b = toLatLng([sg[1], y])
      const pair = flip ? [b, a] : [a, b]
      if (wps.length && !legInside(wps[wps.length - 1], pair[0], poly)) {
        truncated = true
        break
      }
      wps.push(...pair)
      flip = !flip
    }
    if (wps.length <= MAX_WAYPOINTS) {
      // Start from whichever end is nearer home.
      if (home && wps.length > 1 && distanceM(home, wps[wps.length - 1]) < distanceM(home, wps[0])) wps.reverse()
      const partial = truncated || chain.length < lanes.filter((l) => l.segs.length).length
      return { waypoints: wps, spacingM: Math.round(spacing), partial }
    }
    spacing *= 1.3 // too many turns: widen the lanes and retry
  }
  return { waypoints: [], spacingM: Math.round(spacing) }
}

/**
 * Shared safety-envelope check for a set of waypoints (any pattern — shoreline,
 * sweep, or a hotspot visit list). Returns { ok, altitude, speedKmh, lengthM,
 * minutes, warnings, reason? } — never throws.
 * `poly` is optional: if given, checks every waypoint stays inside it and every
 * leg stays over water (warnings only, non-fatal). Pass null for free-form
 * hotspot missions where there's no water polygon to constrain to.
 */
export function validatePlan(home, waypoints, { poly, altitude = 10, speedKmh = 5 } = {}) {
  if (!waypoints || !waypoints.length) return { ok: false, reason: 'No waypoints to fly.' }
  if (waypoints.length > MAX_WAYPOINTS) {
    return { ok: false, reason: `Too many waypoints (${waypoints.length}, cap ${MAX_WAYPOINTS}).` }
  }
  const warnings = []
  const alt = Math.max(2, Math.min(MAX_ALT, Number(altitude) || 10))
  const spd = Math.max(1, Math.min(MAX_SPEED, Number(speedKmh) || 5))
  if (Number(altitude) > MAX_ALT) warnings.push(`Altitude capped at ${MAX_ALT} m.`)
  if (Number(speedKmh) > MAX_SPEED) warnings.push(`Speed capped at ${MAX_SPEED} km/h.`)
  if (poly) {
    const outside = waypoints.filter(([lat, lng]) => !booleanPointInPolygon(point([lng, lat]), poly)).length
    if (outside) warnings.push(`${outside} waypoint(s) sit right on the shoreline — check them on the map.`)
    let overLand = 0
    for (let i = 1; i < waypoints.length; i++) if (!legInside(waypoints[i - 1], waypoints[i], poly)) overLand++
    if (overLand) warnings.push(`${overLand} leg(s) cut over the shore — check them on the map.`)
  }
  if (home) {
    const far = Math.max(...waypoints.map((w) => distanceM(home, w)))
    if (far > MAX_RANGE_M) {
      return { ok: false, reason: `That is ${(far / 1000).toFixed(1)} km from home — over the ${MAX_RANGE_M / 1000} km safety limit. Move closer or pick a nearer spot.` }
    }
  }
  const est = estimateFlight(home, waypoints, { altitude: alt, speedKmh: spd })
  if (est.minutes > LONG_FLIGHT_MIN) warnings.push(`Estimated ${est.minutes} min of flight — longer than ${LONG_FLIGHT_MIN} min; check the battery or raise the speed.`)
  return { ok: true, altitude: alt, speedKmh: spd, lengthM: est.lengthM, minutes: est.minutes, warnings }
}

/** Path length (m) home → waypoints → home, and estimated flight time (min) incl. climb + landing. */
export function estimateFlight(home, waypoints, { altitude = 10, speedKmh = 5 } = {}) {
  let d = 0
  let prev = home || waypoints[0]
  for (const w of waypoints) {
    if (prev) d += distanceM(prev, w)
    prev = w
  }
  let cruise = d / (speedKmh / 3.6)
  // ...and the flight back home afterwards (RTL speed, like the simulator/autopilot).
  if (home && prev) {
    const back = distanceM(prev, home)
    d += back
    cruise += back / (RTL_SPEED_KMH / 3.6)
  }
  const vertical = (2 * altitude) / CLIMB_RATE
  return { lengthM: Math.round(d), minutes: Math.round(((cruise + vertical) / 60) * 10) / 10 }
}

/** Pick a pattern from the operator's words when they didn't name one. */
export function choosePattern(requested, intentText, poly) {
  if (requested === 'shoreline' || requested === 'sweep') return requested
  const t = (intentText || '').toLowerCase()
  if (/(edge|shore|bank|border|perimeter|around|kinar|kinaar|kinaare|kinare|kinaron|chaaro|chaaron)/.test(t)) return 'shoreline'
  if (/(whole|entire|full|cover|everything|all over|poora|pura|poori|puri|sab|saara|sara|sweep|grid|zig)/.test(t)) return 'sweep'
  // Small water → full coverage is cheap; big water → shoreline, where trash collects.
  return area(poly) < 40000 ? 'sweep' : 'shoreline'
}

/**
 * Build a full plan from a water-body outline.
 * @returns {{ok:true, waypoints, pattern, lengthM, minutes, spacingM, warnings:string[]}|{ok:false, reason:string}}
 */
export function buildPlan(poly, { pattern = 'auto', intentText = '', home, altitude = 10, speedKmh = 5, spacingM, insetM = 10 } = {}) {
  if (!poly) return { ok: false, reason: 'No water-body outline to plan on.' }
  const chosen = choosePattern(pattern, intentText, poly)
  let waypoints
  let usedSpacing = spacingM
  const patternWarnings = []
  if (chosen === 'shoreline') {
    waypoints = shorelinePattern(poly, { insetM, spacingM, home })
  } else {
    const r = sweepPattern(poly, { insetM, spacingM: spacingM || 20, home })
    waypoints = r.waypoints
    usedSpacing = r.spacingM
    if (r.partial) patternWarnings.push('The water is split by land (arms / islands), so the sweep covers one connected part.')
    if (spacingM && r.spacingM > spacingM) patternWarnings.push(`Lane spacing widened to ${r.spacingM} m to stay within ${MAX_WAYPOINTS} waypoints.`)
  }
  if (!waypoints.length) return { ok: false, reason: 'The water area is too small or oddly shaped to fit a flight path.' }

  const v = validatePlan(home, waypoints, { poly, altitude, speedKmh })
  if (!v.ok) return v
  return { ok: true, waypoints, pattern: chosen, altitude: v.altitude, speedKmh: v.speedKmh, spacingM: usedSpacing, lengthM: v.lengthM, minutes: v.minutes, warnings: [...patternWarnings, ...v.warnings] }
}
