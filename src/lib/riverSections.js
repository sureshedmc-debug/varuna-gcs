// Auto-plans a Live Mission Plan: takes the river's mapped centre line from
// OpenStreetMap around the catalog centre point, picks a stretch of it and cuts
// that into the number of sections the operator asked for. Each section becomes
// a waypoint path down the middle of the river, which the Missions planner
// loads for review (the operator still does Save → Upload → Start).

import { distanceM, MAX_WAYPOINTS, validatePlan } from './missionPatterns'

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
// Length of river per section: about 8 min at the planner's default 5 km/h,
// so a section stays well inside the 15 min flight-time warning.
export const SECTION_M = 600
const WP_STEP_M = 40 // waypoint spacing along the river

const cancelled = () => Object.assign(new Error('Cancelled'), { code: 'cancelled' })

async function getJson(url, opts, signal, ms) {
  const ctrl = new AbortController()
  const stop = () => ctrl.abort()
  signal?.addEventListener('abort', stop)
  const timer = setTimeout(stop, ms)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    if (signal?.aborted) throw cancelled()
    throw e?.name === 'AbortError' ? new Error('timed out') : e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

const norm = (s) => String(s || '').normalize('NFD').toLowerCase().replace(/[^a-z]/g, '')

// Every lookup covers the largest plan (20 sections), so one result serves any
// section count and can be kept. Matches scripts/fetch-river-lines.mjs.
const LOOKUP_RADIUS_M = Math.round((20 * SECTION_M) / 2 + 1500)

// Catalog rivers ship with their centre line (public/config/river-lines.json,
// from scripts/fetch-river-lines.mjs), so they plan instantly, with or without
// internet. Only rivers added later (rivers.csv) are looked up online.
let bundled = null
async function bundledLines(id) {
  bundled ||= fetch('/config/river-lines.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const all = await bundled
  if (!all) bundled = null // try again next time
  return all?.rivers?.[id] || null
}

// Online lookups are remembered (in memory and on this PC), so a river is only
// fetched once. Lines are kept to 6 decimals (~10 cm).
const CACHE_KEY = 'varuna.riverLines'
const CACHE_MAX = 30
const memo = new Map() // key -> Promise<ways>
const riverKey = (river) => `${norm(river.name)}@${river.center[0].toFixed(3)},${river.center[1].toFixed(3)}`
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {} } catch { return {} }
}
function writeCache(key, ways) {
  try {
    const all = readCache()
    delete all[key]
    all[key] = { at: Date.now(), ways: ways.map((l) => l.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)])) }
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete all[k]
    localStorage.setItem(CACHE_KEY, JSON.stringify(all))
  } catch { /* storage full or blocked: still works, just not remembered */ }
}

// Nominatim: the whole named river, simplified (usually ~1 s).
async function nominatimWays(river, signal) {
  const c = river.center
  const d = 0.3
  const base = river.name.split('(')[0].trim()
  // "Rapti river" can miss the stretch that plain "Rapti" finds, so try both.
  const queries = /river|nadi|canal|drain/i.test(base) ? [base] : [`${base} river`, base]
  for (const [i, q] of queries.entries()) {
    if (i) await sleep(1000, signal) // Nominatim usage policy: one request a second
    if (signal?.aborted) throw cancelled()
    const params = new URLSearchParams({
      q, format: 'jsonv2', polygon_geojson: '1', polygon_threshold: '0.0002', limit: '10',
      viewbox: [c[1] - d, c[0] + d, c[1] + d, c[0] - d].join(','),
    })
    const hits = await getJson(`${NOMINATIM}?${params}`, {}, signal, 10000)
    const lines = []
    for (const h of hits || []) {
      if (h.category !== 'waterway' || !/^(river|canal)$/.test(h.type)) continue
      const g = h.geojson
      const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []
      for (const p of parts) if (p.length > 1) lines.push(p.map(([lng, lat]) => [lat, lng]))
    }
    // Only if it actually passes near the catalog point.
    if (lines.some((l) => l.some((p) => distanceM(c, p) < 3000))) return lines
  }
  return null
}

// Overpass: the river ways around the point (all mirrors at once: the public
// servers are often slow). Prefers ways carrying this river's name.
async function overpassWays(river, signal) {
  const c = river.center
  const q = `[out:json][timeout:20];
way["waterway"~"^(river|canal)$"](around:${LOOKUP_RADIUS_M},${c[0]},${c[1]});
out geom;`
  const ctrl = new AbortController()
  const stop = () => ctrl.abort()
  signal?.addEventListener('abort', stop)
  try {
    const json = await Promise.any(OVERPASS.map((url) => getJson(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, ctrl.signal, 22000)))
    const all = (json?.elements || []).filter((e) => e.type === 'way' && e.geometry?.length > 1)
    if (!all.length) throw Object.assign(new Error(`No river centre line is mapped near ${river.name}'s catalog position.`), { final: true })
    const want = norm(river.name)
    const named = all.filter((e) => [e.tags?.name, e.tags?.['name:en']].some((n) => norm(n).includes(want) || (want && want.includes(norm(n)) && norm(n))))
    return (named.length ? named : all).map((e) => e.geometry.map((p) => [p.lat, p.lon]))
  } catch (e) {
    if (signal?.aborted) throw cancelled()
    if (e.final) throw e
    const why = e.errors?.[0]?.message || e.message || 'no response'
    throw new Error(`The OpenStreetMap river lookup is busy right now (${why}). Try again in a minute.`)
  } finally {
    ctrl.abort() // the other mirrors are no longer needed
    signal?.removeEventListener('abort', stop)
  }
}

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
})

// Online: Nominatim first; if it hasn't answered within 2 s (or has nothing),
// Overpass runs alongside it and the first usable answer wins.
async function onlineWays(river, signal) {
  const ctrl = new AbortController()
  const stop = () => ctrl.abort()
  signal?.addEventListener('abort', stop)
  try {
    const nomi = nominatimWays(river, ctrl.signal).catch((e) => { if (e.code === 'cancelled') throw e; return null })
    const early = await Promise.race([nomi, sleep(2000, ctrl.signal).then(() => undefined)])
    if (early) return early
    if (signal?.aborted) throw cancelled()
    const over = overpassWays(river, ctrl.signal)
    // The first usable answer wins; Overpass's error is the one to report if both come up empty.
    return await new Promise((resolve, reject) => {
      let left = 2
      let err = null
      const settle = (ways) => (ways ? resolve(ways) : --left === 0 && reject(err || new Error('No river line found here.')))
      nomi.then(settle, (e) => { err = e; settle(null) })
      over.then(settle, (e) => { err = e.code === 'cancelled' ? err || e : e; settle(null) })
    })
  } finally {
    ctrl.abort()
    signal?.removeEventListener('abort', stop)
  }
}

// The river as lines of [lat,lng]: the bundled copy, else remembered, else online.
async function riverLines(river, signal) {
  const own = river.id && (await bundledLines(river.id))
  if (own?.length) return own
  const key = riverKey(river)
  const kept = readCache()[key]
  if (kept?.ways?.length) return kept.ways
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(`${river.name} isn't in the offline river list, so planning it needs the internet. Connect, or plan the route by hand.`)
  }
  // One lookup per river at a time: a prefetch and the Plan press share it.
  let job = memo.get(key)
  if (!job) {
    job = onlineWays(river).then((ways) => { writeCache(key, ways); return ways })
    job.catch(() => memo.delete(key)) // a failure isn't kept: try again next time
    memo.set(key, job)
  }
  if (!signal) return job
  return await Promise.race([job, new Promise((_, rej) => signal.addEventListener('abort', () => rej(cancelled()), { once: true }))])
}

/** Start looking up a river's line in the background (e.g. as soon as it is picked). */
export function prefetchRiver(river) {
  if (!river?.center) return
  riverLines(river).catch(() => {})
}


// Chain OSM ways ([[lat,lng]...]) that share end points into longer lines.
function chainWays(ways) {
  const segs = ways.map((w) => w.slice())
  const lines = []
  const same = (a, b) => a[0] === b[0] && a[1] === b[1]
  while (segs.length) {
    let line = segs.shift()
    let grew = true
    while (grew) {
      grew = false
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        const a = line[0]
        const b = line[line.length - 1]
        if (same(b, s[0])) line = line.concat(s.slice(1))
        else if (same(b, s[s.length - 1])) line = line.concat(s.slice(0, -1).reverse())
        else if (same(a, s[s.length - 1])) line = s.slice(0, -1).concat(line)
        else if (same(a, s[0])) line = s.slice(1).reverse().concat(line)
        else continue
        segs.splice(i, 1)
        grew = true
        break
      }
    }
    lines.push(line)
  }
  return lines
}

// Cumulative distance (m) at each vertex.
function chainage(line) {
  const d = [0]
  for (let i = 1; i < line.length; i++) d.push(d[i - 1] + distanceM(line[i - 1], line[i]))
  return d
}

// Point at distance `at` along the line.
function pointAt(line, cum, at) {
  let i = 1
  while (i < line.length - 1 && cum[i] < at) i++
  const seg = cum[i] - cum[i - 1] || 1
  const t = Math.max(0, Math.min(1, (at - cum[i - 1]) / seg))
  return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]
}

/**
 * Plan `sections` sections of `river` ({name, center:[lat,lng]}).
 * Resolves to [{section, waypoints:[[lat,lng]], lengthM, minutes, warnings}].
 */
export async function planRiverSections(river, sections, { signal, altitude = 10, speedKmh = 5 } = {}) {
  const c = river?.center
  if (!c) throw new Error('This river has no map position in the catalog, so it can’t be planned automatically.')
  const total = sections * SECTION_M
  const ways = await riverLines(river, signal)

  // The chain passing closest to the catalog point, and where along it that is.
  let best = null
  for (const line of chainWays(ways)) {
    const cum = chainage(line)
    line.forEach((p, i) => {
      const d = distanceM(c, p)
      if (!best || d < best.d) best = { d, line, cum, at: cum[i] }
    })
  }
  const { line, cum } = best
  const len = cum[cum.length - 1]
  const span = Math.min(total, len)
  let start = Math.max(0, best.at - span / 2)
  if (start + span > len) start = Math.max(0, len - span)
  const per = span / sections
  const warnings = []
  if (span < total) warnings.push(`Only ${(len / 1000).toFixed(1)} km of this river is mapped here, so each section is ${Math.round(per)} m.`)

  const out = []
  for (let s = 0; s < sections; s++) {
    const a = start + s * per
    const n = Math.min(MAX_WAYPOINTS, Math.max(2, Math.round(per / WP_STEP_M) + 1))
    const waypoints = Array.from({ length: n }, (_, k) => pointAt(line, cum, a + (per * k) / (n - 1)))
    const v = validatePlan(null, waypoints, { altitude, speedKmh })
    out.push({ section: s + 1, waypoints, lengthM: Math.round(per), minutes: v.minutes ?? 0, warnings: [...warnings, ...(v.warnings || [])] })
  }
  return out
}
