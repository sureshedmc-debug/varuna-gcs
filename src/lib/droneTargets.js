// The drone half of the drone-to-boat workflow: every plastic find keeps a
// crop of the item, as the drone saw it, so the boat can later be sure it is
// collecting the same piece.
//
// For each find (trash-log entry, keyed by its boat id `<id>.<firstSeen>`):
//   * the best crop so far (most confident frame) is kept in this browser
//     (IndexedDB, photoStore key `crop:<boat id>`) and in memory;
//   * on the PC it is saved as  <data folder>/drone_images/<boat id>.jpg  and
//     a row is written to  drone_targets.csv : id, position, class,
//     confidence, times, image file — and later what the boat made of it
//     (boat_state SENT / SEARCHING / ... / COLLECTED, match_score, retries);
//   * liveCollectFeed.js sends it to the boat with the find (reference_image);
//   * boatVision.js compares the boat's camera boxes with it (targetMatch.js).

import { boatItemId } from './boatStore'
import { getPhoto, savePhotos } from './photoStore'
import { localCall, saveRecords } from './localData'

const mem = new Map() // boat id → { crop, conf, w, h }
const rows = new Map() // boat id → last row written (so only changes are re-sent)
const PREFIX = 'crop:'
// The photo of the drone's latest detection (its best one so far): the Boat
// tab shows it and matches the boat camera against it.
// { id, key, crop, cls, conf, at } - `id` is the find it belongs to, `key`
// changes whenever the photo is replaced.
let latest = null
let latestSeq = 0
const MIN_PHOTO_CONF = 0.4
const latestSubs = new Set()
function setLatest(v) {
  latest = v
  for (const fn of latestSubs) {
    try { fn(v) } catch { /* a closed screen */ }
  }
}

/** The drone's newest plastic picture in this app (GPS or not), or null. */
export const latestDroneCrop = () => latest
/** Call `fn(latest)` on every new picture (and on a clear); returns the unsubscribe. */
export function onLatestDroneCrop(fn) {
  latestSubs.add(fn)
  return () => latestSubs.delete(fn)
}
/** Forget the newest picture (the Boat tab's Reset). */
export function clearLatestDroneCrop() {
  setLatest(null)
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : '')
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? String(Math.round(Number(v) * 1e7) / 1e7) : '')
export const imageFileOf = (id) => `${String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)}.jpg`

function writeRow(id, patch) {
  const row = { ...(rows.get(id) || { target_id: id }), ...patch, updated_at: new Date().toISOString() }
  rows.set(id, row)
  saveRecords([{ table: 'drone_targets', rows: [row] }])
}

/**
 * A drone find has a (new) crop. Kept only if it is the first one or from a
 * more confident frame. `entry` is the trash-log entry.
 */
export function rememberDroneCrop(entry, crop, { confidence = null, w = null, h = null } = {}) {
  if (!entry?.id || !entry.firstSeen || !crop || !crop.startsWith('data:image/jpeg')) return
  const id = boatItemId(entry)
  const prev = mem.get(id)
  const cls = entry.class && entry.class !== 'trash' ? entry.class : null
  // The Boat tab's picture: one photo per drone detection. A new detection
  // replaces it at once; while the drone keeps seeing the same one, only a
  // clearly more confident (sharper) photo of it does - never every frame, so
  // the boat matches against the detection's best photo, not a blurry one.
  // An unsure detection (under 40%) is too often not plastic at all (a lamp,
  // the ceiling): it never becomes the photo the boat matches against.
  const c = Number.isFinite(confidence) ? confidence : null
  if (c != null && c < MIN_PHOTO_CONF) {
    // not shown; still stored below as the find's evidence
  } else if (!latest || latest.id !== id || (c ?? 0) >= (latest.conf ?? 0) + 0.03) {
    setLatest({ id, key: ++latestSeq, crop, cls, conf: c, at: Date.now() })
  }
  if (prev && (prev.conf ?? 0) >= (confidence ?? 0)) return
  mem.set(id, { crop, conf: confidence, w, h })
  missing.delete(id)
  savePhotos(PREFIX + id, { boxed: crop }).catch(() => {})
  localCall('/local/drone-image', { id, data: crop }).catch(() => {}) // not in the desktop app: browser copy only
  writeRow(id, {
    detection_id: `${entry.firstSeen}-${entry.id}`, // the row's id in detections.csv
    first_seen: iso(entry.firstSeen), last_seen: iso(entry.lastSeen),
    lat: num(entry.lat), lng: num(entry.lng), class: entry.class || 'trash', confidence: num(entry.confidence),
    image_file: `drone_images/${imageFileOf(id)}`, image_w: num(w), image_h: num(h),
    boat_state: rows.get(id)?.boat_state || 'DETECTED',
  })
}

/** The drone's crop of a find (JPEG data URL), or null. */
const missing = new Map() // boat id → when the browser store had no crop for it
export async function getDroneCrop(id) {
  if (!id) return null
  if (mem.has(id)) return mem.get(id).crop
  if (Date.now() - (missing.get(id) || 0) < 30000) return null
  try {
    const p = await getPhoto(PREFIX + id)
    if (p) mem.set(id, { crop: p, conf: null })
    else missing.set(id, Date.now())
    return p || null
  } catch {
    return null
  }
}

/** The finds were sent to the boat (live collect). */
export function noteSentToBoat(items) {
  const at = new Date().toISOString()
  for (const t of items) {
    const prev = rows.get(t.id)
    if (prev?.sent_to_boat_at && prev.lat === num(t.lat) && prev.lng === num(t.lng)) continue
    writeRow(t.id, {
      lat: num(t.lat), lng: num(t.lng), class: t.object_class || prev?.class || 'trash', confidence: num(t.confidence),
      sent_to_boat_at: prev?.sent_to_boat_at || at,
      boat_state: prev?.boat_state && prev.boat_state !== 'DETECTED' ? prev.boat_state : 'SENT',
    })
  }
}

/** The boat's view of its targets (GET /api/live/status → targets): record state changes. */
export function noteBoatStates(targets) {
  for (const t of targets || []) {
    if (!t?.id || !t.state) continue
    const prev = rows.get(t.id)
    const patch = {
      boat_state: t.state, retry_count: num(t.retry_count), match_score: num(t.match_score),
      verified: t.verified == null ? '' : t.verified ? 'yes' : 'no',
    }
    if (prev && Object.entries(patch).every(([k, v]) => prev[k] === v)) continue
    if (!prev) Object.assign(patch, { lat: num(t.lat), lng: num(t.lng), class: t.object_class || '' })
    writeRow(t.id, patch)
  }
}
