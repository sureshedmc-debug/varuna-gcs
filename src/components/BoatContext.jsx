import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { boatApi, boatWsUrl, isBoatReply } from '../api/boatClient'
import { usePolling } from '../hooks/usePolling'
import { useVarunaWS } from '../hooks/useVarunaWS'
import { markCollected } from '../lib/boatStore'
import { useLiveCollectFeed } from '../lib/liveCollectFeed'

const Ctx = createContext(null)
export const useBoat = () => useContext(Ctx)

/**
 * Shared live state for the boat (the second vehicle, with its own Pi).
 * Mounted once for the whole app, next to SystemProvider, so the link and the
 * collection progress keep being tracked whichever tab is open.
 *
 * `reachable`: true = a real VARUNA boat answered; false = no answer, or an
 * answer from something that is not the boat (e.g. the drone's Pi);
 * undefined = still checking.
 */
export function BoatProvider({ children }) {
  const ping = usePolling(boatApi.ping, 4000)
  const isBoat = isBoatReply(ping.data)
  const reachable = ping.error || (ping.data && !isBoat) ? false : isBoat ? true : undefined
  const wrongTarget = !!ping.data && !ping.data._httpError && !isBoat
  // Why it's offline, in the proxy's own words (e.g. "Boat address not set").
  const linkHint = reachable === false
    ? (typeof ping.data?._raw === 'string' && ping.data._raw.length < 160 ? ping.data._raw : ping.data?.message || (ping.error ? 'No answer from the boat' : ''))
    : ''

  // Open the socket once the boat has answered, and keep it (it reconnects by
  // itself) so a single slow ping doesn't tear the live view down.
  const seenRef = useRef(false)
  if (reachable === true) seenRef.current = true
  const telemetry = useVarunaWS({
    pollInterval: 2000,
    url: boatWsUrl,
    fetchTelemetry: boatApi.telemetry,
    enabled: seenRef.current,
  })

  const t = reachable === true ? telemetry.data : null
  const live = reachable === true && t?.vehicle === 'boat'
  const fcConnected = live && t.fc_connected === true
  const mission = live ? t.mission || null : null

  // Items the boat reports as reached → collected (kept in this browser).
  const reachedKey = (mission?.reached || []).join('|')
  const missionName = mission?.name
  const lastKeyRef = useRef('')
  useEffect(() => {
    if (!reachedKey || reachedKey === lastKeyRef.current) return
    lastKeyRef.current = reachedKey
    markCollected(reachedKey.split('|'), missionName)
  }, [reachedKey, missionName])

  // Live collect: send the drone's finds to the boat as they come, and mark
  // what it collects (kept in this browser, like mission items).
  const liveState = live ? t.live || null : null
  useLiveCollectFeed(liveState, reachable === true)
  const liveKey = (liveState?.collected || []).join('|')
  const lastLiveRef = useRef('')
  useEffect(() => {
    if (!liveKey || liveKey === lastLiveRef.current) return
    lastLiveRef.current = liveKey
    markCollected(liveKey.split('|'), 'Live collect')
  }, [liveKey])

  const value = useMemo(
    () => ({
      reachable,
      wrongTarget,
      linkHint,
      lastPing: ping.lastUpdate,
      refreshPing: ping.refresh,
      telemetry: live ? telemetry : { data: null, status: 'offline', lastUpdate: 0 },
      fcConnected,
      mission,
      live: liveState,
      simulated: live && t.simulated === true,
    }),
    [reachable, wrongTarget, linkHint, ping.lastUpdate, ping.refresh, live, telemetry, fcConnected, mission, liveState, t?.simulated],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
