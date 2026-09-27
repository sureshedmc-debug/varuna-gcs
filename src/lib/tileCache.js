// Offline satellite map tiles.
//
// Every map in the app draws Esri World Imagery straight off the internet.
// On a riverbank with no signal that means a black rectangle — precisely
// where knowing the shape of the bank matters most. So every tile the app
// ever displays is also written to IndexedDB, and served from there
// afterwards, forever. Fly an area once with a connection and it stays
// available offline.
//
// An area can also be downloaded ahead of a flight (prefetchArea) rather
// than waiting to have panned over it.
//
// The one rule this must never break: if caching fails for any reason —
// private window, blocked storage, a tile host without CORS headers — the
// map has to behave exactly as it did before, fetching tiles normally.
// Every path here falls back to the plain <img src> the layer used to use.

import { openDb, idbGet, idbPut, idbClear, idbEach, idbCount, idbDeleteMany } from './idb'

const DB = openDb('varuna-tiles', 1, [
  { name: 'tiles', keyPath: 'k', indexes: [{ name: 'ts', keyPath: 'ts' }] },
])
const STORE = 'tiles'

const MAX_BYTES = 800 * 1024 * 1024 // ~800MB of tiles before the oldest go
const PREFETCH_CONCURRENCY = 6
export const MAX_PREFETCH_TILES = 20000 // refuse absurd areas rather than hang

export const tileKey = (z, x, y) => `${z}/${x}/${y}`

export async function getTile(k) {
  const rec = await idbGet(DB, STORE, k)
  return rec?.blob || null
}

export async function putTile(k, blob) {
  if (!blob || !blob.size) return false
  return idbPut(DB, STORE, { k, blob, ts: Date.now(), bytes: blob.size })
}

export async function tileStats() {
  let count = 0
  let bytes = 0
  await idbEach(DB, STORE, (r) => {
    count++
    bytes += r.bytes || r.blob?.size || 0
  })
  return { count, bytes }
}

export function tileCount() {
  return idbCount(DB, STORE)
}

export async function clearTiles() {
  await idbClear(DB, STORE)
}

/** Drop the oldest tiles once the cache outgrows its cap. */
export async function pruneTiles() {
  let bytes = 0
  const rows = []
  await idbEach(DB, STORE, (r) => {
    const n = r.bytes || r.blob?.size || 0
    bytes += n
    rows.push({ k: r.k, ts: r.ts || 0, n })
  })
  if (bytes <= MAX_BYTES) return 0
  rows.sort((a, b) => a.ts - b.ts)
  const doomed = []
  for (const r of rows) {
    if (bytes <= MAX_BYTES) break
    doomed.push(r.k)
    bytes -= r.n
  }
  await idbDeleteMany(DB, STORE, doomed)
  return doomed.length
}

// --- slippy-map tile maths ---------------------------------------------------
export function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z)
}
export function latToTileY(lat, z) {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

/** Metres -> a rough lat/lng box, for "cache 2 km around here". */
export function boundsAround(lat, lng, radiusM) {
  const dLat = radiusM / 111320
  const dLng = radiusM / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng }
}

/** How many tiles an area covers across a zoom range. */
export function countTiles(bounds, minZoom, maxZoom) {
  let n = 0
  for (let z = minZoom; z <= maxZoom; z++) {
    const x0 = lngToTileX(bounds.west, z)
    const x1 = lngToTileX(bounds.east, z)
    const y0 = latToTileY(bounds.north, z)
    const y1 = latToTileY(bounds.south, z)
    n += (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1)
  }
  return n
}

function fillUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y)
}

/**
 * Download every tile covering `bounds` between the two zooms and store them.
 * Tiles already cached are skipped, so re-running after a dropped connection
 * only fetches what's missing.
 *
 * @returns {Promise<{done:number, skipped:number, failed:number, total:number, stopped:boolean}>}
 */
export async function prefetchArea({ bounds, minZoom, maxZoom, urlTemplate, onProgress, shouldStop }) {
  const jobs = []
  for (let z = minZoom; z <= maxZoom; z++) {
    const xs = [lngToTileX(bounds.west, z), lngToTileX(bounds.east, z)].sort((a, b) => a - b)
    const ys = [latToTileY(bounds.north, z), latToTileY(bounds.south, z)].sort((a, b) => a - b)
    const max = 2 ** z
    for (let x = xs[0]; x <= xs[1]; x++) {
      for (let y = ys[0]; y <= ys[1]; y++) {
        if (x < 0 || y < 0 || x >= max || y >= max) continue
        jobs.push({ z, x, y })
      }
    }
  }
  const total = jobs.length
  if (total > MAX_PREFETCH_TILES) {
    throw new Error(`That area needs ${total.toLocaleString()} tiles — narrow the radius or the zoom range.`)
  }

  let done = 0
  let skipped = 0
  let failed = 0
  let stopped = false
  let cursor = 0

  async function worker() {
    while (cursor < jobs.length) {
      if (shouldStop?.()) {
        stopped = true
        return
      }
      const job = jobs[cursor++]
      const k = tileKey(job.z, job.x, job.y)
      try {
        if (await getTile(k)) {
          skipped++
        } else {
          const res = await fetch(fillUrl(urlTemplate, job.z, job.x, job.y), { mode: 'cors', cache: 'default' })
          if (!res.ok) throw new Error(String(res.status))
          const blob = await res.blob()
          await putTile(k, blob)
          done++
        }
      } catch {
        failed++
      }
      onProgress?.({ done, skipped, failed, total, processed: done + skipped + failed })
    }
  }

  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker))
  await pruneTiles()
  return { done, skipped, failed, total, stopped }
}
