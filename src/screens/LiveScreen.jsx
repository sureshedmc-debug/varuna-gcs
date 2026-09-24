import { lazy, Suspense, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Btn, StaleBadge, StatusOrb, CommandButton, CommandPanel } from '../components/ui'
import { ViewToggle, EYE, EYE_OFF, SWAP } from '../components/ViewToggle'
import VideoHUD from '../components/VideoHUD'
import MapCanvas from '../components/MapCanvas'
import { pick, num, bool, fmtCoord, DASH } from '../lib/format'
import { cmd } from '../lib/commands'

const WebcamDetect = lazy(() => import('../components/WebcamDetect'))
const AI_CAM = <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1zm8 3a3.5 3.5 0 100 7 3.5 3.5 0 000-7z" fill="currentColor" />

const cyanText = { color: 'var(--accent-hex)' }

function readTelemetry(t) {
  if (!t) return {}
  return {
    armed: bool(pick(t, ['armed', 'is_armed'])),
    mode: pick(t, ['flight_mode', 'mode', 'custom_mode']),
    lat: pick(t, ['lat', 'latitude']),
    lng: pick(t, ['lng', 'lon', 'longitude']),
    sats: pick(t, ['satellites', 'satellites_visible', 'num_sats', 'sats']),
    volt: pick(t, ['battery_voltage', 'voltage', 'battery']),
    alt: pick(t, ['altitude', 'alt', 'relative_alt', 'rel_alt']),
    speed: pick(t, ['speed', 'groundspeed', 'ground_speed']),
    heading: pick(t, ['heading', 'yaw', 'hdg']),
  }
}

function Metric({ label, value, unit, level }) {
  const c = level ? { ok: '#32D74B', warn: '#FF9F0A', bad: '#FF453A', idle: '#98A0AB' }[level] : '#F2F4F7'
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className="flex items-center gap-1.5 font-mono text-lg font-semibold tnum" style={{ color: c }}>
        {level && <StatusOrb level={level} size={8} />}
        {value}
        {unit && <span className="text-xs font-normal text-muted">{unit}</span>}
      </span>
    </div>
  )
}

export default function LiveScreen() {
  const { telemetry, now, simulated } = useSystem()
  const toast = useToast()
  const ai = usePolling(api.aiStatus, 5000)
  const [busy, setBusy] = useState(null)
  const [hideWidgets, setHideWidgets] = useState(false)
  const [mainView, setMainView] = useState('video') // 'video' | 'map' | 'webcam'
  const [conf, setConf] = useState(0.25) // AI-cam confidence threshold

  const t = readTelemetry(telemetry.data)
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'
  const aiOn = bool(pick(ai.data, ['ai_enabled', 'enabled', 'live_boxes'])) ?? false
  const satN = Number(t.sats)
  const gpsLevel = t.lat != null && satN >= 6 ? 'ok' : satN >= 4 ? 'warn' : 'bad'
  const voltN = Number(t.volt)
  const battLevel = Number.isNaN(voltN) ? 'idle' : voltN >= 11.1 ? 'ok' : voltN >= 10.5 ? 'warn' : 'bad'
  const hasFix = t.lat != null && t.lng != null && Number(t.lat) !== 0
  const center = hasFix ? [Number(t.lat), Number(t.lng)] : null

  async function run(key, fn, okMsg) {
    setBusy(key)
    try {
      toast.fromResult(await fn(), okMsg)
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }
  async function toggleAI() {
    setBusy('ai')
    try {
      toast.fromResult(await api.aiToggle(!aiOn), aiOn ? 'AI disabled' : 'AI enabled')
      ai.refresh()
    } catch {
      toast.push({ level: 'bad', title: 'AI toggle failed' })
    } finally {
      setBusy(null)
    }
  }
  function takeoff() {
    const v = window.prompt('Takeoff altitude (meters)?', '5')
    if (v == null) return
    const alt = Number(v)
    if (Number.isNaN(alt) || alt <= 0) return toast.push({ level: 'warn', title: 'Enter a valid altitude' })
    run('takeoff', () => cmd.takeoff(alt), 'Taking off')
  }
  const swap = () => setMainView((v) => (v === 'video' ? 'map' : 'video'))

  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>
      {/* Background = active main view (drone video / map / webcam AI) */}
      <div className="absolute inset-0 z-0 overflow-hidden rounded-2xl border border-line">
        {mainView === 'webcam' ? (
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-muted">Loading AI detector...</div>}>
            <WebcamDetect confThr={conf} />
          </Suspense>
        ) : mainView === 'video' ? (
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-muted">Loading AI detector...</div>}>
            {/* Raise the detector's Start/Stop/Record row above the flight-command panel below. */}
            <WebcamDetect confThr={conf} defaultSource="webcam" autoStart controlsLift={hideWidgets ? 0 : 135} />
          </Suspense>
        ) : (
          <MapCanvas center={center} hasFix={hasFix} />
        )}
      </div>

      {/* Top-left: title cluster + AI/Capture (drone view only) */}
      {mainView !== 'webcam' && (
        <div className="absolute left-3 top-3 z-20 flex flex-col gap-2">
          <div className="glass flex items-center gap-2 px-3 py-2">
            <StatusOrb level={connected ? 'ok' : 'bad'} size={10} pulse={!connected} />
            <span className="text-sm font-bold text-ink">LIVE · VARUNA-01</span>
            <StaleBadge lastUpdate={telemetry.lastUpdate} now={now} connected={connected} />
            {simulated && (
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(245,158,11,0.16)', color: '#F59E0B' }}>
                SIMULATED
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn variant={aiOn ? 'primary' : 'ghost'} className="px-4 text-sm" disabled={busy === 'ai'} onClick={toggleAI}>
              {aiOn ? 'AI On' : 'AI Off'}
            </Btn>
            <Btn variant="secondary" className="px-4 text-sm" onClick={() => window.open(api.snapshotUrl(), '_blank')}>
              Capture
            </Btn>
          </div>
        </div>
      )}

      {/* Always-visible view controls (bottom-center, clear of the fault banner) */}
      <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2">
        <ViewToggle active={hideWidgets} onClick={() => setHideWidgets((v) => !v)} label={hideWidgets ? 'Show widgets' : 'Hide widgets'} icon={hideWidgets ? EYE_OFF : EYE} />
        {mainView !== 'webcam' && (
          <ViewToggle active={mainView === 'map'} onClick={swap} label={mainView === 'map' ? 'Video view' : 'Map view'} icon={SWAP} />
        )}
        <ViewToggle
          active={mainView === 'webcam'}
          onClick={() => setMainView((v) => (v === 'webcam' ? 'video' : 'webcam'))}
          label={mainView === 'webcam' ? 'Exit AI cam' : 'AI cam'}
          icon={AI_CAM}
        />
        {mainView === 'webcam' && (
          <div className="glass flex items-center gap-2 px-3 py-2">
            <span className="text-[11px] font-semibold text-muted">Conf</span>
            <input
              type="range"
              min={0.1}
              max={0.9}
              step={0.05}
              value={conf}
              onChange={(e) => setConf(Number(e.target.value))}
              className="w-24 accent-accent"
            />
            <span className="w-8 font-mono text-[11px] tnum" style={cyanText}>{Math.round(conf * 100)}%</span>
          </div>
        )}
      </div>

      {/* Top-right telemetry widget */}
      <AnimatePresence>
        {!hideWidgets && mainView !== 'webcam' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }} className={`absolute right-3 ${mainView === 'video' ? 'top-14' : 'top-3'} z-20 w-[230px]`}>
            <div className="glass p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Telemetry</span>
                <span className="rounded-md px-2 py-0.5 text-[10px] font-bold" style={{ background: t.armed ? 'rgba(255,69,58,0.16)' : 'rgba(50,215,75,0.16)', color: t.armed ? '#FF8A80' : '#7BE495' }}>
                  {t.armed === undefined ? 'UNKNOWN' : t.armed ? 'ARMED' : 'DISARMED'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Mode" value={t.mode || DASH} />
                <Metric label="Alt" value={num(t.alt, 1)} unit="m" />
                <Metric label="Battery" value={num(t.volt, 1)} unit="V" level={battLevel} />
                <Metric label="Speed" value={num(t.speed, 1)} unit="m/s" />
                <Metric label="GPS" value={num(t.sats, 0)} unit="sats" level={gpsLevel} />
                <Metric label="Heading" value={num(t.heading, 0)} unit="°" />
              </div>
              <div className="mt-3 border-t border-line pt-2 font-mono text-[11px] tnum text-muted">
                {t.lat != null && t.lng != null ? `${fmtCoord(t.lat)}, ${fmtCoord(t.lng)}` : 'No GPS position'}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PIP of the inactive view — tap to swap */}
      <AnimatePresence>
        {!hideWidgets && mainView !== 'webcam' && (
          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            onClick={swap}
            className="isolate absolute bottom-20 left-3 z-20 h-28 w-44 overflow-hidden rounded-xl border border-white/15 shadow-elev"
            title="Tap to swap main view"
          >
            {mainView === 'video' ? <MapCanvas center={center} hasFix={hasFix} zoom={15} /> : <VideoHUD speed={t.speed} altitude={t.alt} aiOn={aiOn} fill />}
            <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[9px] font-semibold tracking-wider text-white">TAP TO SWAP</span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Bottom-center flight control */}
      <AnimatePresence>
        {!hideWidgets && mainView !== 'webcam' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center px-3">
            <CommandPanel className="pointer-events-auto">
              <CommandButton cmd={t.armed ? 'disarm' : 'arm'} disabled={busy === 'arm'} onConfirm={() => run('arm', () => cmd.arm(!t.armed), t.armed ? 'Motors disarmed' : 'Motors armed')} />
              <CommandButton cmd="takeoff" disabled={busy === 'takeoff'} onConfirm={takeoff} />
              <CommandButton cmd="rth" disabled={busy === 'rtl'} onConfirm={() => run('rtl', cmd.rtl, 'Returning to Home')} />
              <CommandButton cmd="land" disabled={busy === 'land'} onConfirm={() => run('land', cmd.land, 'Landing')} />
              <CommandButton cmd="stop" disabled={busy === 'stop'} onConfirm={() => run('stop', cmd.emergencyStop, 'Emergency stop sent')} />
            </CommandPanel>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
