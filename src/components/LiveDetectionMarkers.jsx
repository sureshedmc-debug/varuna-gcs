import { useEffect, useState } from 'react'
import L from 'leaflet'
import { Marker, Popup } from 'react-leaflet'
import { useTrashLog } from '../lib/trashLog'
import { fmtLength } from '../lib/sizeEstimate'

// Plastic the AI has seen, on the Live tab's maps as it happens: every located
// sighting is a marker the moment it is logged (trashLog updates up to twice a
// second while detection runs), and a spot seen in the last few seconds pulses.

const FRESH_MS = 8000
const MAX_MARKERS = 300
const COLOR = { drone: '#32D74B', sim: '#F59E0B', laptop: '#FF9F0A' }

const iconCache = new Map()
function plasticIcon(count, color, fresh, small) {
  const n = Math.min(99, Math.max(1, Number(count) || 1))
  const key = `${n}:${color}:${fresh}:${small}`
  let ic = iconCache.get(key)
  if (!ic) {
    const d = small ? 14 : 22
    const ring = fresh
      ? `<span style="position:absolute;inset:-7px;border-radius:50%;border:2px solid ${color};animation:plastic-ping 1.4s ease-out infinite"></span>`
      : ''
    ic = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:${d}px;height:${d}px">${ring}<div style="width:${d}px;height:${d}px;border-radius:50%;background:${color};opacity:${fresh ? 1 : 0.78};border:2px solid #0E1116;box-shadow:0 0 ${fresh ? 14 : 6}px ${color};display:flex;align-items:center;justify-content:center;color:#04121F;font:700 ${small ? 8 : 11}px Inter">${small ? '' : n}</div></div>`,
      iconSize: [d, d], iconAnchor: [d / 2, d / 2],
    })
    iconCache.set(key, ic)
  }
  return ic
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(ms).toLocaleTimeString()
}

/** Leaflet children for a MapContainer. `small` = the picture-in-picture map (no counts, no popups). */
export default function LiveDetectionMarkers({ small = false }) {
  const log = useTrashLog()
  // Re-render every 2 s so "fresh" fades even when nothing new is logged.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const now = Date.now()
  const spots = log.filter((e) => e.located && Number.isFinite(e.lat) && Number.isFinite(e.lng)).slice(0, MAX_MARKERS)
  return spots.map((e) => {
    const fresh = now - (e.lastSeen || 0) < FRESH_MS
    const color = COLOR[e.posSource] || COLOR.drone
    return (
      <Marker key={e.id} position={[e.lat, e.lng]} icon={plasticIcon(e.count, color, fresh, small)}
        interactive={!small} zIndexOffset={fresh ? 900 : 0}>
        {!small && (
          <Popup>
            <div style={{ minWidth: 170, font: '12px Inter' }}>
              <div style={{ fontWeight: 700, textTransform: 'capitalize' }}>{e.class || 'plastic'}{e.count > 1 ? ` ×${e.count}` : ''}</div>
              <div>{e.confidence != null ? `${Math.round(e.confidence * 100)}% sure · ` : ''}{ago(e.lastSeen || e.firstSeen)}</div>
              {e.largestM > 0 && <div>Largest item ≈{fmtLength(e.largestM)}</div>}
              <div style={{ opacity: 0.75 }}>
                {e.posMethod === 'picture' ? 'Placed on the item' : e.posSource === 'laptop' ? "Laptop's location" : 'Where the drone was'}
              </div>
              {e.photo && <img src={e.photo} alt="" style={{ marginTop: 6, width: 160, borderRadius: 6 }} />}
            </div>
          </Popup>
        )}
      </Marker>
    )
  })
}
