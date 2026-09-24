import { createContext, useContext, useEffect, useRef } from 'react'
import { api } from '../api/client'
import { usePolling, useNow } from '../hooks/usePolling'
import { useVarunaWS } from '../hooks/useVarunaWS'
import { useLivePosition } from '../hooks/useLaptopGps'
import { setBackendReachable } from '../lib/connectionState'
import { useSimTelemetry, simSetHome } from '../lib/simulator'

const Ctx = createContext(null)
export const useSystem = () => useContext(Ctx)

/** Shared live state: ping, pi metrics, health, and telemetry (WS+fallback). */
export function SystemProvider({ children }) {
  const now = useNow(1000)
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
  const telemetry = simulated ? { data: sim.data, status: 'live', lastUpdate: sim.lastUpdate } : realTelemetry

  const value = { now, ping, pi, health, telemetry, backendReachable, simulated }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
