import { createContext, useContext } from 'react'
import { api } from '../api/client'
import { usePolling, useNow } from '../hooks/usePolling'
import { useVarunaWS } from '../hooks/useVarunaWS'

const Ctx = createContext(null)
export const useSystem = () => useContext(Ctx)

/** Shared live state: ping, pi metrics, health, and telemetry (WS+fallback). */
export function SystemProvider({ children }) {
  const now = useNow(1000)
  const ping = usePolling(api.ping, 4000)
  const pi = usePolling(api.piMetrics, 6000)
  const health = usePolling(api.health, 5000)
  const telemetry = useVarunaWS({ pollInterval: 2000 })

  // Reachable only on a real 2xx ping. An HTTP error (proxy 500, gateway down)
  // sets _httpError and must count as unreachable, not "reachable".
  const backendReachable =
    ping.error || ping.data?._httpError ? false : ping.data ? true : undefined

  const value = { now, ping, pi, health, telemetry, backendReachable }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
