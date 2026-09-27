// Persisted detection imagery.
//
// Until now a sighting's photo lived only in memory: the trash log is kept in
// localStorage, and a JPEG per location would blow past its ~5MB quota, so
// photos were stripped before saving and evidence vanished on reload. They now
// live in IndexedDB instead, which has no practical size limit — so the
// Detections/recall tab and the Word report still have their photos after a
// reload, a relaunch, or days later.
//
// Storage is capped and pruned oldest-first.

import { openDb, idbGet, idbPut, idbDeleteMany, idbClear, idbEach, idbCount, sizeOf } from './idb'

// Two stores, and the split matters for performance. An IndexedDB cursor
// deserialises the whole record, so totalling the size of 400MB of data-URL
// strings by walking `photos` would pull all 400MB into memory — and prune()
// runs every 40 writes, mid-flight. `meta` holds one tiny row per image (id,
// bytes, timestamp, pinned), so the size sweep and the prune sweep never
// touch a single pixel.
// Version 2 adds `meta`; the bump is what lets an already-created database
// gain the new store instead of silently failing every write to it.
const DB = openDb('varuna-media', 2, [
  { name: 'photos', keyPath: 'id' },
  { name: 'meta', keyPath: 'id', indexes: [{ name: 'ts', keyPath: 'ts' }] },
])

const STORE = 'photos'
const META = 'meta'
const MAX_BYTES = 400 * 1024 * 1024 // ~400MB of imagery before the oldest go
const PRUNE_EVERY = 40 // writes between prune sweeps

// Small in-memory cache so scrolling the Detections list doesn't hit the disk
// for a photo it just showed.
const mem = new Map()
const MEM_MAX = 400
function remember(key, value) {
  if (mem.has(key)) mem.delete(key)
  mem.set(key, value)
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value)
}

let writesSincePrune = 0

/**
 * Store the imagery for one sighting. Either image may be omitted.
 * @param {string} id sighting id (the trash-log entry's id)
 */
export async function savePhotos(id, { boxed } = {}) {
  if (!id) return
  if (boxed) {
    remember(id, boxed)
    await idbPut(DB, STORE, { id, data: boxed })
    await idbPut(DB, META, { id, bytes: sizeOf(boxed), ts: Date.now() })
  }
  if (++writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0
    prune().catch(() => {}) // fire-and-forget; never blocks a detection
  }
}

/** The stored frame for a sighting — what the operator saw. */
export async function getPhoto(id) {
  if (!id) return null
  if (mem.has(id)) return mem.get(id)
  const rec = await idbGet(DB, STORE, id)
  const data = rec?.data || null
  if (data) remember(id, data)
  return data
}

/** Frames for many sightings at once. Returns Map<id, dataUrl>. */
export async function getPhotos(ids) {
  const out = new Map()
  await Promise.all(
    ids.map(async (id) => {
      const p = await getPhoto(id)
      if (p) out.set(id, p)
    }),
  )
  return out
}

export async function deletePhotosFor(ids) {
  const keys = []
  for (const id of ids) {
    keys.push(id)
    mem.delete(id)
  }
  await idbDeleteMany(DB, STORE, keys)
  await idbDeleteMany(DB, META, keys)
}

export async function clearPhotos() {
  mem.clear()
  await idbClear(DB, STORE)
  await idbClear(DB, META)
}

/** { count, bytes } across every stored frame — shown in the storage panel. */
export async function photoStats() {
  let count = 0
  let bytes = 0
  await idbEach(DB, META, (rec) => {
    count++
    bytes += rec.bytes || 0
  })
  return { count, bytes }
}

export function photoCount() {
  return idbCount(DB, STORE)
}

/** Drop the oldest frames until the store is back under the cap. */
async function prune() {
  let bytes = 0
  const aged = []
  await idbEach(DB, META, (rec) => {
    bytes += rec.bytes || 0
    aged.push({ id: rec.id, ts: rec.ts || 0, n: rec.bytes || 0 })
  })
  if (bytes <= MAX_BYTES) return
  aged.sort((a, b) => a.ts - b.ts)
  const doomed = []
  for (const rec of aged) {
    if (bytes <= MAX_BYTES) break
    doomed.push(rec.id)
    mem.delete(rec.id)
    bytes -= rec.n
  }
  if (doomed.length) {
    await idbDeleteMany(DB, STORE, doomed)
    await idbDeleteMany(DB, META, doomed)
  }
}
