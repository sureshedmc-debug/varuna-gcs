// The drone's live position on a small floating map (Live tab): where it is,
// which way the camera faces, how sure the GPS is (the circle) and where it has
// been (the trail). With no telemetry link on the drone this is the GPS of the
// VARUNA Cam phone riding on it.

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { MapContainer, Marker, Circle, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import CachedTileLayer from './CachedTileLayer'
import { SAT_URL, homeIcon } from './MapCanvas'
import LiveDetectionMarkers from './LiveDetectionMarkers'
import { StatusOrb } from './ui'
import { api } from '../api/client'
import { fmtCoord, num, pick } from '../lib/format'

const BLUE = '#3B9EFF'
const ACC_STYLE = { color: BLUE, weight: 1, opacity: 0.6, fillColor: BLUE, fillOpacity: 0.12 }
const TRAIL_STYLE = { color: '#7CC4FF', weight: 3, opacity: 0.85 }
const TRAIL_MAX = 400

// Leaflet rebuilds a marker's DOM for every new icon object: cache them (3° steps).
const icons = new Map()
function headingIcon(deg) {
  const key = deg == null || !Number.isFinite(Number(deg)) ? 'dot' : Math.round(Number(deg) / 3) * 3
  let ic = icons.get(key)
  if (ic) return ic
  const arrow = key === 'dot'
    ? `<circle cx="18" cy="18" r="6" fill="${BLUE}" stroke="#fff" stroke-width="2"/>`
    : `<path d="M18 5 L26 28 L18 23 L10 28 Z" fill="${BLUE}" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>`
  ic = L.divIcon({
    className: '',
    html: `<div style="width:36px;height:36px;transform:rotate(${key === 'dot' ? 0 : key}deg);filter:drop-shadow(0 0 6px ${BLUE})">
      <svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="${BLUE}2a" stroke="${BLUE}88"/>${arrow}</svg></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  })
  icons.set(key, ic)
  return ic
}

/** The drone's live readings from the telemetry the whole app shares. */
export function readDroneGps(t) {
  if (!t) return { hasFix: false }
  const lat = Number(pick(t, ['lat', 'latitude']))
  const lng = Number(pick(t, ['lng', 'lon', 'longitude']))
  const hasFix = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
  const phone = t.phone_gps || null
  return {
    hasFix,
    pos: hasFix ? [lat, lng] : null,
    heading: pick(t, ['heading', 'yaw', 'hdg']),
    alt: pick(t, ['altitude', 'relative_alt', 'alt']),
    speed: pick(t, ['speed', 'groundspeed']),
    sats: pick(t, ['satellites', 'satellites_visible', 'sats']),
    acc: pick(t, ['gps_accuracy']) ?? (t.position_source === 'phone' ? phone?.accuracy : null),
    source: t.position_source || (hasFix ? 'pixhawk' : null),
    fix: phone?.fix,
    altSrc: phone?.alt_src,
    problem: phone?.problem || '',
    phoneUp: !!phone?.connected,
    home: t.home && Number.isFinite(t.home.lat) ? [t.home.lat, t.home.lng] : null,
  }
}

/** The path flown, from the backend's history and then each live position. */
export function useDroneTrail(pos) {
  const [trail, setTrail] = useState([])
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    api.telemetryHistory(300).then((h) => {
      const pts = (Array.isArray(h) ? h : []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat !== 0)
        .map((p) => [p.lat, p.lng])
      if (pts.length) setTrail((cur) => (cur.length > pts.length ? cur : pts))
    }).catch(() => {})
  }, [])
  const lat = pos?.[0]
  const lng = pos?.[1]
  useEffect(() => {
    if (lat == null || lng == null) return
    setTrail((cur) => {
      const last = cur[cur.length - 1]
      if (last) {
        const d = metres(last, [lat, lng])
        if (d < 0.8) return cur                 // GPS wander while standing still
        if (d > 2000) return [[lat, lng]]       // somewhere else entirely: start over
      }
      const next = [...cur, [lat, lng]]
      return next.length > TRAIL_MAX ? next.slice(next.length - TRAIL_MAX) : next
    })
  }, [lat, lng])
  return trail
}

function metres(a, b) {
  const n = (b[0] - a[0]) * 111320
  const e = (b[1] - a[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return Math.hypot(n, e)
}

/** Marker, accuracy circle and trail: inside any react-leaflet map. */
export const DroneGpsLayer = memo(function DroneGpsLayer({ pos, heading, acc, trail, home }) {
  return (
    <>
      {trail?.length > 1 && <Polyline positions={trail} pathOptions={TRAIL_STYLE} interactive={false} />}
      {home && <Marker position={home} icon={homeIcon()} interactive={false} />}
      {pos && Number(acc) > 0 && <Circle center={pos} radius={Number(acc)} pathOptions={ACC_STYLE} interactive={false} />}
      {pos && <Marker position={pos} icon={headingIcon(heading)} interactive={false} zIndexOffset={1000} />}
    </>
  )
})

/** Keeps the drone in view: glides along with it unless the operator moved the map. */
function Follow({ pos, follow, onDrag }) {
  const map = useMap()
  const first = useRef(true)
  useEffect(() => {
    const stop = () => onDrag()
    map.on('dragstart', stop)
    return () => { map.off('dragstart', stop) }
  }, [map, onDrag])
  const lat = pos?.[0]
  const lng = pos?.[1]
  useEffect(() => {
    if (!follow || lat == null) return
    if (first.current) { map.setView([lat, lng], 18, { animate: false }); first.current = false }
    else map.panTo([lat, lng], { animate: true, duration: 0.25, easeLinearity: 1 })
  }, [map, lat, lng, follow])
  return null
}

/** Resizes the map when its window grows or shrinks. */
function SizeWatcher({ size }) {
  const map = useMap()
  useEffect(() => { const id = setTimeout(() => map.invalidateSize(), 220); return () => clearTimeout(id) }, [map, size])
  return null
}

const SOURCE_LABEL = { phone: 'Phone GPS', pixhawk: 'Pixhawk GPS' }

export default function DroneMiniMap({ g, trail, onOpenMap }) {
  const [big, setBig] = useState(false)
  const [follow, setFollow] = useState(true)
  const [homeMsg, setHomeMsg] = useState('')
  const stopFollow = useCallback(() => setFollow(false), [])
  async function setHome() {
    if (!window.confirm('Make where the drone is now its take-off point (height 0)?')) return
    try {
      const r = await api.phoneSetHome()
      setHomeMsg(r?.success === false ? (r.message || 'Failed') : 'Take-off point set')
    } catch (e) { setHomeMsg(`Failed: ${e?.message || e}`) }
    setTimeout(() => setHomeMsg(''), 4000)
  }
  const level = !g.hasFix ? 'bad' : g.fix === 'network' || Number(g.acc) > 15 ? 'warn' : 'ok'
  const accTxt = Number(g.acc) > 0 ? `±${Number(g.acc) < 10 ? Number(g.acc).toFixed(1) : Math.round(g.acc)} m` : null
  const altTxt = g.alt != null && g.hasFix ? `${num(g.alt, 1)} m up${g.altSrc === 'gps' ? ' (GPS)' : ''}` : null
  return (
    <div
      className="flex flex-col overflow-hidden rounded-2xl transition-[width] duration-200"
      style={{
        width: big ? 'min(440px, calc(100vw - 1.5rem))' : 'min(270px, calc(100vw - 1.5rem))',
        background: 'rgba(13,17,26,0.9)',
        border: '1px solid rgba(255,255,255,0.12)',
        backdropFilter: 'blur(16px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <StatusOrb level={level} size={8} pulse={!g.hasFix} />
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink">Drone</span>
        {g.source && (
          <span className="rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
            style={{ background: 'rgba(59,158,255,0.16)', color: '#9CCBFF' }}>
            {SOURCE_LABEL[g.source] || g.source}
          </span>
        )}
        <span className="flex-1" />
        {!follow && g.hasFix && (
          <button onClick={() => setFollow(true)} title="Follow the drone"
            className="rounded-md px-1.5 py-0.5 text-[10px] font-bold text-accent hover:bg-white/10">Follow</button>
        )}
        <button onClick={() => setBig((v) => !v)} title={big ? 'Smaller' : 'Bigger'}
          className="rounded-md px-1.5 text-[13px] text-muted hover:bg-white/10 hover:text-ink">{big ? '▭' : '⤢'}</button>
        {onOpenMap && (
          <button onClick={onOpenMap} title="Full map"
            className="rounded-md px-1.5 text-[13px] text-muted hover:bg-white/10 hover:text-ink">⛶</button>
        )}
      </div>

      {/* Map */}
      <div className="relative isolate" style={{ height: big ? 300 : 150 }}>
        <MapContainer
          center={g.pos || [17.385, 78.4867]}
          zoom={g.pos ? 18 : 3}
          zoomControl={false}
          attributionControl={false}
          style={{ height: '100%', width: '100%', background: '#0A0C0F' }}
        >
          <CachedTileLayer url={SAT_URL} maxZoom={19} />
          <LiveDetectionMarkers small />
          <DroneGpsLayer pos={g.pos} heading={g.heading} acc={g.acc} trail={trail} home={g.home} />
          <Follow pos={g.pos} follow={follow} onDrag={stopFollow} />
          <SizeWatcher size={big} />
        </MapContainer>
        {!g.hasFix && (
          <div className="absolute inset-0 z-[500] flex flex-col items-center justify-center gap-1 px-3 text-center"
            style={{ background: 'rgba(8,12,20,0.72)' }}>
            <span className="text-[12px] font-bold text-ink">Waiting for the drone's GPS…</span>
            <span className="text-[10px] leading-snug text-muted">
              {g.problem || (g.phoneUp ? 'The phone is looking for satellites: open sky helps.' : 'Start VARUNA Cam on the drone’s phone.')}
            </span>
          </div>
        )}
      </div>

      {/* Readout */}
      <div className="px-3 py-1.5">
        <div className="font-mono text-[12.5px] font-bold leading-tight tnum text-ink">
          {g.hasFix ? `${fmtCoord(g.pos[0])}, ${fmtCoord(g.pos[1])}` : '—'}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] font-semibold text-muted tnum">
          {accTxt && <span style={{ color: level === 'ok' ? '#7BE495' : '#FFC46B' }}>{accTxt}</span>}
          {(g.hasFix || g.phoneUp) && g.sats != null && <span>{num(g.sats, 0)} sats</span>}
          {altTxt && <span>{altTxt}</span>}
          {g.hasFix && g.speed != null && <span>{num(g.speed, 1)} m/s</span>}
          {g.hasFix && g.heading != null && <span>{num(g.heading, 0)}°</span>}
          {g.fix === 'network' && <span style={{ color: '#FFC46B' }}>rough (no GPS fix yet)</span>}
        </div>
        {big && g.source === 'phone' && g.hasFix && (
          <div className="mt-1 flex items-center gap-2">
            <button onClick={setHome}
              className="rounded-md px-2 py-0.5 text-[10px] font-bold text-ink"
              style={{ background: 'rgba(245,180,0,0.18)', border: '1px solid rgba(245,180,0,0.4)' }}>
              Set take-off point here
            </button>
            {homeMsg && <span className="text-[10px] text-muted">{homeMsg}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
