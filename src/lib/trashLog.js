// Geotagged trash sightings from the in-browser AI detector (Live tab, both
// Webcam and Drone-feed modes). Each time the detector sees trash, the
// aircraft's live position — the drone GPS streamed over the WebSocket, or
// the laptop's GPS when no drone fix exists — is stamped onto it here.
//
// Sightings of the same spot are merged (within MERGE_M metres) so hovering
// over one piece of trash for a minute yields ONE location, not 60 rows; its
// `count` keeps the most items seen there at once. The Detections tab lists
// and maps these, and the Word report includes every one with a map link
// and, when captured, a photo of the trash.
//
// The list itself (coordinates, counts, etc.) is persisted in localStorage.
// The PHOTOS are persisted too, but in IndexedDB (see photoStore.js) — a JPEG
// per location would blow past localStorage's ~5MB quota, which is why they
// used to be dropped on reload. They survive a reload, a relaunch and a
// reboot now, so the Detections tab and the Word report still have their
// evidence days later. Each entry records `hasPhoto` in localStorage and its
// image is fetched back from IndexedDB on startup.

import { useEffect, useState } from 'react'
import { savePhotos, getPhotos, clearPhotos, deletePhotosFor } from './photoStore'

const KEY = 'varuna.trashLog'
const EVT = 'varuna:trashLog'
const MERGE_M = 5 // sightings closer than this are the same location
const MAX_MERGE_M = 50 // cap on the accuracy-widened merge radius
const UNLOCATED_MERGE_MS = 10000 // no position: merge sightings this close in time
const MAX_ENTRIES = 2000

function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

let log = load()
let seq = log.reduce((m, e) => Math.max(m, Number(String(e.id).split('-')[1]) || 0), 0)

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function persist() {
  try {
    // The image bytes go to IndexedDB, not here — only a flag stays in
    // localStorage so the entry knows to fetch its photo back on startup.
    const slim = log.map(({ photo, ...rest }) => ({ ...rest, hasPhoto: !!(photo || rest.hasPhoto) }))
    localStorage.setItem(KEY, JSON.stringify(slim))
  } catch {
    /* private mode / quota */
  }
}

// Pull saved photos back onto the log on startup. Only the newest entries are
// hydrated up front — that's what the Detections list shows — and the rest are
// fetched on demand when a row is opened.
const HYDRATE_ON_LOAD = 120
let hydrated = false
export async function hydratePhotos(limit = HYDRATE_ON_LOAD) {
  const want = log.filter((e) => e.hasPhoto && !e.photo).slice(0, limit)
  if (!want.length) return
  const photos = await getPhotos(want.map((e) => e.id))
  // A miss means the bytes are gone (pruned, or evicted by the browser) while
  // the flag survived in localStorage. Clear the flag, or the row shows
  // "Loading photo..." forever and re-reads IndexedDB on every expand.
  let changed = false
  for (const e of want) {
    const p = photos.get(e.id)
    if (p) {
      e.photo = p
      changed = true
    } else if (e.hasPhoto) {
      e.hasPhoto = false
      changed = true
    }
  }
  if (changed) emit()
}
if (typeof window !== 'undefined') {
  // After first paint, so hydration never delays the UI coming up.
  setTimeout(() => {
    if (hydrated) return
    hydrated = true
    hydratePhotos()
  }, 400)
}
// Serialising up to 2000 entries is slow, and the detector records up to
// twice a second — so writes are batched (at most one per second) and flushed
// when the page is hidden/closed. Screens still update instantly via the event.
let persistTimer = null
function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist()
  }, 1000)
}
function flushPersist() {
  if (!persistTimer) return
  clearTimeout(persistTimer)
  persistTimer = null
  persist()
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersist)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPersist()
  })
}

function emit() {
  schedulePersist()
  try {
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {
    /* no window */
  }
}

export function getTrashLog() {
  return log
}

/**
 * Record one detector frame that contained trash.
 * @param {object} s
 * @param {number|null} s.lat, s.lng  aircraft position at capture (null = no fix)
 * @param {number} s.count            trash items in this frame
 * @param {number} s.confidence       best score in this frame, 0..1
 * @param {string} s.source           'webcam' | 'stream'
 * @param {string} s.posSource        'drone' | 'laptop' | 'sim' | null
 * @param {number} [s.alt]            aircraft altitude (m), if known
 * @param {number} [s.accuracy]       position accuracy (± m), if known
 * @param {string} [s.photo]          JPEG data URL of this frame, if captured
 */
export function recordTrashSighting({ lat, lng, count, confidence, source, posSource, alt, accuracy, photo, className, estWidthM, estHeightM }) {
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return
  const now = Date.now()
  const located = Number.isFinite(lat) && Number.isFinite(lng)
  const conf = Number.isFinite(confidence) ? confidence : null
  const acc = Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : null
  // A coarse fix (laptop Wi-Fi location can wander tens of metres while
  // standing still) widens the merge radius, so one spot doesn't become many.
  const mergeM = Math.max(MERGE_M, Math.min(acc ?? 0, MAX_MERGE_M))

  const match = located
    ? log.find((e) => e.located && e.source === source && distanceM(e.lat, e.lng, lat, lng) <= mergeM)
    : log.find((e) => !e.located && e.source === source && now - e.lastSeen <= UNLOCATED_MERGE_MS)

  if (match) {
    match.count = Math.max(match.count, n)
    // Captured BEFORE confidence is raised: the photo-replacement test below
    // compares against it, and comparing with the already-raised value made
    // that test permanently false.
    const prevConf = match.confidence ?? 0
    match.confidence = conf == null ? match.confidence : Math.max(match.confidence ?? 0, conf)
    match.lastSeen = now
    match.frames += 1
    // Keep the most precise fix seen for this spot.
    if (located && acc != null && (match.accuracy == null || acc < match.accuracy)) {
      match.lat = lat
      match.lng = lng
      match.accuracy = acc
    }
    // Prefer the sharpest evidence: the first photo taken of this spot is
    // usually enough; only replace it if a clearly more confident frame comes in.
    // Only swap the stored evidence for a genuinely better frame. `hasPhoto`
    // matters as much as `photo` here: an entry whose image simply hasn't been
    // hydrated yet still HAS one, and must not be overwritten by a weaker frame.
    if (photo && ((!match.photo && !match.hasPhoto) || (conf ?? 0) > prevConf)) {
      match.photo = photo
      match.hasPhoto = true
      savePhotos(match.id, { boxed: photo }).catch(() => {})
    }
    // Best size seen so far for this spot (biggest box on the sharpest frame).
    if (Number.isFinite(Number(estWidthM)) && (match.estWidthM == null || Number(estWidthM) > match.estWidthM)) match.estWidthM = Number(estWidthM)
    if (Number.isFinite(Number(estHeightM)) && (match.estHeightM == null || Number(estHeightM) > match.estHeightM)) match.estHeightM = Number(estHeightM)
    if (className && match.class === 'trash') match.class = className
  } else {
    const id = `t-${++seq}`
    if (photo) savePhotos(id, { boxed: photo }).catch(() => {})
    log = [
      {
        id,
        class: className || 'trash',
        lat: located ? lat : null,
        lng: located ? lng : null,
        located,
        alt: Number.isFinite(alt) ? alt : null,
        accuracy: located ? acc : null, // ± metres (laptop GPS reports this; drone GPS usually doesn't)
        count: n,
        confidence: conf,
        source,
        posSource: located ? posSource : null,
        photo: photo || null,
        hasPhoto: !!photo,
        estWidthM: Number.isFinite(Number(estWidthM)) ? Number(estWidthM) : null,
        estHeightM: Number.isFinite(Number(estHeightM)) ? Number(estHeightM) : null,
        firstSeen: now,
        lastSeen: now,
        frames: 1,
      },
      ...log,
    ]
    if (log.length > MAX_ENTRIES) {
      // Entries falling off the end take their stored images with them,
      // otherwise the photos outlive the log that referenced them.
      const dropped = log.slice(MAX_ENTRIES).map((e) => e.id)
      log = log.slice(0, MAX_ENTRIES)
      deletePhotosFor(dropped).catch(() => {})
    }
  }
  emit()
}

export function clearTrashLog() {
  log = []
  emit()
  flushPersist() // a clear is saved right away
  clearPhotos().catch(() => {}) // the stored imagery goes with it
}

/** Fetch one entry's photo on demand (for rows outside the startup hydration). */
export async function ensurePhoto(id) {
  const entry = log.find((e) => e.id === id)
  if (!entry || entry.photo || !entry.hasPhoto) return entry?.photo || null
  const photos = await getPhotos([id])
  const p = photos.get(id)
  if (p) entry.photo = p
  else entry.hasPhoto = false // the bytes are gone; stop promising a photo
  emit()
  return p || null
}

/** React hook: the live sighting list (newest first). */
export function useTrashLog() {
  const [v, setV] = useState(log)
  useEffect(() => {
    const onEvt = () => setV([...log])
    const onStorage = (e) => {
      if (e.key === KEY) {
        log = load()
        setV([...log])
      }
    }
    onEvt()
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return v
}

/** Google Maps link for a coordinate pair. */
export function mapsLink(lat, lng) {
  return `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
}
