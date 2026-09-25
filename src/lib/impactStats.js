// Running impact totals across every mission this browser has flown.
// items = trash pieces the drone has seen (a proxy for "removed" — the
// cleanup crew still does the actual collection); area = ground covered by
// missions; flight hours + mission counter come from the mission-store's
// status transitions (running → not-running). Same store shape as
// detectionStats.js so every screen updates instantly and cross-tab.

import { useEffect, useState } from 'react'

const KEY = 'varuna.impactStats'
const EVT = 'varuna:impactStats'

const EMPTY = { itemsFound: 0, areaCoveredM2: 0, flightSeconds: 0, missionsCompleted: 0, updatedAt: 0 }

export function getImpactStats() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return { ...EMPTY }
    return {
      itemsFound: Number(raw.itemsFound) || 0,
      areaCoveredM2: Number(raw.areaCoveredM2) || 0,
      flightSeconds: Number(raw.flightSeconds) || 0,
      missionsCompleted: Number(raw.missionsCompleted) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return { ...EMPTY }
  }
}

function save(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }))
  } catch {
    /* SSR */
  }
}

/** Called when a mission finishes (running → uploaded/null). */
export function recordMissionCompleted({ itemCount = 0, areaM2 = 0, flightSeconds = 0 } = {}) {
  const s = getImpactStats()
  const next = {
    itemsFound: s.itemsFound + Math.max(0, Number(itemCount) || 0),
    areaCoveredM2: s.areaCoveredM2 + Math.max(0, Number(areaM2) || 0),
    flightSeconds: s.flightSeconds + Math.max(0, Number(flightSeconds) || 0),
    missionsCompleted: s.missionsCompleted + 1,
    updatedAt: Date.now(),
  }
  save(next)
  return next
}

export function resetImpactStats() {
  save({ ...EMPTY, updatedAt: Date.now() })
}

export function useImpactStats() {
  const [s, setS] = useState(getImpactStats)
  useEffect(() => {
    const onEvt = (e) => setS(e.detail && typeof e.detail === 'object' ? e.detail : getImpactStats())
    const onStorage = (e) => {
      if (e.key === KEY) setS(getImpactStats())
    }
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return s
}
