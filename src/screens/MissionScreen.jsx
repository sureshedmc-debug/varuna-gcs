import { lazy, Suspense, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Circle, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { useToast } from '../components/Toast'
import { usePolling } from '../hooks/usePolling'
import { Btn, StatusOrb } from '../components/ui'
import { pick, fmtCoord, num } from '../lib/format'

const HoloDrone = lazy(() => import('../components/HoloDrone'))

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const BLUE = '#3B9EFF'
const MAX_ALT = 120 // hard max height cap (m)
const MAX_SPEED = 15 // max speed cap

function wpIcon(n) {
  return L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(180deg,#6BB8FF,#3B9EFF);color:#04121F;display:flex;align-items:center;justify-content:center;font:700 12px Inter;box-shadow:0 0 12px ${BLUE}aa;border:2px solid #0E1116">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}
function arrowIcon(angle) {
  return L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${angle}deg);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid ${BLUE};filter:drop-shadow(0 0 4px ${BLUE}aa)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
}
function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLng = (b[1] - a[1]) * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180)
  return (Math.atan2(dLng, dLat) * 180) / Math.PI
}
function ClickToAdd({ onAdd }) {
  useMapEvents({ click: (e) => onAdd(e.latlng) })
  return null
}

function Slider({ label, value, set, min, max, step, unit }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        <span className="font-mono text-sm font-bold tnum text-accent">
          {value}
          <span className="ml-0.5 text-[10px] font-normal text-muted">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="w-full accent-accent"
      />
      <div className="mt-0.5 flex justify-between font-mono text-[9px] tnum text-faint">
        <span>{min}{unit}</span>
        <span>max {max}{unit}</span>
      </div>
    </div>
  )
}

let wpid = 1

export default function MissionScreen() {
  const { telemetry } = useSystem()
  const toast = useToast()
  const saved = usePolling(api.missionList, 15000)
  const [wps, setWps] = useState([])
  const [name, setName] = useState('Mission ' + new Date().toLocaleDateString())
  const [alt, setAlt] = useState(10) // global altitude (m) — default 10, capped
  const [speed, setSpeed] = useState(5) // global speed — default 5
  const [busy, setBusy] = useState(null)
  const [open, setOpen] = useState(true)
  const [confirming, setConfirming] = useState(false)

  const home = useMemo(() => {
    const lat = Number(pick(telemetry.data, ['lat', 'latitude']))
    const lng = Number(pick(telemetry.data, ['lng', 'lon', 'longitude']))
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0) return [lat, lng]
    return [17.385, 78.4867]
  }, [telemetry.data])

  const addWp = (ll) => setWps((s) => [...s, { id: wpid++, lat: ll.lat, lng: ll.lng, action: 'waypoint' }])
  const moveWp = (id, ll) => setWps((s) => s.map((w) => (w.id === id ? { ...w, lat: ll.lat, lng: ll.lng } : w)))
  const patchWp = (id, p) => setWps((s) => s.map((w) => (w.id === id ? { ...w, ...p } : w)))
  const removeWp = (id) => setWps((s) => s.filter((w) => w.id !== id))
  const reorder = (id, d) =>
    setWps((s) => {
      const i = s.findIndex((w) => w.id === id)
      const j = i + d
      if (i < 0 || j < 0 || j >= s.length) return s
      const c = [...s]
      ;[c[i], c[j]] = [c[j], c[i]]
      return c
    })

  function askUpload() {
    if (!wps.length) return toast.push({ level: 'warn', title: 'Add at least one waypoint' })
    setConfirming(true)
  }
  async function doUpload() {
    setConfirming(false)
    setBusy('upload')
    try {
      const cappedAlt = Math.min(alt, MAX_ALT)
      const payload = wps.map((w, i) => ({ id: i + 1, lat: w.lat, lng: w.lng, alt: cappedAlt, speed: Number(speed), action: w.action }))
      toast.fromResult(await api.missionUpload(name, payload), 'Mission uploaded')
      saved.refresh()
    } catch {
      toast.push({ level: 'bad', title: 'Upload failed' })
    } finally {
      setBusy(null)
    }
  }
  async function start() {
    setBusy('start')
    try {
      toast.fromResult(await api.missionStart(), 'Mission started')
    } catch {
      toast.push({ level: 'bad', title: 'Start failed' })
    } finally {
      setBusy(null)
    }
  }

  const line = [home, ...wps.map((w) => [w.lat, w.lng])]
  const arrows = []
  for (let i = 0; i < line.length - 1; i++) {
    arrows.push({ mid: [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2], ang: bearing(line[i], line[i + 1]) })
  }
  const savedList = saved.data?.missions || saved.data?.items || (Array.isArray(saved.data) ? saved.data : [])

  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>
      {/* Fullscreen satellite map */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
        <MapContainer center={home} zoom={16} zoomControl={false} attributionControl={false} style={{ height: '100%', width: '100%', background: '#0E1116' }}>
          <TileLayer url={SAT_URL} maxZoom={19} />
          <ClickToAdd onAdd={addWp} />
          {line.length > 1 && <Polyline positions={line} pathOptions={{ color: BLUE, weight: 2.5, opacity: 0.9, dashArray: '2 8' }} />}
          {arrows.map((a, i) => (
            <Marker key={`a${i}`} position={a.mid} icon={arrowIcon(a.ang)} interactive={false} />
          ))}
          {wps.map((w, i) => (
            <div key={w.id}>
              <Circle center={[w.lat, w.lng]} radius={90} pathOptions={{ color: BLUE, weight: 1.2, opacity: 0.6, dashArray: '4 6', fillColor: BLUE, fillOpacity: 0.05 }} />
              <Marker position={[w.lat, w.lng]} icon={wpIcon(i + 1)} draggable eventHandlers={{ dragend: (e) => moveWp(w.id, e.target.getLatLng()) }} />
            </div>
          ))}
        </MapContainer>
      </div>

      {/* Floating title / hint */}
      <div className="absolute left-3 top-3 z-20 glass flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-bold text-ink">MISSION PLANNER</span>
        <span className="hidden text-xs text-muted sm:inline">· tap map to add waypoints · drag to move</span>
      </div>

      {/* Floating editor panel */}
      <motion.div layout className="absolute right-3 top-3 z-20 w-[330px] max-w-[calc(100vw-24px)]">
        <div className="glass p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Flight Plan · {wps.length} WP</span>
            <button onClick={() => setOpen((o) => !o)} className="text-xs text-accent">{open ? 'Hide' : 'Show'}</button>
          </div>
          {open && (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} className="inp mb-3 w-full px-3 py-2 text-sm" placeholder="Mission name" />

              {/* Global altitude + speed bars */}
              <div className="mb-3 flex flex-col gap-3 rounded-lg bg-chip p-3">
                <Slider label="Altitude" value={alt} set={setAlt} min={2} max={MAX_ALT} step={1} unit="m" />
                <Slider label="Speed" value={speed} set={setSpeed} min={1} max={MAX_SPEED} step={0.5} unit="km/h" />
                <div className="text-[10px] text-faint">Applies to all waypoints · height capped at {MAX_ALT} m</div>
              </div>

              <div className="mb-2 flex max-h-[30vh] flex-col gap-1.5 overflow-y-auto pr-1">
                {wps.length === 0 && <div className="py-4 text-center text-sm text-muted">No waypoints yet.</div>}
                {wps.map((w, i) => (
                  <motion.div key={w.id} layout className="flex items-center gap-2 rounded-lg bg-chip px-2.5 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">{i + 1}</span>
                    <span className="flex-1 font-mono text-[10px] tnum text-muted">{fmtCoord(w.lat)}, {fmtCoord(w.lng)}</span>
                    <select value={w.action} onChange={(e) => patchWp(w.id, { action: e.target.value })} className="inp px-1 py-1 text-xs">
                      <option value="waypoint">waypoint</option>
                      <option value="loiter">loiter</option>
                      <option value="land">land</option>
                    </select>
                    <button onClick={() => reorder(w.id, -1)} className="rounded bg-chip2 px-1.5 py-0.5 text-xs text-ink">↑</button>
                    <button onClick={() => reorder(w.id, 1)} className="rounded bg-chip2 px-1.5 py-0.5 text-xs text-ink">↓</button>
                    <button onClick={() => removeWp(w.id)} className="rounded bg-bad/15 px-1.5 py-0.5 text-xs text-bad">✕</button>
                  </motion.div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Btn variant="secondary" disabled={busy === 'upload'} onClick={askUpload}>Upload</Btn>
                <Btn disabled={busy === 'start'} onClick={start}>Start</Btn>
              </div>
            </>
          )}
        </div>
      </motion.div>

      {/* Saved missions (bottom-left) */}
      <div className="absolute bottom-3 left-3 z-20 w-[260px] max-w-[calc(100vw-24px)]">
        <div className="glass p-3">
          <div className="mb-2 eyebrow">Saved Missions</div>
          {savedList.length === 0 ? (
            <div className="text-xs text-muted">None saved.</div>
          ) : (
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
              {savedList.map((m, i) => (
                <div key={i} className="flex items-center justify-between rounded bg-chip px-2 py-1.5 text-xs">
                  <span className="truncate text-ink">{m.name || m.id || `Mission ${i + 1}`}</span>
                  <span className="font-mono text-[10px] tnum text-muted">{num(m.waypoint_count ?? m.count ?? (m.waypoints ? m.waypoints.length : undefined), 0)} wp</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Aircraft preview (bottom-right) — realistic 3D model */}
      <div className="absolute bottom-3 right-3 z-20 w-[220px]">
        <div className="glass overflow-hidden p-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="eyebrow">Aircraft</span>
            <span className="text-[10px] font-bold text-accent">VARUNA-01</span>
          </div>
          <div className="rounded-lg bg-black/20">
            <Suspense fallback={<div style={{ height: 120 }} />}>
              <HoloDrone height={120} wire={false} />
            </Suspense>
          </div>
        </div>
      </div>

      {/* Upload confirmation warning */}
      <AnimatePresence>
        {confirming && (
          <motion.div
            className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setConfirming(false)}
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className="glass w-full max-w-sm p-5 shadow-elev"
            >
              <div className="mb-3 flex items-center gap-2">
                <StatusOrb level="warn" size={14} pulse />
                <h3 className="text-lg font-bold text-ink">Confirm mission upload</h3>
              </div>
              <div className="mb-4 space-y-1.5 rounded-lg bg-chip p-3 text-sm">
                <Row k="Waypoints" v={`${wps.length}`} />
                <Row k="Altitude" v={`${Math.min(alt, MAX_ALT)} m`} />
                <Row k="Speed" v={`${speed} km/h`} />
              </div>
              <p className="mb-4 text-xs leading-relaxed text-warn">
                ⚠ Ensure the airspace is clear, the flight is within your local regulations,
                and the aircraft has sufficient battery. The vehicle may begin autonomous flight once started.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Btn variant="secondary" onClick={() => setConfirming(false)}>Cancel</Btn>
                <Btn onClick={doUpload}>Confirm upload</Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{k}</span>
      <span className="font-mono font-semibold tnum text-ink">{v}</span>
    </div>
  )
}
