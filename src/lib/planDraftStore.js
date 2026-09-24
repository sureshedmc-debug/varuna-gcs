// Hand-off from the AI assistant to the Mission tab. The assistant puts a
// generated plan here; MissionScreen picks it up (once) and loads it into its
// editor as an unsaved draft, so the operator still reviews it and does
// Save → Upload → Start themselves. Also holds the app's tab navigator so the
// assistant can switch tabs from outside React's tree.
//
// Draft shape: { id, name, waypoints:[[lat,lng]], altitude, speedKmh, pattern,
//                lakeName, polygon (GeoJSON Feature), summary, warnings:[] }

import { useEffect, useState } from 'react'

let draft = null
const subs = new Set()
let navigator = null
let seq = 0

export function setPlanDraft(d) {
  draft = d ? { ...d, id: ++seq } : null
  subs.forEach((fn) => fn(draft))
}
export function getPlanDraft() {
  return draft
}
/** Mark the draft as loaded so it isn't applied again (e.g. on the next tab visit). */
export function consumePlanDraft(id) {
  if (draft && draft.id === id) draft = { ...draft, consumed: true }
}
export function usePlanDraft() {
  const [d, setD] = useState(draft)
  useEffect(() => {
    setD(draft)
    subs.add(setD)
    return () => subs.delete(setD)
  }, [])
  return d
}

// Centre of the Missions map, so "plan this lake" can mean "the one I'm looking at".
let mapView = null
export function setMissionMapView(center) {
  mapView = center
}
export function getMissionMapView() {
  return mapView
}

export function registerNavigator(fn) {
  navigator = fn
}
export function navigateTo(tab) {
  if (!navigator) return false
  navigator(tab)
  return true
}
