import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useVarunaWS } from '../hooks/useVarunaWS'
import { useLivePosition } from '../hooks/useLaptopGps'
import { setBackendReachable } from '../lib/connectionState'
import { useSimTelemetry, simSetHome } from '../lib/simulator'
import { pick } from '../lib/format'
import { subscribeMission, getActiveMission, setMissionStatus } from '../lib/missionStore'
import { startPositionRecording, stopPositionRecording, samplePosition } from '../lib/positionHistory'
import { recordMissionCompleted } from '../lib/impactStats'
import { getTrashLog } from '../lib/trashLog'

const Ctx = createContext(null)
export const useSystem = () => useContext(Ctx)

/** Shared live state: ping, pi metrics, health, and telemetry (WS+fallback). */
// No ticking clock in here on purpose: a 1 s `now` in this value re-rendered
// every screen every second. Screens that show ages tick locally (useNow /
// StaleBadge).
export function SystemProvider({ children }) {
  const ping = usePolling(api.ping, 4000)
  const pi = usePolling(api.piMetrics, 6000)
  const health = usePolling(api.health, 5000)
  const realTelemetry = useVarunaWS({ pollInterval: 2000 })

  // Reachable only on a real 2xx ping. An HTTP error (proxy 500, gateway down)
  // sets _httpError and must count as unreachable, not "reachable".
  const backendReachable =
    ping.error || ping.data?._httpError ? false : ping.data ? true : undefined

  // Mirror into the plain (non-React) command router so it can decide, per
  // command, whether to call the real API or the simulator (see commands.js).
  useEffect(() => {
    setBackendReachable(backendReachable)
  }, [backendReachable])

  // No real backend → every screen runs on the client-side flight simulator
  // instead. Seed its starting position (laptop GPS, or a real fix if one
  // shows up) the moment one is known; seeding is a one-time no-op after that.
  // Same latch as connectionState.isSimulated(): once a real drone has been
  // seen this session, a later ping failure shows as "unreachable" but never
  // swaps the screens (or the commands) over to the virtual aircraft.
  const everRealRef = useRef(false)
  if (backendReachable === true) everRealRef.current = true
  const simulated = backendReachable === false && !everRealRef.current
  const bootstrap = useLivePosition(realTelemetry.data)
  const sim = useSimTelemetry(simulated)
  useEffect(() => {
    if (bootstrap.position) simSetHome(bootstrap.position)
  }, [bootstrap.position])

  // Reported as 'live' so every screen's existing "connected" checks (which
  // only look at telemetry.status) keep working unchanged against the sim;
  // `simulated` is exposed separately for screens that want to label it.
  const simTelemetry = useMemo(() => ({ data: sim.data, status: 'live', lastUpdate: sim.lastUpdate }), [sim])
  const telemetry = simulated ? simTelemetry : realTelemetry

  // When the motors were last armed (null while disarmed/unknown). Lives here,
  // not in a screen, so flight time survives tab switches.
  const armedSinceRef = useRef(null)
  const armedNow = pick(telemetry.data, ['armed', 'is_armed'])
  if (armedNow === true || armedNow === 'true' || armedNow === 1) {
    if (armedSinceRef.current == null) armedSinceRef.current = Date.now()
  } else if (armedNow === false || armedNow === 'false' || armedNow === 0) {
    armedSinceRef.current = null
  }
  const armedSince = armedSinceRef.current

  // Mission lifecycle → position-history recorder + impact totals. Runs once,
  // hooks the mission store's status transitions ('running' → 'uploaded'/null =
  // mission ended). Sample rate is throttled inside positionHistory itself.
  const runStartRef = useRef(0)
  const startTrashLenRef = useRef(0)
  useEffect(() => {
    let last = getActiveMission()?.status || null
    const unsub = subscribeMission((m) => {
      const now = m?.status || null
      if (now === 'running' && last !== 'running') {
        runStartRef.current = Date.now()
        startTrashLenRef.current = getTrashLog().length
        startPositionRecording()
      } else if (last === 'running' && now !== 'running') {
        stopPositionRecording()
        const flightSeconds = runStartRef.current ? Math.round((Date.now() - runStartRef.current) / 1000) : 0
        // "Items found this mission" = trash logged during the run.
        const gained = Math.max(0, getTrashLog().length - startTrashLenRef.current)
        recordMissionCompleted({ itemCount: gained, flightSeconds })
        runStartRef.current = 0
      }
      last = now
    })
    return unsub
  }, [])

  // A real drone reports its own mission progress (drone-pi backend:
  // telemetry.mission.state). Mirror it into the mission store, the same way
  // the simulator does, so Missions/Home show "running" and the flight is
  // recorded for Replay. Only for a mission that went to the real aircraft.
  const realMissionState = !simulated ? telemetry.data?.mission?.state : undefined
  useEffect(() => {
    if (!realMissionState) return
    const m = getActiveMission()
    if (!m || m.target !== 'real') return
    const flying = ['running', 'paused', 'returning', 'landing'].includes(realMissionState)
    if (flying && m.status !== 'running') setMissionStatus('running')
    else if (!flying && m.status === 'running') setMissionStatus('uploaded')
  }, [realMissionState])

  // Sample the drone's position while a mission is running, from the same
  // telemetry stream every screen already reads (real or simulator).
  const sampleRef = useRef(0)
  useEffect(() => {
    if (getActiveMission()?.status !== 'running') return
    const t = telemetry?.data
    if (!t) return
    const now = Date.now()
    if (now - sampleRef.current < 400) return // extra guard on top of the store's own throttle
    sampleRef.current = now
    samplePosition({
      lat: Number(pick(t, ['lat', 'latitude'])),
      lng: Number(pick(t, ['lng', 'lon', 'longitude'])),
      alt: Number(pick(t, ['altitude', 'alt', 'relative_alt'])),
      heading: Number(pick(t, ['heading', 'yaw', 'hdg'])),
    })
  }, [telemetry])

  const value = useMemo(
    () => ({ ping, pi, health, telemetry, backendReachable, simulated, armedSince }),
    [ping, pi, health, telemetry, backendReachable, simulated, armedSince],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
