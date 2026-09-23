import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Circle, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Esri World Imagery — client-side satellite tiles (no key), matching the
// reference's satellite look. This is a map-tile host, not the backend.
const SAT_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ORANGE = '#3B9EFF'

function droneIcon(active = true) {
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
  return L.divIcon({
    className: '',
    html: `<div style="display:flex;align-items:center;gap:5px">
      <div style="width:22px;height:22px;border-radius:50%;background:${ORANGE}cc;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font:700 10px Inter;box-shadow:0 0 10px ${ORANGE}aa">${label}</div>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

// Small triangular arrowhead rotated toward the next point (deg from north).
function arrowIcon(angleDeg) {
  return L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${angleDeg}deg);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:11px solid ${ORANGE};filter:drop-shadow(0 0 4px ${ORANGE}aa)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
}

function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLng = (b[1] - a[1]) * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180)
  return (Math.atan2(dLng, dLat) * 180) / Math.PI // 0 = north/up
}

/** Orange flight path with arrowheads + patrol rings at each waypoint. */
function PatrolOverlay({ home, waypoints }) {
  if (!waypoints || waypoints.length === 0) return null
  const pts = [home, ...waypoints.map((w) => [w.lat, w.lng]), waypoints[0] && [waypoints[0].lat, waypoints[0].lng]].filter(Boolean)
  const segments = []
  for (let i = 0; i < pts.length - 1; i++) {
    const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]
    segments.push({ mid, ang: bearing(pts[i], pts[i + 1]) })
  }
  return (
    <>
      <Polyline positions={pts} pathOptions={{ color: ORANGE, weight: 2, opacity: 0.85, dashArray: '2 8' }} />
      {segments.map((s, i) => (
        <Marker key={`arr${i}`} position={s.mid} icon={arrowIcon(s.ang)} interactive={false} />
      ))}
      {waypoints.map((w, i) => (
        <div key={`wp${i}`}>
          <Circle
            center={[w.lat, w.lng]}
            radius={w.radius || 110}
            pathOptions={{ color: ORANGE, weight: 1.5, opacity: 0.7, dashArray: '4 6', fillColor: ORANGE, fillOpacity: 0.05 }}
          />
          <Marker position={[w.lat, w.lng]} icon={wpIcon(w.label || `W${i + 1}`)} interactive={false} />
        </div>
      ))}
    </>
  )
}

function Recenter({ center }) {
  const map = useMap()
  useEffect(() => {
    if (center) map.setView(center, map.getZoom(), { animate: true })
  }, [center, map])
  return null
}

export default function MapCanvas({ center, hasFix, waypoints, children, zoom = 16 }) {
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
          <Circle center={c} radius={150} pathOptions={{ color: ORANGE, weight: 1, opacity: 0.5, fillColor: ORANGE, fillOpacity: 0.04 }} />
          <PatrolOverlay home={c} waypoints={waypoints} />
          <Marker position={c} icon={droneIcon(true)} />
        </>
      )}
      {center && <Recenter center={center} />}
      {children}
    </MapContainer>
  )
}
