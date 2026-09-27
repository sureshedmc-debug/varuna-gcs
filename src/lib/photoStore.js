// Persisted detection imagery.
//
// Until now a sighting's photo lived only in memory: the trash log is kept in
// localStorage, and a JPEG per location would blow past its ~5MB quota, so
// photos were stripped before saving and evidence vanished on reload. They now
// live in IndexedDB instead, which has no practical size limit — so the
// Detections/recall tab and the Word report still have their photos after a
// reload, a relaunch, or days later.
//
// TWO images are kept per sighting, and the difference matters:
//
//   boxed  — the canvas frame with the AI's boxes drawn on it. This is what
//            the operator saw, and it's what the recall tab and report show.
//   clean  — the same moment straight from the camera, no overlay, larger.
//            This is the one the self-training loop trains on: drawn
//            rectangles in a training image teach the model to find drawn
//            rectangles, so the boxed frame must never be used as label data.
//
// Storage is capped and pruned oldest-first. Frames that the auto-labeller has
// promoted into the training set are pinned and never pruned.

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

const rawKey = (id) => `${id}#raw`

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
export async function savePhotos(id, { boxed, clean } = {}) {
  if (!id) return
  const ts = Date.now()
  if (boxed) {
    remember(id, boxed)
    await idbPut(DB, STORE, { id, data: boxed })
    await idbPut(DB, META, { id, kind: 'boxed', bytes: sizeOf(boxed), ts, pinned: false })
  }
  if (clean) {
    await idbPut(DB, STORE, { id: rawKey(id), data: clean })
    await idbPut(DB, META, { id: rawKey(id), kind: 'clean', bytes: sizeOf(clean), ts, pinned: false })
  }
  if (++writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0
    prune().catch(() => {}) // fire-and-forget; never blocks a detection
  }
}

/** The boxed frame for a sighting — what the operator saw. */
export async function getPhoto(id) {
  if (!id) return null
  if (mem.has(id)) return mem.get(id)
  const rec = await idbGet(DB, STORE, id)
  const data = rec?.data || null
  if (data) remember(id, data)
  return data
}

/** The clean, un-annotated frame — training data only. */
export async function getCleanFrame(id) {
  if (!id) return null
  const rec = await idbGet(DB, STORE, rawKey(id))
  return rec?.data || null
}

/** Boxed frames for many sightings at once. Returns Map<id, dataUrl>. */
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

/** Keep this sighting's imagery out of the prune sweep (it's training data). */
export async function pinPhotos(id) {
  for (const key of [id, rawKey(id)]) {
    const rec = await idbGet(DB, META, key)
    if (rec && !rec.pinned) await idbPut(DB, META, { ...rec, pinned: true })
  }
}

export async function deletePhotosFor(ids) {
  const keys = []
  for (const id of ids) {
    keys.push(id, rawKey(id))
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

/** Drop the oldest unpinned frames until the store is back under the cap. */
async function prune() {
  let bytes = 0
  const aged = []
  await idbEach(DB, META, (rec) => {
    bytes += rec.bytes || 0
    if (!rec.pinned) aged.push({ id: rec.id, ts: rec.ts || 0, n: rec.bytes || 0 })
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
