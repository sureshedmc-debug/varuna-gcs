// Which plastic sightings the boat has collected, kept in this browser.
//
// A sighting's boat id is `<trash-log id>.<firstSeen>`: trash-log ids restart
// at t-1 after the log is cleared, so the id alone could wrongly mark a new
// sighting as already collected. The boat echoes these ids back when it
// reaches each item (telemetry.mission.reached).

import { useEffect, useState } from 'react'

const KEY = 'varuna.boat.collected'
const EVT = 'varuna:boat-collected'

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

let collected = load()

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(collected))
  } catch {
    /* private mode / quota */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {
    /* no window */
  }
}

export function boatItemId(entry) {
  return `${entry.id}.${entry.firstSeen}`
}

/** Mark boat ids collected. Returns how many were new. */
export function markCollected(ids, missionName) {
  let added = 0
  const at = Date.now()
  for (const id of ids || []) {
    if (!id || collected[id]) continue
    collected = { ...collected, [id]: { at, mission: missionName || null } }
    added++
  }
  if (added) save()
  return added
}

export function unmarkCollected(id) {
  if (!collected[id]) return
  const next = { ...collected }
  delete next[id]
  collected = next
  save()
}

export function clearCollected() {
  collected = {}
  save()
}

export function getCollected() {
  return collected
}

export function useCollected() {
  const [v, setV] = useState(collected)
  useEffect(() => {
    const onEvt = () => setV(collected)
    const onStorage = (e) => {
      if (e.key === KEY) {
        collected = load()
        setV(collected)
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

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const R = 6371000
  const toR = (d) => (d * Math.PI) / 180
  const dLat = toR(b[0] - a[0])
  const dLng = toR(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Order points into a short route: nearest-neighbour from `start`, then a
 * 2-opt pass to remove crossings. Fine for the tens of items a boat collects.
 * @param {Array<{lat:number,lng:number}>} points
 * @param {[number,number]|null} start
 */
export function orderRoute(points, start) {
  if (points.length < 2) return [...points]
  const left = [...points]
  const route = []
  let cur = start || [left[0].lat, left[0].lng]
  while (left.length) {
    let best = 0
    let bestD = Infinity
    left.forEach((p, i) => {
      const d = distanceM(cur, [p.lat, p.lng])
      if (d < bestD) { bestD = d; best = i }
    })
    const [p] = left.splice(best, 1)
    route.push(p)
    cur = [p.lat, p.lng]
  }
  const pt = (i) => (i < 0 ? start : [route[i].lat, route[i].lng])
  let improved = true
  for (let pass = 0; improved && pass < 20; pass++) {
    improved = false
    for (let i = start ? 0 : 1; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const a = pt(i - 1)
        if (!a) continue
        const b = pt(i)
        const c = pt(k)
        const d = k + 1 < route.length ? pt(k + 1) : null
        const before = distanceM(a, b) + (d ? distanceM(c, d) : 0)
        const after = distanceM(a, c) + (d ? distanceM(b, d) : 0)
        if (after + 0.01 < before) {
          route.splice(i, k - i + 1, ...route.slice(i, k + 1).reverse())
          improved = true
        }
      }
    }
  }
  return route
}

/** Total path length start → route → (optionally) back to start, in metres. */
export function routeLength(route, start, returnHome = true) {
  let d = 0
  let cur = start
  for (const p of route) {
    const q = [p.lat, p.lng]
    if (cur) d += distanceM(cur, q)
    cur = q
  }
  if (returnHome && start && cur) d += distanceM(cur, start)
  return d
}
