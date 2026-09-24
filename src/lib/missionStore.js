// Shared "active mission" — the single source of truth for the mission the
// operator has uploaded, read by:
//   - MissionScreen: to know whether the currently-edited plan is the one
//     that's actually been uploaded (gates the Run button).
//   - MissionControlScreen (Home tab): to draw the real flight path on the
//     map instead of a fake placeholder — nothing is drawn until a mission
//     has actually been uploaded.
//   - simulator.js: to know what path to fly when Start is pressed.
//
// Shape: { name, waypoints: [{lat,lng,action}], altitude, speedKmh, target, status }
// target: 'sim' | 'real' — which aircraft actually received it. A mission
//   uploaded to the simulator must never enable Start on a real drone.
// status: 'uploaded' | 'running'. null = no mission uploaded yet.

import { useEffect, useState } from 'react'

const KEY = 'varuna.activeMission'
const subs = new Set()

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY))
    if (!v || typeof v !== 'object' || !Array.isArray(v.waypoints)) return null
    // Nothing is flying right after a page load, so a persisted 'running' is stale.
    return v.status === 'running' ? { ...v, status: 'uploaded' } : v
  } catch {
    return null
  }
}

let state = load()

function persist() {
  try {
    if (state) localStorage.setItem(KEY, JSON.stringify(state))
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}
function emit() {
  persist()
  subs.forEach((fn) => fn(state))
}

export function getActiveMission() {
  return state
}
export function setActiveMission(mission) {
  state = mission ? { status: 'uploaded', ...mission } : null
  emit()
}
export function setMissionStatus(status) {
  if (!state) return
  state = { ...state, status }
  emit()
}
export function clearActiveMission() {
  state = null
  emit()
}
export function subscribeMission(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** React hook: the live active-mission object (or null), updating as it changes. */
export function useActiveMission() {
  const [m, setM] = useState(state)
  useEffect(() => {
    setM(state) // catch any change between first render and subscribing
    return subscribeMission(setM)
  }, [])
  return m
}

/** The active mission only if it was uploaded to `target` ('sim' | 'real'). */
export function missionFor(m, target) {
  return m && m.target === target ? m : null
}

// Stable identity for a mission plan (name + waypoints + altitude + speed),
// rounded to ~11cm precision so float noise from dragging a marker doesn't
// spuriously invalidate a save/upload. Used by MissionScreen to gate
// Save → Upload → Run: editing the plan after saving changes this key, which
// automatically invalidates the "saved"/"uploaded" checkpoints until redone.
export function planKey(name, wps, altitude, speedKmh) {
  const r = (n) => Math.round(Number(n) * 1e6) / 1e6
  return JSON.stringify({
    name,
    wps: wps.map((w) => [r(w.lat), r(w.lng), w.action]),
    altitude: Math.round(Number(altitude)),
    speedKmh: Math.round(Number(speedKmh) * 10) / 10,
  })
}
