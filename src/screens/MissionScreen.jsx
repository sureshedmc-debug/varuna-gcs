import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, Circle, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { useToast } from '../components/Toast'
import { usePolling } from '../hooks/usePolling'
import { Btn, StatusOrb, CommandButton, CommandPanel } from '../components/ui'
import { fmtCoord, num } from '../lib/format'
import { useLivePosition, useHomePoint } from '../hooks/useLaptopGps'
import { homeIcon, Drone3DMarker } from '../components/MapCanvas'
import { cmd, isOk } from '../lib/commands'
import { planKey, useActiveMission, getActiveMission, missionFor } from '../lib/missionStore'
import { usePlanDraft, consumePlanDraft, setMissionMapView } from '../lib/planDraftStore'
import { MAX_ALT, MAX_SPEED } from '../lib/missionPatterns'

const DEFAULT_HOME = [17.385, 78.4867]

const HoloDrone = lazy(() => import('../components/HoloDrone'))

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const BLUE = '#3B9EFF'

// Cached icons + constant styles: react-leaflet rebuilds a marker (setIcon) or
// restyles a path whenever it receives a NEW object, and this screen
// re-renders with every telemetry update.
const iconCache = new Map()
function cachedIcon(key, make) {
  let ic = iconCache.get(key)
  if (!ic) {
    ic = make()
    iconCache.set(key, ic)
  }
  return ic
}
const PATH_STYLE = { color: BLUE, weight: 2.5, opacity: 0.9, dashArray: '2 8' }
const RING_STYLE = { color: BLUE, weight: 1.2, opacity: 0.6, dashArray: '4 6', fillColor: BLUE, fillOpacity: 0.05 }
const LAKE_STYLE = { color: '#5AC8FA', weight: 1.5, opacity: 0.8, fillColor: '#5AC8FA', fillOpacity: 0.08, dashArray: '6 6' }

function wpIcon(n) {
  return cachedIcon(`wp:${n}`, () => L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(180deg,#6BB8FF,#3B9EFF);color:#04121F;display:flex;align-items:center;justify-content:center;font:700 12px Inter;box-shadow:0 0 12px ${BLUE}aa;border:2px solid #0E1116">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  }))
}
function arrowIcon(angle0) {
  const angle = Math.round(angle0) // 1° steps: invisible, lets icons be reused
  return cachedIcon(`arrow:${angle}`, () => L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${angle}deg);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid ${BLUE};filter:drop-shadow(0 0 4px ${BLUE}aa)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  }))
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
// Re-centre once whenever the position source changes (none → laptop → drone),
// not on every GPS update, so it never fights the operator while planning.
function RecenterOnSource({ center, source }) {
  const map = useMap()
  const last = useRef(null)
  useEffect(() => {
    if (!source || last.current === source) return
    last.current = source
    map.setView(center, map.getZoom(), { animate: true })
  }, [source, center, map])
  return null
}

// Reports the map centre so the AI assistant can plan "the lake I'm looking at".
function ReportMapView() {
  const map = useMapEvents({ moveend: () => setMissionMapView([map.getCenter().lat, map.getCenter().lng]) })
  useEffect(() => {
    setMissionMapView([map.getCenter().lat, map.getCenter().lng])
  }, [map])
  return null
}
// Zoom the map to a freshly loaded AI draft.
function FitToDraft({ draft }) {
  const map = useMap()
  useEffect(() => {
    if (!draft?.waypoints?.length) return
    map.fitBounds(L.latLngBounds(draft.waypoints), { padding: [60, 60], maxZoom: 18 })
  }, [draft?.id, map]) // eslint-disable-line react-hooks/exhaustive-deps
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

// The editable waypoint rows. Memoised so a telemetry update doesn't re-render
// (and re-measure, for the reorder animation) every row.
const WaypointRows = memo(function WaypointRows({ wps, onPatch, onReorder, onRemove }) {
  return (
    <div className="mb-2 flex max-h-[30vh] flex-col gap-1.5 overflow-y-auto pr-1">
      {wps.length === 0 && <div className="py-4 text-center text-sm text-muted">No waypoints yet.</div>}
      {wps.map((w, i) => (
        <motion.div key={w.id} layout className="flex items-center gap-2 rounded-lg bg-chip px-2.5 py-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">{i + 1}</span>
          <span className="flex-1 font-mono text-[10px] tnum text-muted">{fmtCoord(w.lat)}, {fmtCoord(w.lng)}</span>
          <select value={w.action} onChange={(e) => onPatch(w.id, { action: e.target.value })} className="inp px-1 py-1 text-xs">
            <option value="waypoint">waypoint</option>
            <option value="loiter">loiter</option>
            <option value="land">land</option>
          </select>
          <button onClick={() => onReorder(w.id, -1)} className="rounded bg-chip2 px-1.5 py-0.5 text-xs text-ink">↑</button>
          <button onClick={() => onReorder(w.id, 1)} className="rounded bg-chip2 px-1.5 py-0.5 text-xs text-ink">↓</button>
          <button onClick={() => onRemove(w.id)} className="rounded bg-bad/15 px-1.5 py-0.5 text-xs text-bad">✕</button>
        </motion.div>
      ))}
    </div>
  )
})

export default function MissionScreen() {
  const { telemetry, simulated } = useSystem()
  const toast = useToast()
  const saved = usePolling(api.missionList, 15000)
  const target = simulated ? 'sim' : 'real'
  // Coming back to this tab after uploading: reopen that plan (already saved
  // and uploaded) instead of an empty editor, so it can still be started.
  const [restored] = useState(() => {
    const m = missionFor(getActiveMission(), target)
    if (!m) return null
    const plan = {
      name: m.name,
      wps: m.waypoints.map((w) => ({ id: wpid++, lat: w.lat, lng: w.lng, action: w.action || 'waypoint' })),
      alt: Number(m.altitude) || 10,
      speed: Number(m.speedKmh) || 5,
    }
    return { ...plan, key: planKey(plan.name, plan.wps, Math.min(plan.alt, MAX_ALT), plan.speed) }
  })
  const [wps, setWps] = useState(restored?.wps || [])
  const [name, setName] = useState(restored?.name || 'Mission ' + new Date().toLocaleDateString())
  const [alt, setAlt] = useState(restored?.alt ?? 10) // global altitude (m) — default 10, capped
  const [speed, setSpeed] = useState(restored?.speed ?? 5) // global speed — default 5
  const [busy, setBusy] = useState(null)
  const [open, setOpen] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [savedKey, setSavedKey] = useState(restored?.key ?? null)
  const [uploadedKey, setUploadedKey] = useState(restored?.key ?? null)
  const [aiDraft, setAiDraft] = useState(null) // plan loaded from the AI assistant (shown with a banner + lake outline)

  // A plan generated by the AI assistant: load it into the editor as an unsaved
  // draft. The operator still reviews it and does Save → Upload → Start.
  const draft = usePlanDraft()
  useEffect(() => {
    if (!draft || draft.consumed) return
    consumePlanDraft(draft.id)
    setWps(draft.waypoints.map(([lat, lng]) => ({ id: wpid++, lat, lng, action: 'waypoint' })))
    setAlt(draft.altitude)
    setSpeed(draft.speedKmh)
    setName(draft.name)
    setAiDraft(draft)
    setOpen(true)
  }, [draft])

  // Drone GPS when it has a fix, otherwise laptop GPS (test mode), otherwise a default.
  const live = useLivePosition(telemetry.data)
  // The fixed launch/home point — the path is drawn from here and never
  // drifts, even while the aircraft (dronePos, below) is off flying a mission.
  const homePoint = useHomePoint(telemetry.data, live, simulated)
  const home = homePoint || DEFAULT_HOME
  // The aircraft's current (possibly moving, mid-mission) position.
  const dronePos = live.position
  // Only a mission that the current aircraft (sim or real) actually received.
  const activeMission = missionFor(useActiveMission(), target)
  const running = activeMission?.status === 'running'

  // Save → Upload → Run is a strict pipeline: editing the plan after saving
  // (or saving after uploading) changes this key, which automatically
  // invalidates the later checkpoints until the operator redoes them.
  const currentKey = planKey(name, wps, Math.min(alt, MAX_ALT), speed)
  const isSaved = savedKey === currentKey
  const isUploaded = uploadedKey === currentKey && !!activeMission

  // Stable (useCallback) so the memoised map layers / rows below can skip re-rendering.
  const addWp = useCallback((ll) => setWps((s) => [...s, { id: wpid++, lat: ll.lat, lng: ll.lng, action: 'waypoint' }]), [])
  const moveWp = useCallback((id, ll) => setWps((s) => s.map((w) => (w.id === id ? { ...w, lat: ll.lat, lng: ll.lng } : w))), [])
  const patchWp = useCallback((id, p) => setWps((s) => s.map((w) => (w.id === id ? { ...w, ...p } : w))), [])
  const removeWp = useCallback((id) => setWps((s) => s.filter((w) => w.id !== id)), [])
  const reorder = useCallback(
    (id, d) =>
      setWps((s) => {
        const i = s.findIndex((w) => w.id === id)
        const j = i + d
        if (i < 0 || j < 0 || j >= s.length) return s
        const c = [...s]
        ;[c[i], c[j]] = [c[j], c[i]]
        return c
      }),
    [],
  )

  function saveMission() {
    if (!wps.length) return toast.push({ level: 'warn', title: 'Add at least one waypoint' })
    setSavedKey(currentKey)
    toast.push({ level: 'ok', title: 'Mission saved', msg: 'Now upload it to enable Start.' })
  }
  function askUpload() {
    setConfirming(true)
  }
  async function doUpload() {
    setConfirming(false)
    setBusy('upload')
    try {
      const cappedAlt = Math.min(alt, MAX_ALT)
      const simpleWps = wps.map((w) => ({ lat: w.lat, lng: w.lng, action: w.action }))
      const res = await cmd.missionUpload(name, simpleWps, { altitude: cappedAlt, speedKmh: Number(speed) })
      toast.fromResult(res, 'Mission uploaded')
      if (isOk(res)) setUploadedKey(currentKey)
      saved.refresh()
    } catch (e) {
      toast.push({ level: 'bad', title: `Upload failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }
  async function start() {
    setBusy('start')
    try {
      toast.fromResult(await cmd.missionStart(), 'Mission started')
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }

  async function emergencyStop() {
    setBusy('stop')
    try {
      toast.fromResult(await cmd.emergencyStop(), 'Emergency stop sent')
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }

  // Path, arrows and waypoint markers only rebuild when the plan (or home) changes —
  // not on every telemetry update.
  const planLayers = useMemo(() => {
    const line = [home, ...wps.map((w) => [w.lat, w.lng])]
    const arrows = []
    for (let i = 0; i < line.length - 1; i++) {
      arrows.push({ mid: [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2], ang: bearing(line[i], line[i + 1]) })
    }
    return (
      <>
        {line.length > 1 && <Polyline positions={line} pathOptions={PATH_STYLE} />}
        {arrows.map((a, i) => (
          <Marker key={`a${i}`} position={a.mid} icon={arrowIcon(a.ang)} interactive={false} />
        ))}
        {wps.map((w, i) => (
          <div key={w.id}>
            <Circle center={line[i + 1]} radius={90} pathOptions={RING_STYLE} />
            <Marker position={line[i + 1]} icon={wpIcon(i + 1)} draggable eventHandlers={{ dragend: (e) => moveWp(w.id, e.target.getLatLng()) }} />
          </div>
        ))}
      </>
    )
  }, [home, wps, moveWp])
  const lakePositions = useMemo(
    () => aiDraft?.polygon?.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [lat, lng])),
    [aiDraft],
  )
  const savedList = saved.data?.missions || saved.data?.items || (Array.isArray(saved.data) ? saved.data : [])

  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>
      {/* Fullscreen satellite map */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
        <MapContainer center={home} zoom={16} zoomControl={false} attributionControl={false} style={{ height: '100%', width: '100%', background: '#0E1116' }}>
          <TileLayer url={SAT_URL} maxZoom={19} />
          <ClickToAdd onAdd={addWp} />
          <RecenterOnSource center={home} source={live.source} />
          <ReportMapView />
          <FitToDraft draft={aiDraft} />
          {aiDraft?.polygon && <Polygon positions={lakePositions} pathOptions={LAKE_STYLE} interactive={false} />}
          {live.source && <Marker position={home} icon={homeIcon()} interactive={false} />}
          {dronePos && <Drone3DMarker position={dronePos} size={64} />}
          {planLayers}
        </MapContainer>
      </div>

      {/* Floating title / hint */}
      <div className="absolute left-3 top-3 z-20 glass flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-bold text-ink">MISSION PLANNER</span>
        <span className="hidden text-xs text-muted sm:inline">· tap map to add waypoints · drag to move</span>
        <span
          className="ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
          style={
            live.source === 'drone'
              ? { background: 'rgba(50,215,75,0.16)', color: '#32D74B' }
              : live.source === 'laptop'
                ? { background: 'rgba(255,159,10,0.16)', color: '#FF9F0A' }
                : { background: 'rgba(255,69,58,0.16)', color: '#FF453A' }
          }
          title={live.error || undefined}
        >
          {live.source === 'drone' ? 'DRONE GPS' : live.source === 'laptop' ? 'LAPTOP GPS · TEST' : 'NO GPS · DEFAULT'}
        </span>
        {simulated && (
          <span className="ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(245,158,11,0.16)', color: '#F59E0B' }}>
            SIMULATED
          </span>
        )}
      </div>

      {/* Floating editor panel */}
      {/* z-30 + capped height: a long plan must never slide under the aircraft
          preview (bottom-right, z-20) and hide the Start button. */}
      <motion.div className="absolute right-3 top-3 z-30 w-[330px] max-w-[calc(100vw-24px)]">
        <div className="glass max-h-[calc(100vh-66px-24px)] overflow-y-auto p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Flight Plan · {wps.length} WP</span>
            <button onClick={() => setOpen((o) => !o)} className="text-xs text-accent">{open ? 'Hide' : 'Show'}</button>
          </div>
          {open && aiDraft && (
            <div className="mb-3 rounded-lg border border-accent/30 bg-accent/10 p-2.5 text-[11px]">
              <div className="flex items-start justify-between gap-2">
                <span className="font-bold text-accent">✨ AI draft</span>
                <button
                  onClick={() => {
                    setWps([])
                    setAiDraft(null)
                  }}
                  className="font-semibold text-muted hover:text-bad"
                >
                  Discard
                </button>
              </div>
              <div className="mt-0.5 text-ink">{aiDraft.summary}</div>
              {aiDraft.warnings?.map((w) => (
                <div key={w} className="mt-0.5 text-warn">⚠ {w}</div>
              ))}
              <div className="mt-1 text-muted">Review the path, then Save → Upload → Start.</div>
            </div>
          )}
          {open && (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} className="inp mb-3 w-full px-3 py-2 text-sm" placeholder="Mission name" />

              {/* Global altitude + speed bars */}
              <div className="mb-3 flex flex-col gap-3 rounded-lg bg-chip p-3">
                <Slider label="Altitude" value={alt} set={setAlt} min={2} max={MAX_ALT} step={1} unit="m" />
                <Slider label="Speed" value={speed} set={setSpeed} min={1} max={MAX_SPEED} step={0.5} unit="km/h" />
                <div className="text-[10px] text-faint">Applies to all waypoints · height capped at {MAX_ALT} m</div>
              </div>

              <WaypointRows wps={wps} onPatch={patchWp} onReorder={reorder} onRemove={removeWp} />
              <div className="grid grid-cols-2 items-center gap-2">
                <Btn variant={isSaved ? 'secondary' : 'primary'} disabled={!wps.length} onClick={saveMission}>
                  {isSaved ? '✓ Saved' : 'Save'}
                </Btn>
                <Btn variant={isUploaded ? 'secondary' : 'primary'} disabled={!isSaved || busy === 'upload'} onClick={askUpload}>
                  {busy === 'upload' ? 'Uploading…' : isUploaded ? '✓ Uploaded' : 'Upload'}
                </Btn>
              </div>
              <div className="mt-3 flex flex-col items-center gap-1.5">
                <CommandButton cmd="mission" disabled={!isUploaded || running || busy === 'start'} onConfirm={start} />
                <span className="text-center text-[10px] text-faint">
                  {!isSaved
                    ? 'Save the plan, then upload it, then Start.'
                    : !isUploaded
                      ? 'Upload the saved mission to enable Start.'
                      : running
                        ? 'Mission running…'
                        : 'Ready — press Start to fly it.'}
                </span>
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

      {/* Emergency stop (bottom-center) — always visible, even with the editor collapsed */}
      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <CommandPanel>
          <CommandButton cmd="stop" disabled={busy === 'stop'} onConfirm={emergencyStop} />
        </CommandPanel>
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
