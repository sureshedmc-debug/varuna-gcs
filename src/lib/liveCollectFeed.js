// Live collect, app side: while the boat's live collect is running, every
// plastic find the drone's AI makes is sent to the boat Pi as it appears (and
// again when more sightings move its position), so the boat can go after it
// without a planned mission. The boat decides the order and drives itself
// (boat-pi/live_collect.py); this only feeds it.
//
// Sent: located drone finds (posSource 'drone', or 'sim' for the app's
// simulated drone) not yet collected, seen within the last FRESH_MS or after
// live collect started. Laptop-webcam finds are never sent.

import { useEffect, useRef } from 'react'
import { boatApi } from '../api/boatClient'
import { boatItemId, getCollected, distanceM } from './boatStore'
import { getTrashLog } from './trashLog'
import { getDroneCrop, noteBoatStates, noteSentToBoat } from './droneTargets'

const KEY = 'varuna.liveCollect.autoSend'
const FRESH_MS = 15 * 60 * 1000
const SEND_EVERY_MS = 1500
const MOVED_M = 0.5
const DRONE_SOURCES = new Set(['drone', 'sim'])
const STATES_EVERY_MS = 5000 // the boat's workflow states → drone_targets.csv

export function getAutoSend() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}
export function setAutoSend(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent('varuna:liveCollect-autoSend'))
  } catch {
    /* no window */
  }
}

/** The drone finds live collect should know about right now. */
export function liveCandidates(log, collected, startedAtMs, now = Date.now()) {
  const since = Math.min(now - FRESH_MS, startedAtMs || Infinity)
  return log.filter((e) => e.located && Number.isFinite(e.lat) && Number.isFinite(e.lng)
    && DRONE_SOURCES.has(e.posSource) && (e.lastSeen || 0) >= since && !collected[boatItemId(e)])
}

/**
 * Mounted once (BoatProvider). `live` is the boat telemetry's live summary.
 * Returns nothing; sends in the background.
 */
export function useLiveCollectFeed(live, reachable) {
  const sentRef = useRef(new Map())        // boat id → [lat, lng] last sent
  const refSentRef = useRef(new Set())     // boat ids whose drone crop the boat has
  const busyRef = useRef(false)
  const statesAtRef = useRef(0)
  const running = reachable && live?.state === 'running'
  const startedAt = live?.started_at ? live.started_at * 1000 : null

  useEffect(() => {
    if (!running) return
    let gone = false
    async function tick() {
      if (busyRef.current || !getAutoSend()) return
      busyRef.current = true
      try {
        if (Date.now() - statesAtRef.current > STATES_EVERY_MS) {
          statesAtRef.current = Date.now()
          const st = await boatApi.liveStatus().catch(() => null)
          if (!gone && st && !st._httpError) noteBoatStates(st.targets)
        }
        const sent = sentRef.current
        const batch = []
        for (const e of liveCandidates(getTrashLog(), getCollected(), startedAt)) {
          const id = boatItemId(e)
          const prev = sent.get(id)
          const ref = refSentRef.current.has(id) ? null : await getDroneCrop(id)
          if (prev && distanceM(prev, [e.lat, e.lng]) < MOVED_M && !ref) continue
          // The drone's detection record. The boat (and this app's matcher) compare
          // what the boat's camera sees with object_class and with the drone's crop
          // (reference_image), so the boat collects the same piece.
          batch.push({
            id, lat: e.lat, lng: e.lng, source: e.posSource, confidence: e.confidence ?? null,
            object_class: e.class && e.class !== 'trash' ? e.class : null,
            timestamp: e.firstSeen || null,
            ...(ref ? { reference_image: ref } : {}),
          })
          if (batch.length >= 25) break        // crops make each item a few KB
        }
        if (!batch.length) return
        const r = await boatApi.liveTargets(batch)
        if (!gone && r && r.success !== false && !r._httpError) {
          for (const t of batch) {
            sent.set(t.id, [t.lat, t.lng])
            if (t.reference_image) refSentRef.current.add(t.id)
          }
          noteSentToBoat(batch)
        }
      } catch {
        /* the next tick retries */
      } finally {
        busyRef.current = false
      }
    }
    tick()
    const iv = setInterval(tick, SEND_EVERY_MS)
    return () => {
      gone = true
      clearInterval(iv)
    }
  }, [running, startedAt])

  // A new live-collect session (or a cleared queue) starts with a clean slate.
  useEffect(() => {
    sentRef.current = new Map()
    refSentRef.current = new Set()
  }, [startedAt])
}
