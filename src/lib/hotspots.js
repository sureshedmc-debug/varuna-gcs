// Cluster geotagged trash sightings into hotspots.
//
// Sightings from trashLog.js are already merged at ~5 m (with GPS-accuracy
// widening) — this file groups those merged points into coarser buckets
// suitable for planning a mission over "the worst spots" or building a
// collection route. The output is deterministic and depends only on the
// current trash log (no random ordering).
//
// A hotspot's `weight` combines how many items were seen and how recent the
// sightings were, so a big fresh dump ranks above an old passing sighting.

import { distanceM, validatePlan, MAX_WAYPOINTS } from './missionPatterns'

const RECENCY_MS = 7 * 24 * 60 * 60 * 1000 // one week

function recency(t, now) {
  const age = Math.max(0, now - Number(t || 0))
  return Math.max(0.15, 1 - age / RECENCY_MS)
}

/**
 * Grid-bucket located sightings by ~`cellM` metres.
 * @returns [{ id, lat, lng, weight, itemsTotal, sightingIds:[], lastSeen }]
 * sorted by weight descending.
 */
export function clusterHotspots(sightings = [], { cellM = 25, maxAgeMs } = {}) {
  const now = Date.now()
  const buckets = new Map()
  // Latitude → metres is ~110540; longitude → metres depends on cos(lat).
  const latStep = cellM / 110540
  for (const s of sightings) {
    if (!s || !s.located) continue
    const lat = Number(s.lat)
    const lng = Number(s.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (maxAgeMs && Number(s.lastSeen || s.firstSeen || 0) < now - maxAgeMs) continue
    const lngStep = cellM / (Math.cos((lat * Math.PI) / 180) * 111320 || 1)
    const key = `${Math.round(lat / latStep)}:${Math.round(lng / lngStep)}`
    const items = Math.max(1, Number(s.count) || 1)
    const rec = recency(s.lastSeen || s.firstSeen, now)
    const b = buckets.get(key) || { latSum: 0, lngSum: 0, weightSum: 0, itemsTotal: 0, sightingIds: [], lastSeen: 0 }
    b.latSum += lat * items
    b.lngSum += lng * items
    b.itemsTotal += items
    b.weightSum += items * rec
    b.sightingIds.push(s.id)
    b.lastSeen = Math.max(b.lastSeen, Number(s.lastSeen || s.firstSeen || 0))
    buckets.set(key, b)
  }
  const out = []
  let i = 0
  for (const b of buckets.values()) {
    out.push({
      id: `hs-${++i}`,
      lat: b.latSum / b.itemsTotal,
      lng: b.lngSum / b.itemsTotal,
      weight: b.weightSum,
      itemsTotal: b.itemsTotal,
      sightingIds: b.sightingIds,
      lastSeen: b.lastSeen,
    })
  }
  out.sort((a, b) => b.weight - a.weight)
  return out
}

/** Points for leaflet.heat as [[lat,lng,intensity], ...]. */
export function heatPoints(sightings = []) {
  const now = Date.now()
  const pts = []
  for (const s of sightings) {
    if (!s || !s.located) continue
    const lat = Number(s.lat)
    const lng = Number(s.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const items = Math.max(1, Number(s.count) || 1)
    const intensity = Math.min(1, 0.15 + 0.12 * items) * recency(s.lastSeen || s.firstSeen, now)
    pts.push([lat, lng, intensity])
  }
  return pts
}

/**
 * Build a hotspot mission plan: pick top-N hotspots (by weight), order them
 * nearest-neighbor from `home`, and validate against the same safety envelope
 * as shoreline/sweep plans. Shared by the assistant tool and the Detections
 * "Plan mission on hotspots" button so there's one source of truth.
 * @returns {ok:true, waypoints:[[lat,lng]], altitude, speedKmh, lengthM, minutes, hotspots, warnings}
 *          | {ok:false, reason}
 */
export function buildHotspotPlan(sightings, { home, maxHotspots = 8, altitude = 10, speedKmh = 5, maxAgeMs } = {}) {
  const clusters = clusterHotspots(sightings, { maxAgeMs })
  if (!clusters.length) return { ok: false, reason: 'No trash locations recorded yet — run detection first, then try again.' }
  const nMax = Math.max(1, Math.min(MAX_WAYPOINTS, Math.floor(Number(maxHotspots) || 8)))
  const top = clusters.slice(0, nMax)
  const points = top.map((h) => [h.lat, h.lng])
  const ordered = nearestNeighborRoute(points, home || null)
  const v = validatePlan(home, ordered, { altitude, speedKmh })
  if (!v.ok) return v
  return {
    ok: true,
    waypoints: ordered,
    altitude: v.altitude,
    speedKmh: v.speedKmh,
    lengthM: v.lengthM,
    minutes: v.minutes,
    hotspots: top,
    warnings: v.warnings,
  }
}

/** Nearest-neighbor route order over [lat,lng] points, starting at `start`.
 *  Returns the ordered points (does not include `start`). Ties broken by index. */
export function nearestNeighborRoute(points = [], start = null) {
  const pool = points.slice()
  const out = []
  let cur = start || pool.shift() || null
  if (start && !points.length) return []
  if (!start && cur) out.push(cur)
  while (pool.length) {
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < pool.length; i++) {
      const d = cur ? distanceM(cur, pool[i]) : 0
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    cur = pool.splice(bestI, 1)[0]
    out.push(cur)
  }
  return out
}
