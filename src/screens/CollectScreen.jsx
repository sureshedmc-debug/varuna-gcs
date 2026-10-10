import { useEffect, useMemo, useRef, useState } from 'react'
import { useBoatVision } from '../components/BoatVisionContext'
import { MapContainer, Marker, Polyline, useMap } from 'react-leaflet'
import CachedTileLayer from '../components/CachedTileLayer'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AnimatePresence, motion } from 'framer-motion'
import { boatApi } from '../api/boatClient'
import { useBoat } from '../components/BoatContext'
import { useToast } from '../components/Toast'
import { usePolling } from '../hooks/usePolling'
import { Btn, StatusOrb, CommandButton, CommandPanel } from '../components/ui'
import { boatIcon, itemIcon, MISSION_STATE, BoatOffline, BLUE, GREEN } from '../components/BoatParts'
import { homeIcon } from '../components/MapCanvas'
import { useTrashLog } from '../lib/trashLog'
import { boatItemId, clearCollected, distanceM, orderRoute, routeLength, useCollected } from '../lib/boatStore'
import { num, relTime } from '../lib/format'
import { isOk } from '../lib/commands'

const DEFAULT_CENTER = [17.385, 78.4867]
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ROUTE_STYLE = { color: BLUE, weight: 2.5, opacity: 0.9, dashArray: '2 8' }
const LIST_LIMIT = 300

// Selection survives switching tabs (the screen unmounts) for this session.
let keptSelection = []
let keptSettings = null

const SOURCE_TAG = {
  drone: { label: 'DRONE', color: GREEN },
  laptop: { label: 'LAPTOP', color: '#FF9F0A' },
  sim: { label: 'SIM', color: '#F59E0B' },
}

// Plain (un-numbered) plastic marker.
const plainCache = new Map()
function plasticIcon(kind) {
  let ic = plainCache.get(kind)
  if (!ic) {
    const c = kind === 'far' ? '#98A0AB' : '#FF9F0A'
    ic = L.divIcon({
      className: '',
      html: `<div style="width:16px;height:16px;border-radius:50%;background:${c};border:2px solid #0E1116;box-shadow:0 0 10px ${c}aa;cursor:pointer"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8],
    })
    plainCache.set(kind, ic)
  }
  return ic
}

function FitOnce({ points }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || !points.length) return
    done.current = true
    if (points.length === 1) map.setView(points[0], 18, { animate: false })
    else map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 19 })
  }, [points, map])
  return null
}

// ── Slider (same look as the Missions planner) ──
function Slider({ label, value, set, min, max, step, unit }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        <span className="font-mono text-sm font-bold tnum text-accent">
          {value}<span className="ml-0.5 text-[10px] font-normal text-muted">{unit}</span>
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))} className="w-full accent-accent" style={{ height: 4 }} />
      <div className="mt-1 flex justify-between font-mono text-[9px] tnum text-faint">
        <span>{min}{unit}</span><span>max {max}{unit}</span>
      </div>
    </div>
  )
}

// ── Pipeline steps (same look as the Missions planner) ──
function PipelineSteps({ selected, uploaded, started }) {
  const steps = [
    { label: 'Select', done: selected, active: !selected },
    { label: 'Upload', done: uploaded, active: selected && !uploaded },
    { label: 'Start', done: started, active: uploaded && !started },
  ]
  return (
    <div className="mb-3 flex items-center">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center" style={{ flex: i < steps.length - 1 ? 1 : 'none' }}>
          <div className="flex flex-col items-center gap-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all"
              style={s.done
                ? { background: 'rgba(59,158,255,0.2)', border: '2px solid var(--accent-hex)', color: 'var(--accent-hex)' }
                : s.active
                  ? { background: 'var(--accent-hex)', border: '2px solid var(--accent-hex)', color: '#04121F' }
                  : { background: 'transparent', border: '2px solid var(--faint)', color: 'var(--faint)' }}>
              {s.done ? '✓' : i + 1}
            </div>
            <span className="text-[9px] font-semibold uppercase tracking-wider"
              style={{ color: s.done || s.active ? 'var(--muted)' : 'var(--faint)' }}>{s.label}</span>
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

function fmtDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return '—'
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m ? `${m} min ${r}s` : `${r}s`
}
function fmtDist(m) {
  if (!Number.isFinite(m)) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

export default function CollectScreen({ onNavigate }) {
  const boat = useBoat()
  const toast = useToast()
  const log = useTrashLog()
  const collected = useCollected()

  const [selected, setSelected] = useState(() => new Set(keptSelection))
  const [holdS, setHoldS] = useState(keptSettings?.holdS ?? 8)
  const [speed, setSpeed] = useState(keptSettings?.speed ?? 0.8)
  const [homing, setHoming] = useState(keptSettings?.homing ?? true)
  const [measureFirst, setMeasureFirst] = useState(keptSettings?.measureFirst ?? false)
  const bv = useBoatVision()
  const waterOk = !!bv?.water?.connected
  const cameraOk = !!bv?.cameraUp
  const [name, setName] = useState(keptSettings?.name ?? `Collection ${new Date().toLocaleDateString()}`)
  const [showCollected, setShowCollected] = useState(false)
  const [busy, setBusy] = useState(null)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { keptSelection = [...selected] }, [selected])
  useEffect(() => { keptSettings = { holdS, speed, name, homing, measureFirst } }, [holdS, speed, name, homing, measureFirst])

  const t = boat.telemetry.data
  const online = boat.reachable === true && !!t
  const boatPos = online && Number.isFinite(t.lat) && Number.isFinite(t.lng) ? [t.lat, t.lng] : null
  const home = online && t.home ? [t.home.lat, t.home.lng] : null
  const start = home || boatPos
  const mission = boat.mission
  const info = usePolling(() => (boat.reachable === true ? boatApi.info() : Promise.resolve(null)), 30000, [boat.reachable])
  const maxDist = Number(info.data?.max_distance_m) || null

  // Every located plastic sighting, newest first.
  const items = useMemo(() => {
    const ref = boatPos || home
    return log
      .filter((e) => e.located && Number.isFinite(e.lat) && Number.isFinite(e.lng))
      .map((e) => {
        const key = boatItemId(e)
        const dist = ref ? distanceM(ref, [e.lat, e.lng]) : null
        return { key, e, lat: e.lat, lng: e.lng, collected: !!collected[key], dist, far: maxDist != null && dist != null && dist > maxDist }
      })
  }, [log, collected, boatPos?.[0], boatPos?.[1], home?.[0], home?.[1], maxDist]) // eslint-disable-line react-hooks/exhaustive-deps

  const pending = items.filter((i) => !i.collected)
  const selectable = pending.filter((i) => !i.far)
  const chosen = selectable.filter((i) => selected.has(i.key))
  const route = useMemo(() => orderRoute(chosen, start), [chosen.map((c) => c.key).join('|'), start?.[0], start?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  // Is the boat's current mission this selection? Compared as sets: items drop
  // out of the selection as the boat collects them, mid-mission.
  const reachedSet = new Set(mission?.reached || [])
  const boatIds = new Set((mission?.waypoints || []).map((w) => w.id))
  const uploaded = !!mission && !['none', 'completed'].includes(mission.state) && boatIds.size > 0 &&
    chosen.every((c) => boatIds.has(c.key)) &&
    [...boatIds].every((id) => selected.has(id) || collected[id] || reachedSet.has(id))
  const running = mission?.state === 'running' || mission?.state === 'returning'

  // Once uploaded, show the boat's own order and numbering (item 4 stays
  // "4" after 1–3 are collected); before that, the freshly ordered route.
  const shownRoute = uploaded
    ? mission.waypoints.filter((w) => !reachedSet.has(w.id) && !collected[w.id]).map((w) => ({ key: w.id, lat: w.lat, lng: w.lng }))
    : route
  const order = uploaded
    ? new Map(mission.waypoints.map((w, i) => [w.id, i + 1]))
    : new Map(route.map((r, i) => [r.key, i + 1]))
  const lengthM = routeLength(shownRoute, start, true)
  const etaS = shownRoute.length ? lengthM / Math.max(0.1, speed) + holdS * shownRoute.length : 0

  function toggle(key) {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }
  const selectAll = () => setSelected(new Set(selectable.map((i) => i.key)))
  const selectNone = () => setSelected(new Set())

  function askUpload() {
    if (!route.length) return toast.push({ level: 'warn', title: 'Select at least one plastic item' })
    if (!online || !boat.fcConnected) return toast.push({ level: 'warn', title: 'Boat not connected' })
    if (running) return toast.push({ level: 'warn', title: 'A collection is running', msg: 'Pause it on the Boat tab before uploading a new one.' })
    setConfirming(true)
  }
  async function doUpload() {
    setConfirming(false)
    setBusy('upload')
    try {
      const res = await boatApi.missionUpload({
        name: name.trim() || 'Plastic collection',
        waypoints: route.map((r) => ({ id: r.key, lat: r.lat, lng: r.lng })),
        holdS,
        speedMps: speed,
        homing,
        measureAtFirst: measureFirst && waterOk,
      })
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || (res?._httpError ? `HTTP ${res._httpError}` : 'Upload failed') }, 'Uploaded to the boat')
    } catch (e) {
      toast.push({ level: 'bad', title: `Upload failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }
  async function startMission() {
    setBusy('start')
    try {
      const res = await boatApi.missionStart()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || 'Start failed' }, 'Collection started')
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }
  async function pauseMission() {
    setBusy('pause')
    try {
      toast.fromResult(await boatApi.missionPause(), 'Collection paused')
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }
  async function stopBoat() {
    setBusy('stop')
    try {
      toast.fromResult(await boatApi.emergencyStop(), 'Boat stopped')
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }
  function resetCollected() {
    if (!window.confirm('Forget which items the boat has collected? They will show as pending again.')) return
    clearCollected()
  }

  const fitPoints = useMemo(() => {
    const pts = pending.map((i) => [i.lat, i.lng])
    if (start) pts.push(start)
    return pts
  }, [pending.length > 0, !!start]) // eslint-disable-line react-hooks/exhaustive-deps
  const routeLine = shownRoute.length ? [...(start ? [start] : []), ...shownRoute.map((r) => [r.lat, r.lng]), ...(start ? [start] : [])] : []
  const canStart = uploaded && ['uploaded', 'paused'].includes(mission?.state) && boat.fcConnected
  const mState = MISSION_STATE[mission?.state] || MISSION_STATE.none
  const shown = items.filter((i) => showCollected || !i.collected)

  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>

      {/* ── Full-screen satellite map ── */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
        <MapContainer center={start || (pending[0] ? [pending[0].lat, pending[0].lng] : DEFAULT_CENTER)} zoom={17}
          zoomControl={false} attributionControl={false} style={{ height: '100%', width: '100%', background: '#0E1116' }}>
          <CachedTileLayer url={SAT_URL} maxZoom={19} />
          <FitOnce points={fitPoints} />
          {routeLine.length > 1 && <Polyline positions={routeLine} pathOptions={ROUTE_STYLE} />}
          {shown.map((i) => {
            const n = order.get(i.key)
            const icon = i.collected || reachedSet.has(i.key)
              ? itemIcon('✓', 'done')
              : n
                ? itemIcon(n, uploaded && mission?.current_index === n ? 'current' : 'todo')
                : plasticIcon(i.far ? 'far' : 'plain')
            return (
              <Marker key={i.key} position={[i.lat, i.lng]} icon={icon}
                eventHandlers={{ click: () => { if (!i.collected && !i.far) toggle(i.key) } }} />
            )
          })}
          {home && <Marker position={home} icon={homeIcon()} interactive={false} />}
          {boatPos && <Marker position={boatPos} icon={boatIcon(t.heading ?? t.yaw)} interactive={false} zIndexOffset={1000} />}
        </MapContainer>
      </div>

      {/* ── Floating title pill (top-left) ── */}
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl px-3 py-2"
          style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(12px)' }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="var(--accent-hex)" style={{ flexShrink: 0 }}>
            <path d="M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7zm0 4.5A2.5 2.5 0 1012 11.5 2.5 2.5 0 0012 6.5z" />
          </svg>
          <span className="text-[13px] font-bold text-ink">PLASTIC COLLECTION</span>
          <span className="hidden text-xs text-muted sm:inline">· tap plastic on the map to select</span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={online ? { background: 'rgba(50,215,75,0.14)', color: GREEN } : { background: 'rgba(255,69,58,0.14)', color: '#FF453A' }}>
            {online ? 'BOAT LINK' : boat.reachable === undefined ? 'CONNECTING' : 'NO BOAT LINK'}
          </span>
          {boat.simulated && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(245,158,11,0.14)', color: '#F59E0B' }}>SIM</span>
          )}
        </div>
      </div>

      {/* ── Collection planner panel (top-right) ── */}
      <div className="absolute right-3 top-3 z-30 w-[340px] max-w-[calc(100vw-24px)]">
        <div className="max-h-[calc(100vh-66px-24px-150px)] overflow-y-auto rounded-2xl p-4"
          style={{ background: 'rgba(11,14,22,0.92)', border: '1px solid rgba(255,255,255,0.09)', backdropFilter: 'blur(18px)', boxShadow: '0 8px 32px rgba(0,0,0,0.55)' }}>
          <div className="mb-3 flex items-center justify-between">
            <span className="eyebrow">Collection Plan · {route.length} item{route.length === 1 ? '' : 's'}</span>
            <span className="text-[10px] font-semibold text-muted">{pending.length} pending · {items.length - pending.length} collected</span>
          </div>

          {!online && <div className="mb-3"><BoatOffline boat={boat} onNavigate={onNavigate} /></div>}

          {/* Current boat mission */}
          {online && mission && mission.state !== 'none' && (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11px]"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <span className="truncate text-muted">On boat: <span className="font-semibold text-ink">{mission.name}</span></span>
              <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${mState.color}22`, color: mState.color }}>
                {mState.label.toUpperCase()} · {mission.reached_count}/{mission.total}
              </span>
            </div>
          )}

          <input value={name} onChange={(e) => setName(e.target.value)} className="inp mb-3 w-full px-3 py-2 text-sm" placeholder="Mission name" />

          <div className="mb-3 flex flex-col gap-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <Slider label="Hold at each item" value={holdS} set={setHoldS} min={0} max={30} step={1} unit="s" />
            <Slider label="Boat speed" value={speed} set={setSpeed} min={0.3} max={2} step={0.1} unit="m/s" />
            <label className="flex items-start gap-2 text-[11px]">
              <input type="checkbox" checked={homing} onChange={(e) => setHoming(e.target.checked)} className="mt-0.5 accent-accent" />
              <span><span className="font-semibold text-ink">Camera homing</span>
                <span className="block text-muted">{cameraOk ? 'Near each item the boat steers onto it with its camera.' : 'Needs the boat camera (not streaming now); GPS only until it is.'}</span></span>
            </label>
            <label className={`flex items-start gap-2 text-[11px] ${waterOk ? '' : 'opacity-50'}`}>
              <input type="checkbox" checked={measureFirst && waterOk} disabled={!waterOk} onChange={(e) => setMeasureFirst(e.target.checked)} className="mt-0.5 accent-accent" />
              <span><span className="font-semibold text-ink">Measure water at the first item</span>
                <span className="block text-muted">{waterOk ? 'Holds 20 s and saves a turbidity reading (Water Lab).' : 'No turbidity sensor reading on the boat.'}</span></span>
            </label>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="text-muted">Route <span className="font-mono font-semibold tnum text-ink">{fmtDist(shownRoute.length ? lengthM : NaN)}</span></div>
              <div className="text-right text-muted">Time <span className="font-mono font-semibold tnum text-ink">{fmtDuration(etaS)}</span></div>
            </div>
          </div>

          {/* Item list */}
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow">Plastic found</span>
            <div className="flex gap-2 text-[11px] font-semibold">
              <button className="text-accent disabled:opacity-40" disabled={!selectable.length} onClick={selectAll}>All</button>
              <button className="text-muted disabled:opacity-40" disabled={!selected.size} onClick={selectNone}>None</button>
            </div>
          </div>
          <div className="mb-3 flex max-h-[26vh] flex-col gap-1.5 overflow-y-auto pr-1">
            {shown.length === 0 && (
              <div className="py-4 text-center text-[12px] text-muted">
                {items.length ? 'Everything found so far has been collected.' : 'No located plastic yet. Detections from the Live tab (drone feed) appear here with their GPS position.'}
              </div>
            )}
            {shown.slice(0, LIST_LIMIT).map((i) => {
              const n = order.get(i.key)
              const tag = SOURCE_TAG[i.e.posSource]
              const done = i.collected || reachedSet.has(i.key)
              return (
                <label key={i.key}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 ${done || i.far ? 'opacity-60' : 'cursor-pointer'}`}
                  style={{ background: n ? 'rgba(59,158,255,0.08)' : 'rgba(255,255,255,0.04)', border: `1px solid ${n ? 'rgba(59,158,255,0.25)' : 'rgba(255,255,255,0.07)'}` }}>
                  <input type="checkbox" className="accent-accent" disabled={done || i.far}
                    checked={!done && selected.has(i.key) && !i.far} onChange={() => toggle(i.key)} />
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={done ? { background: 'rgba(50,215,75,0.18)', color: GREEN } : { background: 'rgba(59,158,255,0.18)', color: 'var(--accent-hex)' }}>
                    {done ? '✓' : n || '·'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold capitalize text-ink">
                      {i.e.class || 'plastic'}{i.e.count > 1 ? ` ×${i.e.count}` : ''}
                    </span>
                    <span className="block font-mono text-[10px] tnum text-muted">
                      {i.dist != null ? `${fmtDist(i.dist)} · ` : ''}{i.e.confidence != null ? `${Math.round(i.e.confidence * 100)}% · ` : ''}{relTime(i.e.lastSeen)}
                    </span>
                  </span>
                  {i.far ? (
                    <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={{ background: 'rgba(152,160,171,0.16)', color: '#98A0AB' }}>TOO FAR</span>
                  ) : tag ? (
                    <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={{ background: `${tag.color}22`, color: tag.color }}>{tag.label}</span>
                  ) : null}
                </label>
              )
            })}
            {shown.length > LIST_LIMIT && (
              <div className="text-center text-[10px] text-faint">Showing the newest {LIST_LIMIT} of {shown.length} — all are on the map.</div>
            )}
          </div>
          <div className="mb-3 flex items-center justify-between text-[11px]">
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-accent" checked={showCollected} onChange={(e) => setShowCollected(e.target.checked)} />
              Show collected
            </label>
            <button className="font-semibold text-muted transition-colors hover:text-bad disabled:opacity-40"
              disabled={items.length === pending.length} onClick={resetCollected}>Reset collected</button>
          </div>

          <PipelineSteps selected={route.length > 0} uploaded={uploaded} started={uploaded && running} />

          <div className="mb-3 grid grid-cols-2 gap-2">
            <Btn variant={uploaded ? 'secondary' : 'primary'} disabled={!route.length || busy === 'upload' || !online || running} onClick={askUpload}>
              {busy === 'upload' ? 'Uploading…' : uploaded ? '✓ Uploaded' : 'Upload'}
            </Btn>
            <Btn variant="secondary" disabled={!running || busy === 'pause' || !boat.fcConnected} onClick={pauseMission}>
              {busy === 'pause' ? 'Pausing…' : 'Pause'}
            </Btn>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <CommandButton cmd="boatMission" disabled={!canStart || busy === 'start'} onConfirm={startMission} />
            <span className="text-center text-[10px] text-faint">
              {!online
                ? 'Connect the boat to upload and start.'
                : !route.length
                  ? 'Select the plastic to collect, then upload.'
                  : !uploaded
                    ? 'Upload the route to the boat to enable Start.'
                    : running
                      ? 'Collecting…'
                      : mission?.state === 'paused'
                        ? 'Paused — press Start to resume.'
                        : 'Ready — press Start to send the boat.'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Boat emergency stop (bottom-center) ── */}
      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div className="flex items-center rounded-[40px] px-4 py-2.5"
          style={{ background: 'rgba(10,14,24,0.88)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(16px)' }}>
          <CommandPanel title="BOAT COMMANDS">
            <CommandButton cmd="boatStop" disabled={!online || busy === 'stop'} onConfirm={stopBoat} />
          </CommandPanel>
        </div>
      </div>

      {/* ── Upload confirmation modal ── */}
      <AnimatePresence>
        {confirming && (
          <motion.div className="absolute inset-0 z-40 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setConfirming(false)}>
            <motion.div onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className="w-full max-w-sm rounded-2xl p-5"
              style={{ background: 'rgba(14,18,28,0.97)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 64px rgba(0,0,0,0.7)' }}>
              <div className="mb-3 flex items-center gap-2">
                <StatusOrb level="warn" size={14} pulse />
                <h3 className="text-lg font-bold text-ink">Upload to the boat</h3>
              </div>
              <div className="mb-4 space-y-1.5 rounded-xl p-3 text-sm" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <Row k="Items to collect" v={`${route.length}`} />
                <Row k="Route (incl. return)" v={fmtDist(lengthM)} />
                <Row k="Estimated time" v={fmtDuration(etaS)} />
                <Row k="Hold at each item" v={`${holdS} s`} />
                <Row k="Speed" v={`${speed} m/s`} />
                <Row k="Camera homing" v={homing ? 'On' : 'Off'} />
                <Row k="Water test at item 1" v={measureFirst && waterOk ? 'Yes' : 'No'} />
              </div>
              <p className="mb-4 text-xs leading-relaxed text-warn">
                ⚠ The boat will drive itself to every selected item, pause to collect it, then return to its launch point. Make sure the water is clear of swimmers and boats, and that the battery is charged.
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
