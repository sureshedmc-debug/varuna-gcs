import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Polyline, Polygon, Circle, useMap, useMapEvents } from 'react-leaflet'
import CachedTileLayer from '../components/CachedTileLayer'
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
import { MAX_ALT, MAX_SPEED, distanceM } from '../lib/missionPatterns'
import SavePlanMapButton from '../components/SavePlanMapButton'
import MissionFenceLayer from '../components/MissionFenceLayer'
import { useLivePlan, setActiveSection, endLivePlan, claimPlanName, isSectionUploaded } from '../lib/liveMissionPlan'

const DEFAULT_HOME = [17.385, 78.4867]
const HoloDrone   = lazy(() => import('../components/HoloDrone'))
const SAT_URL     = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const BLUE        = '#3B9EFF'

// ── Map icon helpers (unchanged — same logic, same visual) ────────────────────
const iconCache = new Map()
function cachedIcon(key, make) {
  let ic = iconCache.get(key)
  if (!ic) { ic = make(); iconCache.set(key, ic) }
  return ic
}
const PATH_STYLE = { color: BLUE, weight: 2.5, opacity: 0.9, dashArray: '2 8' }
const RING_STYLE = { color: BLUE, weight: 1.2, opacity: 0.6, dashArray: '4 6', fillColor: BLUE, fillOpacity: 0.05 }
// Live Mission Plan: the whole planned area, and the sections not being edited.
const AREA_STYLE = { color: '#a78bfa', weight: 2, opacity: 0.9, dashArray: '8 6', fillColor: '#a78bfa', fillOpacity: 0.06 }
const OTHER_SECTION_STYLE = { color: '#a78bfa', weight: 3, opacity: 0.55, dashArray: '4 6', bubblingMouseEvents: false }
const LAKE_STYLE = { color: '#5AC8FA', weight: 1.5, opacity: 0.8, fillColor: '#5AC8FA', fillOpacity: 0.08, dashArray: '6 6' }

function wpIcon(n) {
  return cachedIcon(`wp:${n}`, () => L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(180deg,#6BB8FF,#3B9EFF);color:#04121F;display:flex;align-items:center;justify-content:center;font:700 12px Inter;box-shadow:0 0 12px ${BLUE}aa;border:2px solid #0E1116">${n}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  }))
}
function arrowIcon(angle0) {
  const angle = Math.round(angle0)
  return cachedIcon(`arrow:${angle}`, () => L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${angle}deg);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid ${BLUE};filter:drop-shadow(0 0 4px ${BLUE}aa)"></div>`,
    iconSize: [12, 12], iconAnchor: [6, 6],
  }))
}
function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLng = (b[1] - a[1]) * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180)
  return (Math.atan2(dLng, dLat) * 180) / Math.PI
}

// ── Internal map hooks (logic unchanged) ──────────────────────────────────────
function ClickToAdd({ onAdd }) {
  useMapEvents({ click: (e) => onAdd(e.latlng) })
  return null
}
function RecenterOnSource({ center, source }) {
  const map  = useMap()
  const last = useRef(null)
  useEffect(() => {
    if (!source || last.current === source) return
    last.current = source
    map.setView(center, map.getZoom(), { animate: true })
  }, [source, center, map])
  return null
}
function ReportMapView() {
  const map = useMapEvents({ moveend: () => setMissionMapView([map.getCenter().lat, map.getCenter().lng]) })
  useEffect(() => { setMissionMapView([map.getCenter().lat, map.getCenter().lng]) }, [map])
  return null
}
// A Live Mission Plan first shows its whole planned area, then each section.
const areaShown = new Set()
// Keep the planned-area circle clear of the flight-plan panel on the right.
const areaPadding = (map) => ({ paddingTopLeft: [40, 40], paddingBottomRight: [Math.min(420, map.getSize().x * 0.4), 40] })
function FitToDraft({ draft }) {
  const map = useMap()
  useEffect(() => {
    if (!draft?.waypoints?.length) return
    if (draft.area && !areaShown.has(draft.planId)) {
      areaShown.add(draft.planId)
      map.fitBounds(L.latLng(draft.area.center).toBounds(draft.area.radius * 2), areaPadding(map))
      return
    }
    map.fitBounds(L.latLngBounds(draft.waypoints), { padding: [60, 60], maxZoom: 18 })
  }, [draft?.id, map]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
// Circle around every auto-planned section of a Live Mission Plan.
function planArea(plan) {
  const pts = plan?.sectionPlans?.flatMap((p) => p.waypoints) || []
  if (!pts.length) return null
  const lats = pts.map((p) => p[0])
  const lngs = pts.map((p) => p[1])
  const center = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2]
  return { center, radius: Math.max(...pts.map((p) => distanceM(center, p))) + 60 }
}
// A Live Mission Plan opens the map on its river — once per plan, so coming
// back to this tab later doesn't throw away where the operator had panned to.
const flownToPlan = new Set()
function FlyToRiver({ plan }) {
  const map = useMap()
  useEffect(() => {
    const c = plan?.river?.center
    if (!c || flownToPlan.has(plan.missionId)) return
    flownToPlan.add(plan.missionId)
    const area = planArea(plan)
    if (area) map.fitBounds(L.latLng(area.center).toBounds(area.radius * 2), areaPadding(map))
    else map.setView(c, plan.river.zoom || 14, { animate: true })
  }, [plan?.missionId, map]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// ── Slider (redesigned label row) ────────────────────────────────────────────
function Slider({ label, value, set, min, max, step, unit }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        <span className="font-mono text-sm font-bold tnum text-accent">
          {value}<span className="ml-0.5 text-[10px] font-normal text-muted">{unit}</span>
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="w-full accent-accent"
        style={{ height: 4 }}
      />
      <div className="mt-1 flex justify-between font-mono text-[9px] tnum text-faint">
        <span>{min}{unit}</span><span>max {max}{unit}</span>
      </div>
    </div>
  )
}

// ── Pipeline step indicator ───────────────────────────────────────────────────
function PipelineSteps({ isSaved, isUploaded }) {
  const steps = [
    { label: 'Save',   done: isSaved,    active: !isSaved },
    { label: 'Upload', done: isUploaded, active: isSaved && !isUploaded },
    { label: 'Start',  done: false,       active: isUploaded },
  ]
  return (
    <div className="mb-3 flex items-center">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center" style={{ flex: i < steps.length - 1 ? 1 : 'none' }}>
          <div className="flex flex-col items-center gap-1">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all"
              style={
                s.done
                  ? { background: 'rgba(59,158,255,0.2)', border: '2px solid var(--accent-hex)', color: 'var(--accent-hex)' }
                  : s.active
                    ? { background: 'var(--accent-hex)', border: '2px solid var(--accent-hex)', color: '#04121F' }
                    : { background: 'transparent', border: '2px solid var(--faint)', color: 'var(--faint)' }
              }
            >
              {s.done ? '✓' : i + 1}
            </div>
            <span className="text-[9px] font-semibold uppercase tracking-wider"
              style={{ color: s.done || s.active ? 'var(--muted)' : 'var(--faint)' }}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className="mx-1 mb-4 h-[2px] flex-1 rounded-full transition-all"
              style={{ background: s.done ? 'var(--accent-hex)' : 'var(--chip2)' }} />
          )}
        </div>
      ))}
    </div>
  )
}

let wpid = 1

// ── Waypoint rows (redesigned look, same logic) ───────────────────────────────
const WaypointRows = memo(function WaypointRows({ wps, onPatch, onReorder, onRemove }) {
  return (
    <div className="mb-3 flex max-h-[28vh] flex-col gap-1.5 overflow-y-auto pr-1">
      {wps.length === 0 && (
        <div className="py-5 text-center text-sm text-muted">
          No waypoints yet — tap the map to add.
        </div>
      )}
      {wps.map((w, i) => (
        <motion.div
          key={w.id} layout
          className="flex items-center gap-2 rounded-xl px-3 py-2"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Number badge */}
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: 'rgba(59,158,255,0.18)', color: 'var(--accent-hex)' }}
          >
            {i + 1}
          </span>
          {/* Coords */}
          <span className="flex-1 font-mono text-[10px] tnum text-muted">
            {fmtCoord(w.lat)}, {fmtCoord(w.lng)}
          </span>
          {/* Action */}
          <select
            value={w.action}
            onChange={(e) => onPatch(w.id, { action: e.target.value })}
            className="inp px-1 py-1 text-xs"
            style={{ width: 76 }}
          >
            <option value="waypoint">waypoint</option>
            <option value="loiter">loiter</option>
            <option value="land">land</option>
          </select>
          {/* Reorder */}
          <button onClick={() => onReorder(w.id, -1)}
            className="rounded-lg px-1.5 py-1 text-xs text-ink transition-colors hover:bg-chip2">↑</button>
          <button onClick={() => onReorder(w.id, 1)}
            className="rounded-lg px-1.5 py-1 text-xs text-ink transition-colors hover:bg-chip2">↓</button>
          {/* Remove */}
          <button onClick={() => onRemove(w.id)}
            className="rounded-lg px-1.5 py-1 text-xs font-semibold transition-colors"
            style={{ background: 'rgba(255,69,58,0.12)', color: 'var(--bad)' }}>✕</button>
        </motion.div>
      ))}
    </div>
  )
})

// ── Main component ────────────────────────────────────────────────────────────
export default function MissionScreen() {
  const { telemetry, simulated } = useSystem()
  const toast  = useToast()
  const saved  = usePolling(api.missionList, 15000)
  const target = simulated ? 'sim' : 'real'

  const [restored] = useState(() => {
    const m = missionFor(getActiveMission(), target)
    if (!m) return null
    const plan = {
      name: m.name,
      wps:  m.waypoints.map((w) => ({ id: wpid++, lat: w.lat, lng: w.lng, action: w.action || 'waypoint' })),
      alt:  Number(m.altitude) || 10,
      speed: Number(m.speedKmh) || 5,
    }
    return { ...plan, key: planKey(plan.name, plan.wps, Math.min(plan.alt, MAX_ALT), plan.speed) }
  })

  const [wps,         setWps]         = useState(restored?.wps || [])
  const [name,        setName]        = useState(restored?.name || 'Mission ' + new Date().toLocaleDateString())
  const [alt,         setAlt]         = useState(restored?.alt ?? 10)
  const [speed,       setSpeed]       = useState(restored?.speed ?? 5)
  const [busy,        setBusy]        = useState(null)
  const [open,        setOpen]        = useState(true)
  const [confirming,  setConfirming]  = useState(false)
  const [savedKey,    setSavedKey]    = useState(restored?.key ?? null)
  const [uploadedKey, setUploadedKey] = useState(restored?.key ?? null)
  const [aiDraft,     setAiDraft]     = useState(null)

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

  // Live Mission Plan (Home → Direct Mission Plan): name each section's upload.
  const livePlan = useLivePlan()
  useEffect(() => {
    if (!livePlan) return
    const fresh = claimPlanName(livePlan)
    const sp = livePlan.sectionPlans?.[livePlan.activeSection - 1]
    const reload = sp?.waypoints?.length && (fresh || !wps.length || !isSectionUploaded(livePlan))
    if (fresh || reload) setName(`${livePlan.name} · Section ${livePlan.activeSection}/${livePlan.sections}`)
    // Auto-planned section: load its waypoints for review (also after a
    // reload, when the unsaved path is gone but the plan is still open).
    if (reload) {
      setWps(sp.waypoints.map(([lat, lng]) => ({ id: wpid++, lat, lng, action: 'waypoint' })))
      setAiDraft({ id: `live-${livePlan.missionId}-${livePlan.activeSection}`, planId: livePlan.missionId, area: planArea(livePlan), waypoints: sp.waypoints, name: `Section ${livePlan.activeSection}`,
        summary: `Auto-planned along the ${livePlan.river.name}: ${sp.waypoints.length} waypoints, ${sp.lengthM} m, about ${sp.minutes} min.`, live: true, warnings: sp.warnings })
    }
    if (fresh) setOpen(true)
  }, [livePlan?.missionId, livePlan?.activeSection]) // eslint-disable-line react-hooks/exhaustive-deps

  const live        = useLivePosition(telemetry.data)
  const homePoint   = useHomePoint(telemetry.data, live, simulated)
  const home        = homePoint || DEFAULT_HOME
  const dronePos    = live.position
  const activeMission = missionFor(useActiveMission(), target)
  const running     = activeMission?.status === 'running'

  const currentKey  = planKey(name, wps, Math.min(alt, MAX_ALT), speed)
  const isSaved     = savedKey === currentKey
  const isUploaded  = uploadedKey === currentKey && !!activeMission

  const addWp    = useCallback((ll) => setWps((s) => [...s, { id: wpid++, lat: ll.lat, lng: ll.lng, action: 'waypoint' }]), [])
  const moveWp   = useCallback((id, ll) => setWps((s) => s.map((w) => (w.id === id ? { ...w, lat: ll.lat, lng: ll.lng } : w))), [])
  const patchWp  = useCallback((id, p)  => setWps((s) => s.map((w) => (w.id === id ? { ...w, ...p } : w))), [])
  const removeWp = useCallback((id)     => setWps((s) => s.filter((w) => w.id !== id)), [])
  // Delete every waypoint: first tap arms it (3 s), second tap clears. Only the
  // plan on this screen — a mission already uploaded to the drone is untouched.
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    if (!confirmClear) return undefined
    const t = setTimeout(() => setConfirmClear(false), 3000)
    return () => clearTimeout(t)
  }, [confirmClear])
  function clearAllWps() {
    if (!confirmClear) return setConfirmClear(true)
    setConfirmClear(false)
    setWps([])
    setAiDraft(null)
    toast.push({ level: 'ok', title: 'All waypoints deleted', msg: 'Tap the map to start a new plan.' })
  }
  const reorder  = useCallback((id, d)  => setWps((s) => {
    const i = s.findIndex((w) => w.id === id), j = i + d
    if (i < 0 || j < 0 || j >= s.length) return s
    const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c
  }), [])

  function saveMission() {
    if (!wps.length) return toast.push({ level: 'warn', title: 'Add at least one waypoint' })
    setSavedKey(currentKey)
    toast.push({ level: 'ok', title: 'Mission saved', msg: 'Now upload it to enable Start.' })
  }
  function askUpload() { setConfirming(true) }
  async function doUpload() {
    setConfirming(false); setBusy('upload')
    try {
      const cappedAlt  = Math.min(alt, MAX_ALT)
      const simpleWps  = wps.map((w) => ({ lat: w.lat, lng: w.lng, action: w.action }))
      const res        = await cmd.missionUpload(name, simpleWps, { altitude: cappedAlt, speedKmh: Number(speed) })
      toast.fromResult(res, 'Mission uploaded')
      if (isOk(res)) setUploadedKey(currentKey)
      saved.refresh()
    } catch (e) { toast.push({ level: 'bad', title: `Upload failed: ${e?.message || e}` }) }
    finally { setBusy(null) }
  }
  async function start() {
    setBusy('start')
    try   { toast.fromResult(await cmd.missionStart(), 'Mission started') }
    catch (e) { toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` }) }
    finally { setBusy(null) }
  }
  async function emergencyStop() {
    setBusy('stop')
    try   { toast.fromResult(await cmd.emergencyStop(), 'Emergency stop sent') }
    catch (e) { toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` }) }
    finally { setBusy(null) }
  }

  const planLayers = useMemo(() => {
    const line   = [home, ...wps.map((w) => [w.lat, w.lng])]
    const arrows = []
    for (let i = 0; i < line.length - 1; i++) {
      arrows.push({ mid: [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2], ang: bearing(line[i], line[i + 1]) })
    }
    return (
      <>
        {line.length > 1 && <Polyline positions={line} pathOptions={PATH_STYLE} />}
        {arrows.map((a, i) => <Marker key={`a${i}`} position={a.mid} icon={arrowIcon(a.ang)} interactive={false} />)}
        {wps.map((w, i) => (
          <div key={w.id}>
            <Circle center={line[i + 1]} radius={90} pathOptions={RING_STYLE} />
            <Marker position={line[i + 1]} icon={wpIcon(i + 1)} draggable
              eventHandlers={{ dragend: (e) => moveWp(w.id, e.target.getLatLng()) }} />
          </div>
        ))}
      </>
    )
  }, [home, wps, moveWp])

  const area = useMemo(() => planArea(livePlan), [livePlan?.missionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const lakePositions = useMemo(
    () => aiDraft?.polygon?.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [lat, lng])),
    [aiDraft],
  )
  const savedList = saved.data?.missions || saved.data?.items || (Array.isArray(saved.data) ? saved.data : [])

  // GPS source badge style
  const gpsStyle = live.source === 'drone'
    ? { bg: 'rgba(50,215,75,0.14)', color: '#32D74B' }
    : live.source === 'laptop'
      ? { bg: 'rgba(255,159,10,0.14)', color: '#FF9F0A' }
      : { bg: 'rgba(255,69,58,0.14)', color: '#FF453A' }
  const gpsLabel = live.source === 'drone' ? 'DRONE GPS' : live.source === 'laptop' ? 'LAPTOP GPS · TEST' : 'NO GPS · DEFAULT'

  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>

      {/* ── Full-screen satellite map ── */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
        <MapContainer center={home} zoom={16} zoomControl={false} attributionControl={false}
          style={{ height: '100%', width: '100%', background: '#0E1116' }}>
          <CachedTileLayer url={SAT_URL} maxZoom={19} />
          <ClickToAdd onAdd={addWp} />
          <RecenterOnSource center={home} source={livePlan?.river?.center ? null : live.source} />
          <ReportMapView />
          <FitToDraft draft={aiDraft} />
          <FlyToRiver plan={livePlan} />
          {area && <Circle center={area.center} radius={area.radius} pathOptions={AREA_STYLE} interactive={false} />}
          {livePlan?.sectionPlans?.map((p, i) => i + 1 !== livePlan.activeSection && (
            <Polyline key={`sec${i}`} positions={p.waypoints} pathOptions={OTHER_SECTION_STYLE}
              eventHandlers={{ click: () => setActiveSection(i + 1) }} />
          ))}
          {aiDraft?.polygon && <Polygon positions={lakePositions} pathOptions={LAKE_STYLE} interactive={false} />}
          {live.source && <Marker position={home} icon={homeIcon()} interactive={false} />}
          {dronePos && <Drone3DMarker position={dronePos} size={64} />}
          <MissionFenceLayer home={home} waypoints={wps} />
          {planLayers}
        </MapContainer>
      </div>

      {/* ── Floating title pill (top-left) ── */}
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2">
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2"
          style={{
            background: 'rgba(0,0,0,0.72)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="var(--accent-hex)" style={{ flexShrink: 0 }}>
            <path d="M12 2l7 4v12l-7 4-7-4V6l7-4z" />
          </svg>
          <span className="text-[13px] font-bold text-ink">MISSION PLANNER</span>
          <span className="hidden text-xs text-muted sm:inline">· tap map to add waypoints</span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: gpsStyle.bg, color: gpsStyle.color }}
            title={live.error || undefined}>
            {gpsLabel}
          </span>
          {simulated && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={{ background: 'rgba(245,158,11,0.14)', color: '#F59E0B' }}>
              SIM
            </span>
          )}
        </div>
      </div>

      {/* ── Floating editor panel (top-right) ── */}
      <motion.div className="absolute right-3 top-3 z-30 w-[330px] max-w-[calc(100vw-24px)]">
        <div
          className="max-h-[calc(100vh-66px-24px)] overflow-y-auto rounded-2xl p-4"
          style={{
            background: 'rgba(11,14,22,0.92)',
            border: '1px solid rgba(255,255,255,0.09)',
            backdropFilter: 'blur(18px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="eyebrow">Flight Plan · {wps.length} WP</span>
            <button onClick={() => setOpen((o) => !o)} className="text-xs text-accent">{open ? 'Hide' : 'Show'}</button>
          </div>

          {/* Live Mission Plan banner */}
          {open && livePlan && (
            <div
              className="mb-3 rounded-xl p-3 text-[11px]"
              style={{ background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(167,139,250,0.35)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-bold" style={{ color: '#a78bfa' }}>Live Mission Plan</span>
                <button
                  onClick={() => endLivePlan()}
                  title="Stop planning this mission (its saved records stay)"
                  className="text-[11px] font-semibold text-muted transition-colors hover:text-bad"
                >
                  Close plan
                </button>
              </div>
              <div className="mt-1 text-ink">{livePlan.state.name} · {livePlan.river.name}</div>
              <label className="mt-1.5 flex items-center gap-2 text-muted">
                Section
                <select
                  value={livePlan.activeSection}
                  onChange={(e) => setActiveSection(e.target.value)}
                  className="rounded-md border border-line bg-transparent px-1.5 py-0.5 font-bold text-ink"
                >
                  {Array.from({ length: livePlan.sections }, (_, i) => (
                    <option key={i + 1} value={i + 1} style={{ color: '#111' }}>{i + 1} of {livePlan.sections}</option>
                  ))}
                </select>
              </label>
              <div className="mt-1 text-muted">{livePlan.missionId} · each upload is saved as this section</div>
              <SavePlanMapButton area={area} />
            </div>
          )}

          {/* AI draft banner */}
          {open && aiDraft && (
            <div
              className="mb-3 rounded-xl p-3 text-[11px]"
              style={{ background: 'rgba(59,158,255,0.08)', border: '1px solid rgba(59,158,255,0.25)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-bold text-accent">{aiDraft.live ? 'Planned route' : '✨ AI draft'}</span>
                <button
                  onClick={() => { setWps([]); setAiDraft(null) }}
                  className="text-[11px] font-semibold text-muted transition-colors hover:text-bad"
                >
                  Discard
                </button>
              </div>
              <div className="mt-1 text-ink">{aiDraft.summary}</div>
              {aiDraft.warnings?.map((w) => (
                <div key={w} className="mt-0.5 text-warn">⚠ {w}</div>
              ))}
              <div className="mt-1.5 text-muted">Review path → Save → Upload → Start</div>
            </div>
          )}

          {open && (
            <>
              {/* Mission name */}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="inp mb-3 w-full px-3 py-2 text-sm"
                placeholder="Mission name"
              />

              {/* Alt + speed sliders */}
              <div
                className="mb-3 flex flex-col gap-3 rounded-xl p-3"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <Slider label="Altitude" value={alt}   set={setAlt}   min={2} max={MAX_ALT}   step={1}   unit="m" />
                <Slider label="Speed"    value={speed} set={setSpeed} min={1} max={MAX_SPEED} step={0.5} unit="km/h" />
                <div className="text-[10px] text-faint">All waypoints · altitude capped at {MAX_ALT} m</div>
              </div>

              {/* Waypoint count + delete all */}
              {wps.length > 0 && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-muted">
                    {wps.length} waypoint{wps.length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    onClick={clearAllWps}
                    className="rounded-lg px-3 py-1.5 text-[11.5px] font-bold transition-all active:scale-95"
                    style={confirmClear
                      ? { background: 'rgba(255,69,58,0.9)', color: '#fff', border: '1px solid rgba(255,69,58,0.9)' }
                      : { background: 'rgba(255,69,58,0.10)', color: '#FF8A80', border: '1px solid rgba(255,69,58,0.35)' }}
                  >
                    {confirmClear ? `Tap again to delete all ${wps.length}` : '🗑 Clear all waypoints'}
                  </button>
                </div>
              )}

              {/* Waypoint list */}
              <WaypointRows wps={wps} onPatch={patchWp} onReorder={reorder} onRemove={removeWp} />

              {/* Pipeline steps */}
              <PipelineSteps isSaved={isSaved} isUploaded={isUploaded} />

              {/* Save / Upload buttons */}
              <div className="mb-3 grid grid-cols-2 gap-2">
                <Btn variant={isSaved ? 'secondary' : 'primary'} disabled={!wps.length} onClick={saveMission}>
                  {isSaved ? '✓ Saved' : 'Save'}
                </Btn>
                <Btn variant={isUploaded ? 'secondary' : 'primary'} disabled={!isSaved || busy === 'upload'} onClick={askUpload}>
                  {busy === 'upload' ? 'Uploading…' : isUploaded ? '✓ Uploaded' : 'Upload'}
                </Btn>
              </div>

              {/* Start */}
              <div className="flex flex-col items-center gap-1.5">
                <CommandButton cmd="mission" disabled={!isUploaded || running || busy === 'start'} onConfirm={start} />
                <span className="text-center text-[10px] text-faint">
                  {!isSaved
                    ? 'Save the plan, then upload it, then Start.'
                    : !isUploaded
                      ? 'Upload the saved mission to enable Start.'
                      : running ? 'Mission running…' : 'Ready — press Start to fly it.'}
                </span>
              </div>
            </>
          )}
        </div>
      </motion.div>

      {/* ── Saved missions (bottom-left) ── */}
      <div className="absolute bottom-3 left-3 z-20 w-[260px] max-w-[calc(100vw-24px)]">
        <div
          className="rounded-xl p-3"
          style={{
            background: 'rgba(11,14,22,0.88)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(14px)',
          }}
        >
          <div className="mb-2 eyebrow">Saved Missions</div>
          {savedList.length === 0 ? (
            <div className="text-xs text-muted">None saved.</div>
          ) : (
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
              {savedList.map((m, i) => (
                <div key={i}
                  className="flex items-center justify-between rounded-lg px-2.5 py-1.5"
                  style={{ background: 'rgba(255,255,255,0.05)' }}
                >
                  <span className="truncate text-xs font-medium text-ink">{m.name || m.id || `Mission ${i + 1}`}</span>
                  <span className="ml-2 shrink-0 font-mono text-[10px] tnum text-muted">
                    {num(m.waypoint_count ?? m.count ?? (m.waypoints ? m.waypoints.length : undefined), 0)} wp
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Emergency stop (bottom-center) ── */}
      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div
          className="flex items-center rounded-[40px] px-4 py-2.5"
          style={{
            background: 'rgba(10,14,24,0.88)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(16px)',
          }}
        >
          <CommandPanel>
            <CommandButton cmd="stop" disabled={busy === 'stop'} onConfirm={emergencyStop} />
          </CommandPanel>
        </div>
      </div>

      {/* ── Aircraft 3D preview (bottom-right) ── */}
      <div className="absolute bottom-3 right-3 z-20 w-[220px]">
        <div
          className="overflow-hidden rounded-xl p-2"
          style={{
            background: 'rgba(11,14,22,0.88)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(14px)',
          }}
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="eyebrow">Aircraft</span>
            <span className="text-[10px] font-bold text-accent">VARUNA-01</span>
          </div>
          <div className="rounded-lg" style={{ background: 'rgba(0,0,0,0.25)' }}>
            <Suspense fallback={<div style={{ height: 120 }} />}>
              <HoloDrone height={120} wire={false} />
            </Suspense>
          </div>
        </div>
      </div>

      {/* ── Upload confirmation modal ── */}
      <AnimatePresence>
        {confirming && (
          <motion.div
            className="absolute inset-0 z-40 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setConfirming(false)}
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className="w-full max-w-sm rounded-2xl p-5"
              style={{ background: 'rgba(14,18,28,0.97)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 64px rgba(0,0,0,0.7)' }}
            >
              <div className="mb-3 flex items-center gap-2">
                <StatusOrb level="warn" size={14} pulse />
                <h3 className="text-lg font-bold text-ink">Confirm mission upload</h3>
              </div>
              <div className="mb-4 space-y-1.5 rounded-xl p-3 text-sm"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <Row k="Waypoints" v={`${wps.length}`} />
                <Row k="Altitude"  v={`${Math.min(alt, MAX_ALT)} m`} />
                <Row k="Speed"     v={`${speed} km/h`} />
              </div>
              <p className="mb-4 text-xs leading-relaxed text-warn">
                ⚠ Ensure the airspace is clear, the flight is within your local regulations, and the aircraft has sufficient battery. The vehicle may begin autonomous flight once started.
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
