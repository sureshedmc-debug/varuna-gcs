import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling, useNow } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { StatusOrb, StaleBadge } from '../components/ui'
import { ViewToggle, EYE, EYE_OFF, SWAP } from '../components/ViewToggle'
import { ThemeToggle } from '../components/ThemeToggle'
import { Bars, Line, LoadBar } from '../components/MiniChart'

const HoloDrone = lazy(() => import('../components/HoloDrone'))
import { RadialLaunch } from '../components/RadialLaunch'
import MapCanvas from '../components/MapCanvas'
import VideoHUD from '../components/VideoHUD'
import { pick, bool, num, fmtClock, fmtCoord, DASH } from '../lib/format'

/* ---------- rolling series for sparklines (real recent telemetry) ---------- */
function useRolling(value, cap = 20) {
  const [arr, setArr] = useState([])
  const last = useRef(null)
  useEffect(() => {
    const v = Number(value)
    if (Number.isNaN(v)) return
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

/* ---------- reusable panel sections ---------- */
function Panel({ title, right, children, className = '' }) {
  return (
    <div className={`glass p-3.5 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">{title}</span>
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
    <div className="glass overflow-hidden">
      <div className="flex items-center justify-between px-3.5 pt-3">
        <span className="eyebrow">Selected Aircraft</span>
        <span
          className="rounded-md px-2 py-0.5 text-[10px] font-bold"
          style={{
            background: armed ? 'rgba(59,158,255,0.16)' : 'rgba(52,211,153,0.16)',
            color: armed ? '#6BB8FF' : '#6EE7B7',
          }}
        >
          {armed === undefined ? 'UNKNOWN' : armed ? 'IN FLIGHT' : 'STANDBY'}
        </span>
      </div>
      <div className="flex items-center gap-3 p-3.5">
        <div className="flex h-14 w-16 shrink-0 items-center justify-center rounded-lg bg-black/30">
          <svg viewBox="0 0 48 48" width="46" height="46" className="text-accent">
            <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="6" /><circle cx="36" cy="12" r="6" />
              <circle cx="12" cy="36" r="6" /><circle cx="36" cy="36" r="6" />
              <path d="M14 14l8 8m12-8l-8 8m0 4l-8 8m20 0l-8-8" />
              <rect x="20" y="20" width="8" height="8" rx="2" fill="currentColor" stroke="none" />
            </g>
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold text-ink">VARUNA-01</div>
          <div className="mt-1 grid grid-cols-1 gap-1 text-xs">
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
      <span className="text-muted">{k}</span>
      <span className="flex items-center gap-1.5 font-mono tnum font-semibold" style={{ color: level ? undefined : '#EDEFF2' }}>
        {level && <StatusOrb level={level} size={7} />}
        <span style={level ? { color: { ok: '#34D399', warn: '#F59E0B', bad: '#EF4444', idle: '#8A9099' }[level] } : undefined}>{v}</span>
      </span>
    </div>
  )
}

function OverviewTiles({ battSeries, sptSeries, satSeries, aiOn }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Tile label="Battery" value={battSeries.length ? `${num(battSeries.at(-1), 1)}V` : DASH}>
        <Line data={battSeries.length ? battSeries : [0, 0]} color="#34D399" width={82} height={26} />
      </Tile>
      <Tile label="Speed" value={sptSeries.length ? `${num(sptSeries.at(-1), 1)}` : DASH}>
        <Line data={sptSeries.length ? sptSeries : [0, 0]} color="#3B9EFF" width={82} height={26} />
      </Tile>
      <Tile label="GPS sats" value={satSeries.length ? num(satSeries.at(-1), 0) : DASH}>
        <Bars data={satSeries.length ? satSeries.slice(-10) : [0]} color="#34D399" width={82} height={26} />
      </Tile>
      <Tile label="AI link" value={aiOn ? 'Active' : 'Off'}>
        <div className="flex h-[26px] items-center">
          <StatusOrb level={aiOn ? 'ok' : 'idle'} size={11} pulse={aiOn} />
        </div>
      </Tile>
    </div>
  )
}
function Tile({ label, value, children }) {
  return (
    <div className="rounded-lg bg-chip p-2.5">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="mb-1 font-mono text-base font-bold tnum text-ink">{value}</div>
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
    <div className="grid grid-cols-4 gap-2">
      {items.map((it) => (
        <div key={it.k} className="rounded-lg bg-chip p-2 text-center">
          <StatusOrb level={it.ok === true ? 'ok' : it.ok === false ? 'bad' : 'idle'} size={10} pulse={it.ok === false} />
          <div className="mt-1 text-[10px] font-semibold text-ink">{it.k}</div>
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
      <div className="mb-2 flex gap-1">
        {[['all', 'ALL'], ['alert', 'ALERTS'], ['info', 'INFO'], ['mission', 'MISSION']].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className="relative rounded-md px-2.5 py-1 text-[10px] font-semibold tracking-wide"
            style={{ background: tab === k ? 'rgba(255,255,255,0.09)' : 'transparent', color: tab === k ? '#EDEFF2' : '#8A9099' }}
          >
            {l}
            {k === 'alert' && alerts > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-bad text-[9px] font-bold text-white">{alerts}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
        {filtered.length === 0 && <div className="py-4 text-center text-xs text-muted">No events.</div>}
        {filtered.map((e, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs" style={{ background: e.kind === 'alert' ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.03)' }}>
            <StatusOrb level={e.kind === 'alert' ? 'bad' : e.kind === 'mission' ? 'warn' : 'ok'} size={7} />
            <span className="w-14 shrink-0 font-mono tnum text-[10px] text-muted">{e.time}</span>
            <span className="shrink-0 font-semibold" style={{ color: e.kind === 'alert' ? '#FCA5A5' : '#EDEFF2' }}>{e.code}</span>
            <span className="truncate text-muted">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- the screen ---------- */
export default function MissionControlScreen({ onNavigate }) {
  const { telemetry, health, pi, backendReachable, now } = useSystem()
  const toast = useToast()
  const ai = usePolling(api.aiStatus, 5000)
  const cam = usePolling(api.cameraStatus, 6000)
  const det = usePolling(() => api.aiDetections(20), 6000)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState('3D')
  const [panelsHidden, setPanelsHidden] = useState(false)
  const [mainView, setMainView] = useState('map') // 'map' | 'video' (DJI-style swap)

  const t = readT(telemetry.data)
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'
  const aiOn = bool(pick(ai.data, ['ai_enabled', 'enabled', 'live_boxes'])) ?? false
  const hasFix = t.lat != null && t.lng != null && Number(t.lat) !== 0
  const center = hasFix ? [Number(t.lat), Number(t.lng)] : null

  // Patrol plan overlay: rings + orange flight-path arrows around the aircraft.
  const patrol = center
    ? [
        { lat: center[0] + 0.0016, lng: center[1] + 0.0013, label: 'W1', radius: 110 },
        { lat: center[0] + 0.0005, lng: center[1] + 0.0028, label: 'W2', radius: 95 },
        { lat: center[0] - 0.0015, lng: center[1] + 0.0011, label: 'W3', radius: 125 },
      ]
    : null

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

  async function toggleArm() {
    setBusy(true)
    try {
      toast.fromResult(await api.arm(!t.armed), t.armed ? 'Disarm sent' : 'Arm sent')
    } catch {
      toast.push({ level: 'bad', title: 'Command failed', msg: 'Could not reach the drone.' })
    } finally {
      setBusy(false)
    }
  }

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
      <Panel title="System Overview" right={<StaleBadge lastUpdate={telemetry.lastUpdate} now={now} connected={connected} />}>
        <OverviewTiles battSeries={battSeries} sptSeries={sptSeries} satSeries={satSeries} aiOn={aiOn} />
      </Panel>
      <Panel title="Diagnostics">
        <div className="rounded-lg bg-black/25">
          <Suspense fallback={<div style={{ height: 150 }} />}>
            <HoloDrone height={150} />
          </Suspense>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <LoadBar label="Camera" pct={camLoad} color="#34D399" />
          <LoadBar label="AI model" pct={aiLoad} color="#3B9EFF" />
          <LoadBar label="Comms link" pct={linkLoad} color="#34D399" />
        </div>
      </Panel>
      <Panel title="Platform Health">
        <HealthTiles health={health.data} ai={ai.data} cam={cam.data} gpsOk={hasFix ? (Number(t.sats) >= 6 ? true : undefined) : false} />
      </Panel>
      <Panel title="Event Log">
        <EventLog entries={entries} />
      </Panel>
    </>
  )

  const videoBlock = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Live Feed · VARUNA-01</span>
        <div className="flex gap-1 rounded-lg bg-chip p-0.5">
          {['2D', '3D'].map((v) => (
            <button key={v} onClick={() => setView(v)} className="rounded-md px-3 py-1 text-[11px] font-bold" style={{ background: view === v ? 'linear-gradient(180deg,#6BB8FF,#3B9EFF)' : 'transparent', color: view === v ? '#FFFFFF' : '#8A9099' }}>{v}</button>
          ))}
        </div>
      </div>
      <VideoHUD speed={t.speed} altitude={t.alt} aiOn={aiOn} />
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['MODE', t.mode || DASH], ['HDG', `${num(t.heading, 0)}°`], ['SATS', num(t.sats, 0)]].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-chip py-1.5">
            <div className="text-[9px] text-muted">{k}</div>
            <div className="font-mono text-sm font-bold tnum text-ink">{v}</div>
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
      <div className="relative hidden md:block" style={{ height: 'calc(100vh - 56px)' }}>
        {/* Background = the active main view (DJI-style swap between map & video) */}
        <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
          {mainView === 'map' ? (
            <MapCanvas center={center} hasFix={hasFix} waypoints={patrol} />
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
              className="absolute left-3 top-3 z-20 flex w-[330px] flex-col gap-2.5 overflow-y-auto pr-1"
              style={{ maxHeight: 'calc(100% - 24px)' }}
            >
              {panels}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Right live-feed widget — always kept when in map view (the "live widget") */}
        {mainView === 'map' && (
          <motion.div layout className="absolute right-3 top-3 z-20 w-[380px]">
            <div className="glass p-3">{videoBlock}</div>
          </motion.div>
        )}

        {/* PIP of the inactive view — tap to swap (hidden when widgets hidden) */}
        <AnimatePresence>
          {!panelsHidden && (
            <motion.button
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onClick={() => setMainView((v) => (v === 'map' ? 'video' : 'map'))}
              className="group isolate absolute bottom-3 left-3 z-20 h-32 w-52 overflow-hidden rounded-xl border border-white/15 shadow-elev"
              title="Tap to swap main view"
            >
              {mainView === 'map' ? (
                <VideoHUD speed={t.speed} altitude={t.alt} aiOn={aiOn} fill />
              ) : (
                <MapCanvas center={center} hasFix={hasFix} waypoints={patrol} zoom={15} />
              )}
              <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[9px] font-semibold tracking-wider text-white">
                TAP TO SWAP
              </span>
            </motion.button>
          )}
        </AnimatePresence>

        {/* Center radial launch control */}
        <AnimatePresence>
          {!panelsHidden && (
            <motion.div initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <div className="pointer-events-auto">
                <RadialLaunch armed={t.armed} busy={busy} onArm={toggleArm} tone="mint" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom-right mini card */}
        <AnimatePresence>
          {!panelsHidden && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="absolute bottom-3 right-3 z-20 glass flex items-center gap-3 px-3 py-2">
              <StatusOrb level={connected ? 'ok' : 'bad'} size={10} pulse={!connected} />
              <div>
                <div className="text-xs font-bold text-ink">VARUNA-01</div>
                <div className="text-[10px] text-muted">{t.armed ? 'IN FLIGHT' : 'STANDBY'} · {t.batt != null ? `${num(t.batt, 0)}%` : `${num(t.volt, 1)}V`}</div>
              </div>
              <button onClick={() => onNavigate('live')} className="ml-2 rounded-lg bg-accent/20 px-3 py-1.5 text-[11px] font-bold text-accent">OPEN LIVE</button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ===== Mobile: stacked ===== */}
      <div className="flex flex-col gap-3 md:hidden">
        <div className="relative h-56 overflow-hidden rounded-2xl border border-line">
          <MapCanvas center={center} hasFix={hasFix} waypoints={patrol} zoom={15} />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto scale-90">
              <RadialLaunch armed={t.armed} busy={busy} onArm={toggleArm} tone="mint" />
            </div>
          </div>
        </div>
        <div className="glass p-3">{videoBlock}</div>
        {panels}
      </div>
    </motion.div>
  )
}
