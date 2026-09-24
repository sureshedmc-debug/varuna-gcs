// Client-side flight simulator. Stands in for a real drone whenever the
// backend is unreachable (see connectionState.js): it produces the same
// telemetry shape the real /api/telemetry feed would (see readT()/pick() in
// the screens), so every screen that reads `useSystem().telemetry.data`
// automatically shows the simulated aircraft with zero screen-specific code.
//
// It is a plain module-level state machine (not a React hook itself) so the
// command router (commands.js) can drive it outside of React, exactly the
// way it would call the real REST API. useSimTelemetry() is the one React
// entry point, used only by SystemContext.

import { useEffect, useState } from 'react'
import { getActiveMission, setMissionStatus } from './missionStore'

const TICK_MS = 250
const CLIMB_RATE = 3 // m/s, vertical speed for takeoff/land/altitude changes
const RTL_SPEED_KMH = 25 // fixed cruise speed for the return-to-home leg
const RTL_MIN_ALT = 10 // m, minimum return height
const BATTERY_DRAIN_PER_TICK = 0.006 // % per tick while armed and airborne/flying

const R_EARTH = 6371000 // m

function toRad(d) {
  return (d * Math.PI) / 180
}
function toDeg(r) {
  return (r * 180) / Math.PI
}
function distanceM(a, b) {
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearingDeg(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]))
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]))
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
// Move from `a` by `distM` along `bearingDeg0` (great-circle). Returns [lat,lng].
function destPoint(a, bearingDeg0, distM) {
  const brng = toRad(bearingDeg0)
  const lat1 = toRad(a[0])
  const lng1 = toRad(a[1])
  const dR = distM / R_EARTH
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng))
  const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(dR) * Math.cos(lat1), Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2))
  return [toDeg(lat2), toDeg(lng2)]
}

const IDLE_MODE = 'STANDBY'

const state = {
  armed: false,
  flight_mode: IDLE_MODE, // STANDBY | ARMED | TAKEOFF | MISSION | RTL | LAND
  lat: null,
  lng: null,
  home_lat: null,
  home_lng: null,
  altitude: 0,
  heading: 0,
  speed: 0, // m/s, current groundspeed (0 unless actively flying a leg)
  battery_voltage: 12.6,
  battery_percent: 95,
  satellites: 0,
}

// Flight-plan runtime (internal only, not part of the telemetry shape).
let targetAlt = 0
let legIdx = 0
let waypoints = [] // [{lat,lng,action}] for the current MISSION/RTL run
let runKind = null // 'mission' | 'rtl' | null — what to resume after a takeoff climb
let legSpeedMs = 5 / 3.6 // horizontal speed for the current run

const subs = new Set()
function emit() {
  subs.forEach((fn) => fn({ ...state }))
}
export function getSimState() {
  return { ...state }
}
export function subscribeSim(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** Seed the simulator's starting position once (idempotent). Called from
 *  SystemContext as soon as any position (laptop or drone) is known. */
export function simSetHome([lat, lng]) {
  if (state.lat != null) return // already seeded — never jump the sim mid-session
  state.lat = lat
  state.lng = lng
  state.home_lat = lat
  state.home_lng = lng
  state.satellites = 11
  emit()
}
export function simHasHome() {
  return state.lat != null
}

function ok(message) {
  return Promise.resolve({ success: true, message })
}
function fail(message) {
  return Promise.resolve({ success: false, message })
}
function noGps() {
  return state.lat == null ? fail('No GPS position yet — allow location access') : null
}

// Ends whatever run (mission / RTL) is in progress. If it was a mission, the
// store goes back to 'uploaded' so the Mission tab offers Start again — no
// matter what ended it (finished, land waypoint, LAND, STOP, RTL, takeoff, disarm).
function clearRun() {
  if (runKind === 'mission') setMissionStatus('uploaded')
  waypoints = []
  legIdx = 0
  runKind = null
}

export function simArm(next) {
  if (next) {
    if (state.armed) return ok()
    const e = noGps()
    if (e) return e
    state.armed = true
    state.flight_mode = 'ARMED'
  } else {
    if (!state.armed) return ok()
    clearRun()
    state.armed = false
    state.speed = 0
    if (state.altitude > 0.5) {
      // Disarming in flight is a real hazard on real hardware too: motors
      // cut and the aircraft comes down where it stands.
      state.flight_mode = 'LAND'
      targetAlt = 0
    } else {
      state.flight_mode = IDLE_MODE
    }
  }
  emit()
  return ok()
}

export function simTakeoff(altitude) {
  const e = noGps()
  if (e) return e
  if (!state.armed) return fail('Arm the aircraft first')
  clearRun()
  targetAlt = Math.max(1, Number(altitude) || 5)
  state.speed = 0
  state.flight_mode = 'TAKEOFF' // climbs or descends to targetAlt, then holds
  emit()
  return ok()
}

export function simLand() {
  clearRun()
  targetAlt = 0
  state.speed = 0
  if (state.armed || state.altitude > 0) state.flight_mode = 'LAND'
  emit()
  return ok()
}

export function simEmergencyStop() {
  return simLand()
}

export function simRtl() {
  if (state.home_lat == null) return fail('No home position set')
  // Like a real flight controller: RTL is only meaningful in the air.
  if (!state.armed || state.altitude < 0.5) return fail('Aircraft is on the ground')
  clearRun()
  waypoints = [{ lat: state.home_lat, lng: state.home_lng, action: 'land' }]
  runKind = 'rtl'
  legSpeedMs = RTL_SPEED_KMH / 3.6
  // Climb to a safe return height first if low; otherwise return at current height.
  targetAlt = Math.max(state.altitude, RTL_MIN_ALT)
  state.flight_mode = state.altitude < targetAlt - 0.5 ? 'TAKEOFF' : 'RTL'
  emit()
  return ok()
}

/** Fly the currently-uploaded mission (see missionStore). Auto-arms and
 *  auto-takes-off first if needed, then flies each waypoint leg in order at
 *  the mission's speed — a real, virtual flight, not a teleport. */
export function simStartMission() {
  const m = getActiveMission()
  if (!m || !m.waypoints?.length) return fail('No mission uploaded')
  const e = noGps()
  if (e) return e
  if (runKind === 'mission') return fail('Mission already running')
  clearRun()
  state.armed = true
  waypoints = m.waypoints
  runKind = 'mission'
  legSpeedMs = (Number(m.speedKmh) || 5) / 3.6
  targetAlt = Math.max(1, Number(m.altitude) || 10)
  setMissionStatus('running')
  // On (or near) the ground: vertical takeoff first. Already airborne: go
  // straight to the legs and adjust height en route.
  state.flight_mode = state.altitude < 1 ? 'TAKEOFF' : 'MISSION'
  emit()
  return ok()
}

// Move altitude toward targetAlt at the climb rate (up or down). True once there.
function stepAltitude(dt) {
  const diff = targetAlt - state.altitude
  const step = CLIMB_RATE * dt
  if (Math.abs(diff) <= step) {
    state.altitude = targetAlt
    return true
  }
  state.altitude += Math.sign(diff) * step
  return false
}

function advanceLeg(dtSec) {
  const target = waypoints[legIdx]
  if (!target) return
  const here = [state.lat, state.lng]
  const there = [target.lat, target.lng]
  const d = distanceM(here, there)
  const step = legSpeedMs * dtSec
  if (d > 0.01) state.heading = bearingDeg(here, there)
  if (step < d) {
    const moved = destPoint(here, state.heading, step)
    state.lat = moved[0]
    state.lng = moved[1]
    state.speed = legSpeedMs
    return
  }
  // Reached this waypoint.
  state.lat = there[0]
  state.lng = there[1]
  state.speed = 0
  legIdx += 1
  // A 'land' waypoint ends the run wherever it sits in the list, as on a real FC.
  if (target.action === 'land' || runKind === 'rtl') {
    clearRun()
    targetAlt = 0
    state.flight_mode = 'LAND'
  } else if (legIdx >= waypoints.length) {
    clearRun()
    state.flight_mode = 'ARMED' // holds position (loiter) — nothing left to fly
  }
}

function tick() {
  if (state.lat == null) return // no home yet — nothing to simulate
  const dt = TICK_MS / 1000

  if (state.flight_mode === 'TAKEOFF') {
    if (stepAltitude(dt)) {
      // Resume whatever the climb was for: a queued mission/RTL run, or a plain takeoff (hold).
      state.flight_mode = runKind === 'mission' ? 'MISSION' : runKind === 'rtl' ? 'RTL' : 'ARMED'
    }
  } else if ((state.flight_mode === 'MISSION' || state.flight_mode === 'RTL') && waypoints.length) {
    stepAltitude(dt) // reach the run's height while flying the leg
    advanceLeg(dt)
  } else if (state.flight_mode === 'LAND') {
    state.speed = 0
    targetAlt = 0
    if (stepAltitude(dt)) {
      state.armed = false
      state.flight_mode = IDLE_MODE
    }
  }

  if (state.armed && state.flight_mode !== IDLE_MODE) {
    state.battery_percent = Math.max(20, state.battery_percent - BATTERY_DRAIN_PER_TICK)
    state.battery_voltage = 10.5 + (state.battery_percent / 100) * 2.1
  }

  emit()
}

const intervalId = setInterval(tick, TICK_MS)
// Vite HMR: don't leave the old module's timer ticking after every edit.
if (import.meta.hot) import.meta.hot.dispose(() => clearInterval(intervalId))

// ---- React entry point (SystemContext only) ----
// Subscribes only while `enabled` (i.e. actually simulating), so a real
// backend session doesn't re-render the whole app at the sim's 4 Hz tick.
export function useSimTelemetry(enabled = true) {
  const [snap, setSnap] = useState(() => ({ data: getSimState(), lastUpdate: 0 }))
  useEffect(() => {
    if (!enabled) return undefined
    setSnap({ data: getSimState(), lastUpdate: Date.now() })
    return subscribeSim((s) => setSnap({ data: s, lastUpdate: Date.now() }))
  }, [enabled])
  return snap
}
