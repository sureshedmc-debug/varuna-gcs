// Downloads the centre line of every river in public/config/rivers.json from
// OpenStreetMap, around each river's catalog centre, into
// public/config/river-lines.json. The app ships that file, so Live Mission
// Plan can auto-plan these rivers with no internet. Rivers added later to
// rivers.csv are still planned online.
//
// Run with `npm run river-lines` (needs internet). Data © OpenStreetMap
// contributors, ODbL — keep the attribution in the output file.

import { readFileSync, writeFileSync } from 'node:fs'

const RADIUS_M = 8000 // 20 sections × 600 m = 12 km of river, plus slack
const UA = 'VarunaGCS/2.0 (build-time river data; +https://www.openstreetmap.org/copyright)'
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'

const R = 6371000
const rad = (d) => (d * Math.PI) / 180
const dist = (a, b) => {
  const s = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}
const norm = (s) => String(s || '').normalize('NFD').toLowerCase().replace(/[^a-z]/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// "Ghaghara (Saryu)" → ["ghaghara", "saryu"]
const namesOf = (river) => river.name.split(/[()/,]/).map(norm).filter((n) => n.length >= 3)

async function getJson(url, opts = {}, ms = 30000) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function overpassLines(river) {
  const [lat, lng] = river.center
  const q = `[out:json][timeout:55];way["waterway"~"^(river|canal|drain)$"](around:${RADIUS_M},${lat},${lng});out geom;`
  try {
    // The public servers are often slow or overloaded: ask them all at once.
    const json = await Promise.any(OVERPASS.map((url) => getJson(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, 60000)))
    const want = namesOf(river)
    const ways = (json.elements || []).filter((e) => e.type === 'way' && e.geometry?.length > 1)
    const named = ways.filter((e) => [e.tags?.name, e.tags?.['name:en'], e.tags?.alt_name].some((n) => want.some((w) => norm(n).includes(w))))
    return named.map((e) => e.geometry.map((p) => [p.lat, p.lon]))
  } catch (e) {
    console.warn(`  overpass: ${e.errors?.map((x) => x.message).join(', ') || e.message}`)
    return []
  }
}

async function nominatimLines(river) {
  const [lat, lng] = river.center
  const d = 0.3
  for (const n of river.name.split(/[()]/).map((s) => s.trim()).filter(Boolean)) {
    const params = new URLSearchParams({
      q: /river|drain|canal|nadi/i.test(n) ? n : `${n} river`, format: 'jsonv2', polygon_geojson: '1', polygon_threshold: '0.0001', limit: '10',
      viewbox: [lng - d, lat + d, lng + d, lat - d].join(','), bounded: '1',
    })
    await sleep(1200) // Nominatim usage policy: at most one request a second
    try {
      const hits = await getJson(`${NOMINATIM}?${params}`)
      const lines = []
      for (const h of hits) {
        if (h.category !== 'waterway') continue
        const g = h.geojson
        const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []
        for (const p of parts) if (p.length > 1) lines.push(p.map(([x, y]) => [y, x]))
      }
      if (lines.length) return lines
    } catch (e) {
      console.warn(`  nominatim: ${e.message}`)
    }
  }
  return []
}

// Keep only the parts of each line within RADIUS_M of the centre.
function clip(lines, c) {
  const out = []
  for (const line of lines) {
    let cur = []
    for (const p of line) {
      if (dist(c, p) <= RADIUS_M) cur.push(p)
      else if (cur.length) (cur.length > 1 && out.push(cur), (cur = []))
    }
    if (cur.length > 1) out.push(cur)
  }
  return out
}

// Douglas–Peucker, ~4 m tolerance, in a local metre frame.
function simplify(line, tol = 4) {
  if (line.length < 3) return line
  const kx = Math.cos(rad(line[0][0])) * 111320
  const xy = line.map(([la, ln]) => [ln * kx, la * 110540])
  const keep = new Uint8Array(line.length)
  keep[0] = keep[line.length - 1] = 1
  const stack = [[0, line.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = xy[a]
    const [bx, by] = xy[b]
    const L = Math.hypot(bx - ax, by - ay) || 1
    let best = -1
    let bi = -1
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / L
      if (d > best) (best = d), (bi = i)
    }
    if (best > tol) {
      keep[bi] = 1
      stack.push([a, bi], [bi, b])
    }
  }
  return line.filter((_, i) => keep[i]).map(([la, ln]) => [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5])
}

const catalog = JSON.parse(readFileSync('public/config/rivers.json', 'utf8'))
const out = {
  _comment: 'River centre lines around each catalog centre, for offline Live Mission Plan. Generated by scripts/fetch-river-lines.mjs.',
  attribution: '© OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright',
  radiusM: RADIUS_M,
  generatedAt: new Date().toISOString(),
  rivers: {},
}
for (const state of catalog.states) {
  for (const river of state.rivers) {
    if (!river.center) continue
    process.stdout.write(`${river.id} … `)
    let lines = clip(await nominatimLines(river), river.center)
    let source = 'nominatim'
    if (!lines.some((l) => l.some((p) => dist(river.center, p) < 3000))) {
      lines = clip(await overpassLines(river), river.center)
      source = 'overpass'
    }
    lines = lines.map((l) => simplify(l)).filter((l) => l.length > 1)
    const near = lines.length ? Math.min(...lines.flat().map((p) => dist(river.center, p))) : Infinity
    if (!lines.length || near > 3000) {
      console.log(`not found near the centre${lines.length ? ` (nearest ${Math.round(near)} m)` : ''} — left to online planning`)
      continue
    }
    out.rivers[river.id] = lines
    console.log(`${lines.length} line(s), ${lines.reduce((n, l) => n + l.length, 0)} points via ${source}, ${Math.round(near)} m from centre`)
  }
}
writeFileSync('public/config/river-lines.json', JSON.stringify(out))
console.log(`wrote public/config/river-lines.json (${Object.keys(out.rivers).length} rivers)`)
