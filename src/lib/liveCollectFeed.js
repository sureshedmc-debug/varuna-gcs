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

const KEY = 'varuna.liveCollect.autoSend'
const FRESH_MS = 15 * 60 * 1000
const SEND_EVERY_MS = 1500
const MOVED_M = 0.5
const DRONE_SOURCES = new Set(['drone', 'sim'])

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
  const busyRef = useRef(false)
  const running = reachable && live?.state === 'running'
  const startedAt = live?.started_at ? live.started_at * 1000 : null

  useEffect(() => {
    if (!running) return
    let gone = false
    async function tick() {
      if (busyRef.current || !getAutoSend()) return
      const sent = sentRef.current
      const batch = []
      for (const e of liveCandidates(getTrashLog(), getCollected(), startedAt)) {
        const id = boatItemId(e)
        const prev = sent.get(id)
        if (prev && distanceM(prev, [e.lat, e.lng]) < MOVED_M) continue
        batch.push({ id, lat: e.lat, lng: e.lng, source: e.posSource, confidence: e.confidence ?? null })
        if (batch.length >= 100) break
      }
      if (!batch.length) return
      busyRef.current = true
      try {
        const r = await boatApi.liveTargets(batch)
        if (!gone && r && r.success !== false && !r._httpError) {
          for (const t of batch) sent.set(t.id, [t.lat, t.lng])
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
  }, [startedAt])
}
