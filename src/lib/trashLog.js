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
// The list itself (coordinates, counts, etc.) is persisted in localStorage
// so tab switches and reloads keep the log. Photos are NOT persisted there —
// a JPEG per location would quickly blow past localStorage's ~5MB quota —
// they live only on the in-memory entry for the current browser session.

import { useEffect, useState } from 'react'

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
    // Strip photos before persisting — see the file header note.
    const slim = log.map(({ photo, ...rest }) => rest)
    localStorage.setItem(KEY, JSON.stringify(slim))
  } catch {
    /* private mode / quota */
  }
}
function emit() {
  persist()
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
export function recordTrashSighting({ lat, lng, count, confidence, source, posSource, alt, accuracy, photo }) {
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
    if (photo && (!match.photo || (conf ?? 0) > (match.confidence ?? 0))) match.photo = photo
  } else {
    log = [
      {
        id: `t-${++seq}`,
        class: 'trash',
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
        firstSeen: now,
        lastSeen: now,
        frames: 1,
      },
      ...log,
    ].slice(0, MAX_ENTRIES)
  }
  emit()
}

export function clearTrashLog() {
  log = []
  emit()
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
