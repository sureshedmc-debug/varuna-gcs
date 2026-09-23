// Shared live trash-count store for the in-browser webcam detector.
//
// WebcamDetect (Live tab) runs the AI locally and knows how many trash items
// are on screen, but the Detections tab is a different screen and only sees
// backend records. This tiny store bridges the two: WebcamDetect records its
// trash-only count here, and the Detections tab reads it via useTrashStats().
// State is persisted in localStorage so it survives tab switches and reloads,
// and broadcast via a CustomEvent so a mounted screen updates instantly.

import { useEffect, useState } from 'react'

const KEY = 'varuna.trashStats'
const EVT = 'varuna:trashStats'

const EMPTY = { peak: 0, last: 0, updatedAt: 0 }

export function getTrashStats() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!s || typeof s !== 'object') return { ...EMPTY }
    return {
      peak: Number(s.peak) || 0,
      last: Number(s.last) || 0,
      updatedAt: Number(s.updatedAt) || 0,
    }
  } catch {
    return { ...EMPTY }
  }
}

// Throttle timestamp for non-peak updates (the detect loop calls ~30x/sec).
let _lastWrite = 0

export function recordTrashCount(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return
  const s = getTrashStats()
  const peak = Math.max(s.peak, v)
  const now = Date.now()
  const newPeak = peak > s.peak
  // Always capture a new peak immediately; throttle plain "last" churn to ~1/sec.
  if (!newPeak && now - _lastWrite < 900) return
  _lastWrite = now
  const next = { peak, last: v, updatedAt: now }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }))
  } catch {
    /* SSR / no window */
  }
}

export function resetTrashStats() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { ...EMPTY } }))
  } catch {
    /* no window */
  }
}

/** React hook: current trash stats, live-updating across the app. */
export function useTrashStats() {
  const [stats, setStats] = useState(getTrashStats)
  useEffect(() => {
    const onEvt = (e) => setStats(e.detail && typeof e.detail === 'object' ? e.detail : getTrashStats())
    const onStorage = (e) => {
      if (e.key === KEY) setStats(getTrashStats())
    }
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return stats
}
