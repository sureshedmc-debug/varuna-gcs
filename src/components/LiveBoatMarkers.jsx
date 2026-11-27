import { Marker, Polyline } from 'react-leaflet'
import { useBoat } from './BoatContext'
import { boatIcon } from './BoatParts'

// The boat on the Live tab's maps, next to the drone's finds: where it is and,
// while live collect runs, a line to the item it's going after — so the
// operator sees the drone finding and the boat collecting on one map.

const LINE = { color: '#3B9EFF', weight: 2, dashArray: '6 6', opacity: 0.9 }

/** Leaflet children for a MapContainer. `small` = the picture-in-picture map. */
export default function LiveBoatMarkers({ small = false }) {
  const boat = useBoat()
  const t = boat.reachable === true ? boat.telemetry.data : null
  if (!t || !Number.isFinite(t.lat) || !Number.isFinite(t.lng) || (t.lat === 0 && t.lng === 0)) return null
  const pos = [t.lat, t.lng]
  const cur = boat.live?.state === 'running' ? boat.live.current : null
  return (
    <>
      {cur && Number.isFinite(cur.lat) && Number.isFinite(cur.lng) && (
        <Polyline positions={[pos, [cur.lat, cur.lng]]} pathOptions={small ? { ...LINE, weight: 1.5 } : LINE} interactive={false} />
      )}
      <Marker position={pos} icon={boatIcon(t.heading ?? t.yaw)} interactive={false} zIndexOffset={1000} />
    </>
  )
}
