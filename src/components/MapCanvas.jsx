import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MapContainer, TileLayer, Marker, Circle, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Lazy so three.js only loads when a 3D drone marker is actually shown.
const HoloDrone = lazy(() => import('./HoloDrone'))

// Esri World Imagery — client-side satellite tiles (no key), matching the
// reference's satellite look. This is a map-tile host, not the backend.
const SAT_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ORANGE = '#3B9EFF'

// Icons and style objects are cached / constant: react-leaflet rebuilds a
// marker's DOM (setIcon) or restyles a path whenever it gets a NEW object, and
// the map re-renders with every telemetry update.
const iconCache = new Map()
function cachedIcon(key, make) {
  let ic = iconCache.get(key)
  if (!ic) {
    ic = make()
    iconCache.set(key, ic)
  }
  return ic
}
const PATH_STYLE = { color: ORANGE, weight: 2, opacity: 0.85, dashArray: '2 8' }
const RING_STYLE = { color: ORANGE, weight: 1.5, opacity: 0.7, dashArray: '4 6', fillColor: ORANGE, fillOpacity: 0.05 }
const RANGE_STYLE = { color: ORANGE, weight: 1, opacity: 0.5, fillColor: ORANGE, fillOpacity: 0.04 }

function droneIcon(active = true) {
  return cachedIcon(`drone:${active}`, () => makeDroneIcon(active))
}
function makeDroneIcon(active) {
  const c = active ? ORANGE : '#8A9099'
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;width:38px;height:38px;border-radius:50%;background:${c}22;border:1px solid ${c}66"></div>
      <div style="width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,${c} 60%);box-shadow:0 0 12px ${c}"></div>
    </div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  })
}

function wpIcon(label) {
  return cachedIcon(`wp:${label}`, () => L.divIcon({
    className: '',
    html: `<div style="display:flex;align-items:center;gap:5px">
      <div style="width:22px;height:22px;border-radius:50%;background:${ORANGE}cc;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font:700 10px Inter;box-shadow:0 0 10px ${ORANGE}aa">${label}</div>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  }))
}

// Small triangular arrowhead rotated toward the next point (deg from north).
function arrowIcon(angleDeg0) {
  const angleDeg = Math.round(angleDeg0) // 1° steps: invisible difference, lets icons be reused
  return cachedIcon(`arrow:${angleDeg}`, () => L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${angleDeg}deg);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:11px solid ${ORANGE};filter:drop-shadow(0 0 4px ${ORANGE}aa)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  }))
}

function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLng = (b[1] - a[1]) * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180)
  return (Math.atan2(dLng, dLat) * 180) / Math.PI // 0 = north/up
}

/** Orange flight path with arrowheads + patrol rings at each waypoint. */
const PatrolOverlay = memo(function PatrolOverlay({ home, waypoints }) {
  const homeLat = home?.[0]
  const homeLng = home?.[1]
  const geo = useMemo(() => {
    if (!waypoints || waypoints.length === 0) return null
    const h = homeLat != null && homeLng != null ? [homeLat, homeLng] : null
    const pts = [h, ...waypoints.map((w) => [w.lat, w.lng]), waypoints[0] && [waypoints[0].lat, waypoints[0].lng]].filter(Boolean)
    const segments = []
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]
      segments.push({ mid, ang: bearing(pts[i], pts[i + 1]) })
    }
    const rings = waypoints.map((w) => [w.lat, w.lng])
    return { pts, segments, rings }
  }, [homeLat, homeLng, waypoints])
  if (!geo) return null
  const { pts, segments, rings } = geo
  return (
    <>
      <Polyline positions={pts} pathOptions={PATH_STYLE} />
      {segments.map((s, i) => (
        <Marker key={`arr${i}`} position={s.mid} icon={arrowIcon(s.ang)} interactive={false} />
      ))}
      {waypoints.map((w, i) => (
        <div key={`wp${i}`}>
          <Circle center={rings[i]} radius={w.radius || 110} pathOptions={RING_STYLE} />
          <Marker position={rings[i]} icon={wpIcon(w.label || `W${i + 1}`)} interactive={false} />
        </div>
      ))}
    </>
  )
})

/** DJI-style yellow "H" home-point (Return-to-Home) icon. Cached — Leaflet re-sets icons on every new object. */
let _homeIcon = null
export function homeIcon() {
  if (!_homeIcon) {
    _homeIcon = L.divIcon({
      className: '',
      html: `<div style="width:30px;height:30px;border-radius:50%;background:#F5B400;color:#1a1300;display:flex;align-items:center;justify-content:center;font:800 15px Inter,Arial,sans-serif;border:2px solid #fff;box-shadow:0 0 0 3px rgba(245,180,0,0.35),0 0 14px rgba(245,180,0,0.6);cursor:pointer">H</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    })
  }
  return _homeIcon
}

/**
 * A live, rotating 3D drone rendered on the map at `position`. The Leaflet
 * marker hosts a DOM node that React renders HoloDrone into via a portal.
 */
export function Drone3DMarker({ position, size = 96 }) {
  const map = useMap()
  const markerRef = useRef(null)
  const [host, setHost] = useState(null)

  useEffect(() => {
    const el = document.createElement('div')
    el.style.width = `${size}px`
    el.style.height = `${size}px`
    el.style.pointerEvents = 'none'
    const icon = L.divIcon({ className: '', html: el, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
    const m = L.marker(position, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map)
    markerRef.current = m
    setHost(el)
    return () => {
      m.remove()
      markerRef.current = null
      setHost(null)
    }
    // position intentionally omitted: the marker is created once, then moved below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, size])

  const lat = position?.[0]
  const lng = position?.[1]
  useEffect(() => {
    if (markerRef.current && lat != null && lng != null) markerRef.current.setLatLng([lat, lng])
  }, [lat, lng])

  if (!host) return null
  return createPortal(
    <div style={{ position: 'relative', width: size, height: size }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 40,
          height: 40,
          marginLeft: -20,
          marginTop: -20,
          borderRadius: '50%',
          background: 'rgba(59,158,255,0.18)',
          border: '1px solid rgba(59,158,255,0.6)',
          boxShadow: '0 0 14px rgba(59,158,255,0.5)',
        }}
      />
      <Suspense fallback={null}>
        <HoloDrone height={size} wire={false} />
      </Suspense>
    </div>,
    host,
  )
}

function Recenter({ center }) {
  const map = useMap()
  useEffect(() => {
    if (center) map.setView(center, map.getZoom(), { animate: true })
  }, [center, map])
  return null
}

// droneMarker (optional): a node rendered instead of the default dot marker.
export default function MapCanvas({ center, hasFix, waypoints, children, zoom = 16, droneMarker }) {
  const c = center || [17.385, 78.4867]
  return (
    <MapContainer
      center={c}
      zoom={zoom}
      zoomControl={false}
      attributionControl={false}
      style={{ height: '100%', width: '100%', background: '#0A0C0F' }}
    >
      <TileLayer url={SAT_URL} maxZoom={19} />
      {hasFix && (
        <>
          <Circle center={c} radius={150} pathOptions={RANGE_STYLE} />
          <PatrolOverlay home={c} waypoints={waypoints} />
          {droneMarker ?? <Marker position={c} icon={droneIcon(true)} />}
        </>
      )}
      {center && <Recenter center={center} />}
      {children}
    </MapContainer>
  )
}
