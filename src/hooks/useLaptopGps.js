import { useEffect, useMemo, useRef, useState } from 'react'
import { pick } from '../lib/format'

/**
 * Browser geolocation ("laptop GPS") for testing without the drone.
 * Needs a secure context (localhost or HTTPS) and the user's permission.
 */
export function useLaptopGps(enabled = true) {
  const [pos, setPos] = useState(null) // { lat, lng, accuracy }
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!enabled) return
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setError('Geolocation not supported')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null)
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy })
      },
      (e) => setError(e.message || 'Location unavailable'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  return { pos, error }
}

/**
 * Best available live position: the drone's GPS fix when it has one, otherwise
 * the laptop's location (test mode). Returns a memoised [lat, lng] so map
 * re-centring only happens when the coordinates actually change.
 */
export function useLivePosition(telemetryData) {
  const lat = Number(pick(telemetryData, ['lat', 'latitude']))
  const lng = Number(pick(telemetryData, ['lng', 'lon', 'longitude']))
  const droneFix = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0
  const { pos: gps, error } = useLaptopGps(!droneFix)

  const src = droneFix ? 'drone' : gps ? 'laptop' : null
  const pLat = droneFix ? lat : gps?.lat
  const pLng = droneFix ? lng : gps?.lng
  const position = useMemo(() => (src ? [pLat, pLng] : null), [src, pLat, pLng])

  return {
    position,
    source: src, // 'drone' | 'laptop' | null
    droneFix,
    accuracy: src === 'laptop' ? gps?.accuracy : null,
    error: src ? null : error,
  }
}

// Home position if the backend/simulator reports one explicitly (flat or
// nested); null otherwise. Shared by every screen that needs the true launch
// point, as opposed to the aircraft's current (possibly moving) position.
export function readHomeFromTelemetry(t) {
  if (!t) return null
  const h = t.home || t.home_position || {}
  const lat = Number(pick(t, ['home_lat', 'homeLat']) ?? pick(h, ['lat', 'latitude']))
  const lng = Number(pick(t, ['home_lng', 'home_lon', 'homeLng']) ?? pick(h, ['lng', 'lon', 'longitude']))
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 ? [lat, lng] : null
}

/**
 * The stable "H" / Return-to-Home point — distinct from `useLivePosition`'s
 * `position`, which moves with the aircraft. Prefers an explicit home the
 * backend/simulator reports; otherwise latches onto the first live position
 * seen this session and never drifts after that (so a running mission's
 * drawn path and RTH marker don't chase the moving aircraft). A laptop-GPS
 * home is replaced once a real/simulated drone fix arrives.
 */
export function useHomePoint(telemetryData, live, resetKey) {
  const ref = useRef(null)
  // A home latched from the simulator/laptop must not survive a switch to
  // the real drone (or vice versa): re-latch whenever resetKey changes.
  const keyRef = useRef(resetKey)
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey
    ref.current = null
  }
  if (live.position && (!ref.current || (ref.current.source === 'laptop' && live.source === 'drone'))) {
    ref.current = { pos: live.position, source: live.source }
  }
  const h = readHomeFromTelemetry(telemetryData) || ref.current?.pos || null
  // Same array while the coordinates are unchanged (readHomeFromTelemetry builds
  // a new one per call), so maps/paths drawn from home don't redraw every update.
  const hLat = h ? h[0] : null
  const hLng = h ? h[1] : null
  return useMemo(() => (hLat != null && hLng != null ? [hLat, hLng] : null), [hLat, hLng])
}
