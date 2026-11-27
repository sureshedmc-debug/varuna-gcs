import { useEffect, useMemo, useState } from 'react'
import { Marker, Polygon } from 'react-leaflet'
import L from 'leaflet'
import { api } from '../api/client'
import { DEFAULT_FENCE_M, missionFence } from '../lib/missionFence'

const FENCE_STYLE = { color: '#FF9F0A', weight: 2, opacity: 0.9, dashArray: '10 6', fillColor: '#FF9F0A', fillOpacity: 0.04 }

const labelIcon = (m) => L.divIcon({
  className: '',
  iconSize: [0, 0],
  html: `<div style="transform:translate(-50%,-130%);white-space:nowrap;font:600 10px/1.2 system-ui,sans-serif;
    color:#FF9F0A;background:rgba(0,0,0,0.72);border:1px solid rgba(255,159,10,0.5);border-radius:6px;padding:2px 6px">
    GEOFENCE · ${m} m</div>`,
})

/** The drone Pi's live mission_fence_m setting (metres; 0 = fence off). */
function useFenceMargin() {
  const [m, setM] = useState(DEFAULT_FENCE_M)
  useEffect(() => {
    let alive = true
    api.getConfig()
      .then((cfg) => {
        const v = Number(cfg?.mission_fence_m?.value)
        if (alive && Number.isFinite(v)) setM(v)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return m
}

/**
 * The geofence the drone will be held inside during this mission, drawn around
 * home and the waypoints (the Pi uploads the same shape to the Pixhawk).
 * home: [lat, lng]; waypoints: [{lat, lng}, …].
 */
export default function MissionFenceLayer({ home, waypoints }) {
  const margin = useFenceMargin()
  const poly = useMemo(() => {
    if (!waypoints?.length) return null
    return missionFence([home, ...waypoints.map((w) => [w.lat, w.lng])], margin)
  }, [home, waypoints, margin])
  if (!poly) return null
  // Not interactive: clicks inside the fence still add waypoints. The label sits
  // on the fence's northernmost corner.
  const top = poly.reduce((a, p) => (p[0] > a[0] ? p : a), poly[0])
  return (
    <>
      <Polygon positions={poly} pathOptions={FENCE_STYLE} interactive={false} />
      <Marker position={top} icon={labelIcon(margin)} interactive={false} />
    </>
  )
}
