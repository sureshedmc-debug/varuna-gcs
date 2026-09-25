import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { useToast } from '../components/Toast'
import { StatusOrb, StaleBadge, SwipeConfirm } from '../components/ui'
import { ViewToggle, EYE, EYE_OFF, SWAP } from '../components/ViewToggle'
import { ThemeToggle } from '../components/ThemeToggle'
import { Bars, Line, LoadBar } from '../components/MiniChart'
import { Marker } from 'react-leaflet'
import { useLivePosition, useHomePoint } from '../hooks/useLaptopGps'
import { useActiveMission, missionFor } from '../lib/missionStore'
import { cmd } from '../lib/commands'

const HoloDrone = lazy(() => import('../components/HoloDrone'))
import MapCanvas, { Drone3DMarker, homeIcon } from '../components/MapCanvas'
import VideoHUD from '../components/VideoHUD'
import { pick, bool, num, fmtClock, fmtCoord, DASH } from '../lib/format'

/* ---------- rolling series for sparklines (real recent telemetry) ---------- */
function useRolling(value, cap = 20) {
  const [arr, setArr] = useState([])
  const last = useRef(null)
  useEffect(() => {
    const raw = Number(value)
    if (Number.isNaN(raw)) return
    const v = Math.round(raw * 100) / 100 // ignore changes the tiles can't even show
    if (last.current === v) return
    last.current = v
    setArr((a) => [...a, v].slice(-cap))
  }, [value, cap])
  return arr
}

function readT(t) {
  return {
    armed: bool(pick(t, ['armed', 'is_armed'])),
    mode: pick(t, ['flight_mode', 'mode', 'custom_mode']),
    lat: pick(t, ['lat', 'latitude']),
    lng: pick(t, ['lng', 'lon', 'longitude']),
    sats: pick(t, ['satellites', 'satellites_visible', 'num_sats', 'sats']),
    volt: pick(t, ['battery_voltage', 'voltage', 'battery']),
    batt: pick(t, ['battery_percent', 'battery_remaining', 'battery_level']),
    alt: pick(t, ['altitude', 'alt', 'relative_alt', 'rel_alt']),
    speed: pick(t, ['speed', 'groundspeed', 'ground_speed']),
    heading: pick(t, ['heading', 'yaw', 'hdg']),
  }
}

/* ---------- home-tab-only palette (simple flat slate cards, single teal
   accent) — scoped to this file; every other screen keeps the app's default
   glass/blue look untouched via the shared `.glass` class + `--accent`. ---------- */
const HOME = {
  panel: 'rgba(15,18,23,0.88)',
  border: 'rgba(255,255,255,0.06)',
  chip: 'rgba(255,255,255,0.04)',
  accent: '#2DD4BF',
  accentSoft: 'rgba(45,212,191,0.14)',
  text: '#E7ECEF',
  muted: '#8891A0',
}
const LEVEL_COLOR = { ok: '#34D399', warn: '#F59E0B', bad: '#EF4444', idle: HOME.muted }
// No backdrop blur: these cards float over the live map, and re-blurring the
// map under ~10 cards on every pan/frame was a big GPU cost. Opaque panel instead.
function cardStyle(radius = 12) {
  return { background: HOME.panel, border: `1px solid ${HOME.border}`, borderRadius: radius }
}

/* ---------- reusable panel sections ---------- */
function Panel({ title, right, children, className = '' }) {
  return (
    <div className={`p-2.5 ${className}`} style={cardStyle()}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: HOME.muted }}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  )
}

function AircraftCard({ t, armed, connected }) {
  const voltN = Number(t.volt)
  const battLevel = Number.isNaN(voltN) ? 'idle' : voltN >= 11.1 ? 'ok' : voltN >= 10.5 ? 'warn' : 'bad'
  const battPct = t.batt != null ? `${num(t.batt, 0)}%` : `${num(t.volt, 1)} V`
  return (
    <div className="overflow-hidden" style={cardStyle()}>
      <div className="flex items-center justify-between px-2.5 pt-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: HOME.muted }}>Selected Aircraft</span>
        <span
          className="rounded-md px-1.5 py-0.5 text-[9px] font-bold"
          style={{ background: armed ? HOME.accentSoft : 'rgba(52,211,153,0.14)', color: armed ? HOME.accent : '#6EE7B7' }}
        >
          {armed === undefined ? 'UNKNOWN' : armed ? 'IN FLIGHT' : 'STANDBY'}
        </span>
      </div>
      <div className="flex items-center gap-2.5 p-2.5">
        <div className="flex h-10 w-11 shrink-0 items-center justify-center rounded-md bg-black/25">
          <svg viewBox="0 0 48 48" width="30" height="30" style={{ color: HOME.accent }}>
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="12" cy="12" r="6" /><circle cx="36" cy="12" r="6" />
              <circle cx="12" cy="36" r="6" /><circle cx="36" cy="36" r="6" />
              <path d="M14 14l8 8m12-8l-8 8m0 4l-8 8m20 0l-8-8" />
              <rect x="20" y="20" width="8" height="8" rx="2" fill="currentColor" stroke="none" />
            </g>
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold" style={{ color: HOME.text }}>VARUNA-01</div>
          <div className="mt-0.5 grid grid-cols-1 gap-0.5 text-[11px]">
            <Row k="Battery" v={battPct} level={battLevel} />
            <Row k="Link" v={connected ? 'Strong' : 'Lost'} level={connected ? 'ok' : 'bad'} />
            <Row k="Altitude" v={`${num(t.alt, 1)} m`} />
          </div>
        </div>
      </div>
    </div>
  )
}
function Row({ k, v, level }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: HOME.muted }}>{k}</span>
      <span className="flex items-center gap-1 font-mono tnum font-semibold" style={{ color: level ? undefined : HOME.text }}>
        {level && <StatusOrb level={level} size={6} />}
        <span style={level ? { color: LEVEL_COLOR[level] } : undefined}>{v}</span>
      </span>
    </div>
  )
}

function OverviewTiles({ battSeries, sptSeries, satSeries, aiOn }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Tile label="Battery" value={battSeries.length ? `${num(battSeries.at(-1), 1)}V` : DASH}>
        <Line data={battSeries.length ? battSeries : [0, 0]} color="#34D399" width={64} height={18} />
      </Tile>
      <Tile label="Speed" value={sptSeries.length ? `${num(sptSeries.at(-1), 1)}` : DASH}>
        <Line data={sptSeries.length ? sptSeries : [0, 0]} color={HOME.accent} width={64} height={18} />
      </Tile>
      <Tile label="GPS sats" value={satSeries.length ? num(satSeries.at(-1), 0) : DASH}>
        <Bars data={satSeries.length ? satSeries.slice(-10) : [0]} color="#34D399" width={64} height={18} />
      </Tile>
      <Tile label="AI link" value={aiOn ? 'Active' : 'Off'}>
        <div className="flex h-[18px] items-center">
          <StatusOrb level={aiOn ? 'ok' : 'idle'} size={9} pulse={aiOn} />
        </div>
      </Tile>
    </div>
  )
}
function Tile({ label, value, children }) {
  return (
    <div className="rounded-md p-1.5" style={{ background: HOME.chip }}>
      <div className="text-[9px]" style={{ color: HOME.muted }}>{label}</div>
      <div className="mb-0.5 font-mono text-[13px] font-bold tnum" style={{ color: HOME.text }}>{value}</div>
      {children}
    </div>
  )
}

function HealthTiles({ health, ai, cam, gpsOk }) {
  const items = [
    { k: 'Pixhawk', ok: bool(pick(health, ['pixhawk_connected', 'pixhawk'])) },
    { k: 'GPS', ok: gpsOk },
    { k: 'Camera', ok: bool(pick(cam, ['camera_connected'])) ?? bool(pick(health, ['camera_connected', 'camera'])) },
    { k: 'AI', ok: bool(pick(ai, ['model_loaded', 'ai_enabled'])) },
  ]
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {items.map((it) => (
        <div key={it.k} className="rounded-md p-1.5 text-center" style={{ background: HOME.chip }}>
          <StatusOrb level={it.ok === true ? 'ok' : it.ok === false ? 'bad' : 'idle'} size={8} pulse={it.ok === false} />
          <div className="mt-0.5 text-[9px] font-semibold" style={{ color: HOME.text }}>{it.k}</div>
        </div>
      ))}
    </div>
  )
}

function EventLog({ entries }) {
  const [tab, setTab] = useState('all')
  const filtered = entries.filter((e) => tab === 'all' || e.kind === tab)
  const alerts = entries.filter((e) => e.kind === 'alert').length
  return (
    <div>
      <div className="mb-1.5 flex gap-1">
        {[['all', 'ALL'], ['alert', 'ALERTS'], ['info', 'INFO'], ['mission', 'MISSION']].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className="relative rounded px-2 py-0.5 text-[9px] font-semibold tracking-wide"
            style={{ background: tab === k ? HOME.accentSoft : 'transparent', color: tab === k ? HOME.text : HOME.muted }}
          >
            {l}
            {k === 'alert' && alerts > 0 && (
              <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-bad text-[8px] font-bold text-white">{alerts}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
        {filtered.length === 0 && <div className="py-3 text-center text-[11px]" style={{ color: HOME.muted }}>No events.</div>}
        {filtered.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]" style={{ background: e.kind === 'alert' ? 'rgba(239,68,68,0.1)' : HOME.chip }}>
            <StatusOrb level={e.kind === 'alert' ? 'bad' : e.kind === 'mission' ? 'warn' : 'ok'} size={6} />
            <span className="w-12 shrink-0 font-mono tnum text-[9px]" style={{ color: HOME.muted }}>{e.time}</span>
            <span className="shrink-0 font-semibold" style={{ color: e.kind === 'alert' ? '#FCA5A5' : HOME.text }}>{e.code}</span>
            <span className="truncate" style={{ color: HOME.muted }}>{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- the screen ---------- */
export default function MissionControlScreen({ onNavigate }) {
  const { telemetry, health, pi, backendReachable, simulated } = useSystem()
  const now = Date.now()
  // Only the layout that is actually on screen is mounted (not desktop + mobile
  // both, hidden by CSS) — halves the maps, 3D drones and video streams.
  const isDesktop = useIsDesktop()
  const toast = useToast()
  const ai = usePolling(api.aiStatus, 5000)
  const cam = usePolling(api.cameraStatus, 6000)
  const det = usePolling(() => api.aiDetections(20), 6000)
  const [view, setView] = useState('3D')
  const [panelsHidden, setPanelsHidden] = useState(false)
  const [mainView, setMainView] = useState('map') // 'map' | 'video' (DJI-style swap)
  const [rthOpen, setRthOpen] = useState(false)
  const [rthId, setRthId] = useState(0)

  const t = readT(telemetry.data)
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'
  const aiOn = bool(pick(ai.data, ['ai_enabled', 'enabled', 'live_boxes'])) ?? false
  // Live position: drone GPS when it has a fix, otherwise laptop GPS (test mode).
  const live = useLivePosition(telemetry.data)
  const center = live.position
  const hasFix = !!center

  // Home point (the "H" RTL marker): the drone's reported home if the backend
  // sends one, otherwise the first position seen this session. A drone fix
  // always replaces a laptop-GPS home.
  const homePoint = useHomePoint(telemetry.data, live, simulated)

  // The real planned flight path, once one has actually been uploaded from
  // the Mission tab — nothing invented here. No mission uploaded → no
  // overlay, just the aircraft's live position (see MapCanvas/PatrolOverlay).
  const activeMission = missionFor(useActiveMission(), simulated ? 'sim' : 'real')
  const missionWps = activeMission?.waypoints
  const patrol = useMemo(
    () => (missionWps?.length ? missionWps.map((w, i) => ({ lat: w.lat, lng: w.lng, label: String(i + 1), radius: 40 })) : null),
    [missionWps],
  )

  const battSeries = useRolling(t.volt)
  const sptSeries = useRolling(t.speed)
  const satSeries = useRolling(t.sats)

  // Subsystem load values for the diagnostics bars (from real status).
  const camFps = Number(pick(cam.data, ['measured_fps']))
  const camTarget = Number(pick(cam.data, ['target_fps'])) || 30
  const camLoad = Number.isNaN(camFps) ? 0 : Math.min(100, (camFps / camTarget) * 100)
  const aiConf = Number(pick(ai.data, ['confidence_threshold']))
  const aiLoad = Number.isNaN(aiConf) ? 0 : aiConf * 100
  const linkLoad = connected ? 82 : 8

  async function returnHome() {
    try {
      toast.fromResult(await cmd.rtl(), 'Returning to Home')
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    }
  }
  const openRth = useCallback(() => {
    setRthId((n) => n + 1)
    setRthOpen(true)
  }, [])
  const homeHandlers = useMemo(() => ({ click: openRth }), [openRth])

  const homeMarker = homePoint && (
    <Marker
      position={homePoint}
      icon={homeIcon()}
      title="Home point — tap for Return to Home"
      eventHandlers={homeHandlers}
    />
  )
  const drone3d = center && <Drone3DMarker position={center} />

  // Build event log from real data: warnings (alerts) + detections (info).
  const entries = []
  const th = pi.data?.throttledState || pi.data?.throttled_state
  if (th && (th.under_voltage || th.undervoltage)) entries.push({ kind: 'alert', time: fmtClock(now / 1000), code: 'PWR', text: 'Undervoltage detected' })
  if (backendReachable === false) entries.push({ kind: 'alert', time: fmtClock(now / 1000), code: 'LINK', text: 'Backend unreachable' })
  ;(det.data?.detections || []).forEach((d) => {
    entries.push({ kind: 'info', time: fmtClock(d.timestamp), code: 'DET', text: `${d.class || 'debris'} ${d.located === false ? '· unlocated' : ''}` })
  })

  const panels = (
    <>
      <AircraftCard t={t} armed={t.armed} connected={connected} />
      <Panel title="System Overview" right={<StaleBadge lastUpdate={telemetry.lastUpdate} connected={connected} />}>
        <OverviewTiles battSeries={battSeries} sptSeries={sptSeries} satSeries={satSeries} aiOn={aiOn} />
      </Panel>
      <Panel title="Diagnostics">
        <div className="rounded-md bg-black/25">
          <Suspense fallback={<div style={{ height: 90 }} />}>
            <HoloDrone height={90} />
          </Suspense>
        </div>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <LoadBar label="Camera" pct={camLoad} color="#34D399" />
          <LoadBar label="AI model" pct={aiLoad} color={HOME.accent} />
          <LoadBar label="Comms link" pct={linkLoad} color="#34D399" />
        </div>
      </Panel>
      <Panel title="Platform Health">
        <HealthTiles health={health.data} ai={ai.data} cam={cam.data} gpsOk={live.droneFix ? (Number(t.sats) >= 6 ? true : undefined) : false} />
      </Panel>
      <Panel title="Event Log">
        <EventLog entries={entries} />
      </Panel>
    </>
  )

  const videoBlock = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: HOME.muted }}>Live Feed</span>
        <div className="flex gap-0.5 rounded-md p-0.5" style={{ background: HOME.chip }}>
          {['2D', '3D'].map((v) => (
            <button key={v} onClick={() => setView(v)} className="rounded px-2 py-0.5 text-[10px] font-bold" style={{ background: view === v ? HOME.accent : 'transparent', color: view === v ? '#04211C' : HOME.muted }}>{v}</button>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg" style={{ height: 110 }}>
        <VideoHUD speed={t.speed} altitude={t.alt} aiOn={aiOn} />
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        {[['MODE', t.mode || DASH], ['HDG', `${num(t.heading, 0)}°`], ['SATS', num(t.sats, 0)]].map(([k, v]) => (
          <div key={k} className="rounded-md py-1" style={{ background: HOME.chip }}>
            <div className="text-[8px]" style={{ color: HOME.muted }}>{k}</div>
            <div className="font-mono text-xs font-bold tnum" style={{ color: HOME.text }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <motion.div
      initial={{ rotateX: 16, rotateY: -12, scale: 0.92, opacity: 0 }}
      animate={{ rotateX: 0, rotateY: 0, scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 90, damping: 18, mass: 0.9 }}
      style={{ transformPerspective: 1400 }}
    >
      {/* ===== Desktop / tablet: map with floating panels ===== */}
      {isDesktop ? (
      <div className="relative hidden md:block" style={{ height: 'calc(100vh - 56px)' }}>
        {/* Background = the active main view (DJI-style swap between map & video) */}
        <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
          {mainView === 'map' ? (
            <MapCanvas center={center} hasFix={hasFix} waypoints={patrol} droneMarker={drone3d}>
              {homeMarker}
            </MapCanvas>
          ) : (
            <VideoHUD speed={t.speed} altitude={t.alt} aiOn={aiOn} fill />
          )}
        </div>

        {/* View + theme controls (bottom-center — clear of the fault banner) */}
        <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 flex-wrap justify-center gap-2">
          <ViewToggle
            active={panelsHidden}
            onClick={() => setPanelsHidden((v) => !v)}
            label={panelsHidden ? 'Show widgets' : 'Hide widgets'}
            icon={panelsHidden ? EYE_OFF : EYE}
          />
          <ViewToggle
            active={mainView === 'video'}
            onClick={() => setMainView((v) => (v === 'map' ? 'video' : 'map'))}
            label={mainView === 'video' ? 'Map view' : 'Video view'}
            icon={SWAP}
          />
          <ThemeToggle />
        </div>

        {/* Left panel stack */}
        <AnimatePresence>
          {!panelsHidden && (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ type: 'spring', stiffness: 260, damping: 26 }}
              className="absolute left-3 top-3 z-20 flex w-[250px] flex-col gap-2 overflow-y-auto pr-1"
              style={{ maxHeight: 'calc(100% - 24px)' }}
            >
              {panels}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Right live-feed widget — always kept when in map view (the "live widget") */}
        {mainView === 'map' && (
          <motion.div className="absolute right-3 top-3 z-20 w-[280px]">
            <div className="p-2.5" style={cardStyle()}>{videoBlock}</div>
          </motion.div>
        )}

        {/* Position source (map view only) */}
        {mainView === 'map' && (
          <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5">
            <PositionChip live={live} />
            {simulated && <SimBadge />}
          </div>
        )}

        {/* Bottom-right mini card */}
        <AnimatePresence>
          {!panelsHidden && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="absolute bottom-3 right-3 z-20 flex items-center gap-2 px-2.5 py-1.5" style={cardStyle()}>
              <StatusOrb level={connected ? 'ok' : 'bad'} size={8} pulse={!connected} />
              <div>
                <div className="text-[11px] font-bold" style={{ color: HOME.text }}>VARUNA-01</div>
                <div className="text-[9px]" style={{ color: HOME.muted }}>{t.armed ? 'IN FLIGHT' : 'STANDBY'} · {t.batt != null ? `${num(t.batt, 0)}%` : `${num(t.volt, 1)}V`}</div>
              </div>
              <button onClick={() => onNavigate('live')} className="ml-1.5 rounded-md px-2 py-1 text-[10px] font-bold" style={{ background: HOME.accentSoft, color: HOME.accent }}>OPEN LIVE</button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      ) : (
      /* ===== Mobile: stacked ===== */
      <div className="flex flex-col gap-3 md:hidden">
        <div className="relative h-56 overflow-hidden rounded-2xl border border-line">
          <MapCanvas center={center} hasFix={hasFix} waypoints={patrol} zoom={15} droneMarker={drone3d}>
            {homeMarker}
          </MapCanvas>
          <div className="absolute left-2 top-2 z-[500] flex items-center gap-1.5">
            <PositionChip live={live} />
            {simulated && <SimBadge />}
          </div>
        </div>
        <div className="p-2.5" style={cardStyle()}>{videoBlock}</div>
        {panels}
      </div>
      )}

      <SwipeConfirm open={rthOpen} openId={rthId} cmd="rth" onClose={() => setRthOpen(false)} onConfirm={returnHome} />
    </motion.div>
  )
}

/** Flags that the aircraft below is a virtual (simulated) one, not real hardware. */
function SimBadge() {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1" style={{ ...cardStyle(999), border: '1px solid rgba(245,158,11,0.4)' }}>
      <span style={{ fontSize: 8 }}>🛈</span>
      <span className="text-[10px] font-bold" style={{ color: '#F59E0B' }}>SIMULATED</span>
    </div>
  )
}

/** Small chip telling the operator where the map position comes from. */
function PositionChip({ live, className = '' }) {
  const text =
    live.source === 'drone'
      ? 'Drone GPS'
      : live.source === 'laptop'
        ? `Laptop GPS (test)${live.accuracy != null ? ` · ±${Math.round(live.accuracy)} m` : ''}`
        : live.error
          ? `No GPS · ${live.error}`
          : 'Waiting for GPS…'
  const level = live.source === 'drone' ? 'ok' : live.source === 'laptop' ? 'warn' : 'bad'
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 ${className}`} style={cardStyle(999)}>
      <StatusOrb level={level} size={7} pulse={!live.source} />
      <span className="text-[10px] font-semibold" style={{ color: HOME.text }}>{text}</span>
    </div>
  )
}
