// A lightweight per-mission position log kept in memory (same lifetime as
// missionRecording.js's video clips — this whole feature is meant to be
// replayed in the same browser session, together with those clips, so
// persisting it to localStorage would blow through the quota for no gain).
//
// Runs are started/stopped by mission-status transitions in missionStore.js,
// and samples are pushed at ~1 Hz from SystemContext.jsx's already-unified
// telemetry (real drone or simulator), reusing the transport that's already
// there.

import { useEffect, useState } from 'react'

// One sample every this many ms. Fast enough to look smooth in replay, slow
// enough to keep memory tiny (a 15-min mission is ~900 samples).
const MIN_SAMPLE_MS = 800
const MAX_SAMPLES_PER_RUN = 3600 // ~1 hour hard cap
const MAX_RUNS = 20 // keep the last N missions

const subs = new Set()
let state = { runs: [], recording: false, activeRunId: null }
let seq = 0
let lastSampleAt = 0

function emit() {
  subs.forEach((fn) => fn(state))
}

export function startPositionRecording() {
  if (state.recording) return
  const id = `pos-${++seq}`
  const startedAt = Date.now()
  const runs = [...state.runs, { id, startedAt, stoppedAt: 0, samples: [] }].slice(-MAX_RUNS)
  state = { runs, recording: true, activeRunId: id }
  lastSampleAt = 0
  emit()
}

export function stopPositionRecording() {
  if (!state.recording) return
  const runs = state.runs.map((r) => (r.id === state.activeRunId ? { ...r, stoppedAt: Date.now() } : r))
  state = { runs, recording: false, activeRunId: null }
  emit()
}

/** Push one position sample if enough time has passed. Called from the
 *  telemetry subscription; safe to call every telemetry tick — it throttles
 *  itself so the sample rate is bounded no matter how fast telemetry arrives. */
export function samplePosition({ lat, lng, alt, heading } = {}) {
  if (!state.recording || !state.activeRunId) return
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return
  const now = Date.now()
  if (now - lastSampleAt < MIN_SAMPLE_MS) return
  lastSampleAt = now
  const activeId = state.activeRunId
  const runs = state.runs.map((r) => {
    if (r.id !== activeId) return r
    if (r.samples.length >= MAX_SAMPLES_PER_RUN) return r
    const samples = [
      ...r.samples,
      {
        t: now,
        lat: Number(lat),
        lng: Number(lng),
        alt: Number.isFinite(Number(alt)) ? Number(alt) : null,
        heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
      },
    ]
    return { ...r, samples }
  })
  state = { ...state, runs }
  emit()
}

export function getPositionHistory() {
  return state
}

/** Runs that have at least a few samples — the replay screen filters these. */
export function replayableRuns() {
  return state.runs.filter((r) => r.samples.length >= 2)
}

export function clearPositionHistory() {
  state = { runs: [], recording: false, activeRunId: null }
  emit()
}

export function subscribePositionHistory(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function usePositionHistory() {
  const [s, setS] = useState(state)
  useEffect(() => {
    setS(state)
    return subscribePositionHistory(setS)
  }, [])
  return s
}
