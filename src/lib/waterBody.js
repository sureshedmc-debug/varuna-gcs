// Finds real water-body outlines (lakes, ponds, reservoirs, rivers) from
// OpenStreetMap, for the AI assistant's mission planning:
//   - by name        → Nominatim search (e.g. "Hussain Sagar")
//   - "this lake"    → Overpass: water polygons around a point (drone / laptop / map centre)
// Returns GeoJSON Polygon features ([lng,lat] coords) that missionPatterns.js
// turns into waypoints. Results are cached, and Nominatim is kept to ≤1 req/s
// per its usage policy.

import { area } from '@turf/area'
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon'
import { circle } from '@turf/circle'
import { point } from '@turf/helpers'
import { distanceM } from './missionPatterns'

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
// Public Overpass servers are often overloaded (HTTP 429/504); try mirrors in turn.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
const WATER_TYPES = /^(water|lake|reservoir|pond|basin|lagoon|river|riverbank|canal|bay|wetland|oxbow|stream_pool)$/
const cache = new Map()
let lastNominatim = 0

async function politeFetch(url, opts) {
  const wait = 1100 - (Date.now() - lastNominatim)
  if (url.startsWith(NOMINATIM) && wait > 0) await new Promise((r) => setTimeout(r, wait))
  if (url.startsWith(NOMINATIM)) lastNominatim = Date.now()
  // Never let one slow server hang the assistant: give up after 15 s.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    if (!res.ok) throw new Error(`Map lookup failed (HTTP ${res.status})`)
    return await res.json()
  } catch (e) {
    throw e?.name === 'AbortError' ? new Error('Map lookup timed out') : e
  } finally {
    clearTimeout(timer)
  }
}

function feature(coords, name) {
  return { type: 'Feature', properties: { name: name || '' }, geometry: { type: 'Polygon', coordinates: coords } }
}

// Largest polygon of a GeoJSON geometry as a Polygon feature (outer ring + holes).
function toPolygon(geom, name) {
  if (!geom) return null
  if (geom.type === 'Polygon') return feature(geom.coordinates, name)
  if (geom.type === 'MultiPolygon') {
    let best = null
    for (const c of geom.coordinates) {
      const f = feature(c, name)
      if (!best || area(f) > area(best)) best = f
    }
    return best
  }
  return null
}

function centroidOf(poly) {
  const ring = poly.geometry.coordinates[0]
  const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length
  const lng = ring.reduce((a, p) => a + p[0], 0) / ring.length
  return [lat, lng]
}

// Distance (m) from a [lat,lng] to a polygon: 0 if inside, else to its nearest vertex.
function distanceToPoly(ref, poly) {
  if (booleanPointInPolygon(point([ref[1], ref[0]]), poly)) return 0
  let best = Infinity
  for (const [lng, lat] of poly.geometry.coordinates[0]) best = Math.min(best, distanceM(ref, [lat, lng]))
  return best
}

function summarize(poly, name, ref, source) {
  const ring = poly.geometry.coordinates[0]
  let perim = 0
  for (let i = 1; i < ring.length; i++) perim += distanceM([ring[i - 1][1], ring[i - 1][0]], [ring[i][1], ring[i][0]])
  return {
    name: name || 'Unnamed water',
    poly,
    areaM2: Math.round(area(poly)),
    perimeterM: Math.round(perim),
    centre: centroidOf(poly),
    distanceM: ref ? Math.round(distanceToPoly(ref, poly)) : null,
    source,
  }
}

/** Search water bodies by name, nearest to `ref` ([lat,lng]) first. */
export async function findWaterByName(name, ref) {
  const key = `n:${name}:${ref ? ref.map((v) => v.toFixed(2)).join(',') : ''}`
  if (cache.has(key)) return cache.get(key)
  const params = new URLSearchParams({ q: name, format: 'jsonv2', polygon_geojson: '1', limit: '8' })
  if (ref) {
    // Bias (not restrict) results toward the operator's area.
    const d = 0.5
    params.set('viewbox', `${ref[1] - d},${ref[0] + d},${ref[1] + d},${ref[0] - d}`)
  }
  const list = await politeFetch(`${NOMINATIM}?${params}`, { headers: { Accept: 'application/json' } })
  const out = []
  for (const r of list || []) {
    const isWater = r.category === 'natural' || r.category === 'water' || r.category === 'waterway' || r.category === 'landuse'
    if (!isWater || !WATER_TYPES.test(r.type || '')) continue
    const poly = toPolygon(r.geojson, r.name)
    if (!poly) continue
    out.push(summarize(poly, r.name || r.display_name?.split(',')[0], ref, 'name'))
  }
  out.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
  cache.set(key, out)
  return out
}

// Stitch OSM way geometries into closed rings (for multipolygon relations).
function stitchRings(ways) {
  const segs = ways.map((w) => w.map((p) => [p.lon, p.lat])).filter((s) => s.length > 1)
  const rings = []
  const same = (a, b) => a[0] === b[0] && a[1] === b[1]
  while (segs.length) {
    let ring = segs.shift()
    let grew = true
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        const end = ring[ring.length - 1]
        if (same(end, s[0])) ring = ring.concat(s.slice(1))
        else if (same(end, s[s.length - 1])) ring = ring.concat(s.slice(0, -1).reverse())
        else continue
        segs.splice(i, 1)
        grew = true
        break
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring)
  }
  return rings
}

/** Water polygons around `ref` ([lat,lng]); the one containing it (else the nearest) first. */
export async function findWaterNear(ref, radiusM = 1500) {
  const key = `p:${ref.map((v) => v.toFixed(4)).join(',')}:${radiusM}`
  if (cache.has(key)) return cache.get(key)
  const [lat, lng] = ref
  const q = `[out:json][timeout:25];
(
  way["natural"="water"](around:${radiusM},${lat},${lng});
  relation["natural"="water"](around:${radiusM},${lat},${lng});
  way["landuse"="reservoir"](around:${radiusM},${lat},${lng});
  way["waterway"="riverbank"](around:${radiusM},${lat},${lng});
);
out geom;`
  let json = null
  let lastErr = null
  for (const url of OVERPASS) {
    try {
      json = await politeFetch(url, { method: 'POST', body: new URLSearchParams({ data: q }) })
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!json) throw new Error(`The OpenStreetMap lake lookup is busy right now (${lastErr?.message || 'no response'}). Try again in a minute, or name the lake.`)
  const out = []
  for (const el of json?.elements || []) {
    const name = el.tags?.name || el.tags?.['name:en'] || ''
    let rings = []
    if (el.type === 'way' && el.geometry) rings = stitchRings([el.geometry])
    else if (el.type === 'relation' && el.members) rings = stitchRings(el.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry))
    for (const ring of rings) {
      const poly = feature([ring], name)
      if (area(poly) < 150) continue // ignore puddles / fountains
      out.push(summarize(poly, name, ref, 'nearby'))
    }
  }
  out.sort((a, b) => a.distanceM - b.distanceM || b.areaM2 - a.areaM2)
  cache.set(key, out)
  return out
}

/** A circular work area around a point — for "plan 100 m around here" when there's no mapped lake. */
export function circleArea(ref, radiusM) {
  const poly = circle([ref[1], ref[0]], radiusM, { units: 'meters', steps: 48 })
  return summarize(poly, `Area ${Math.round(radiusM)} m around the point`, ref, 'circle')
}
