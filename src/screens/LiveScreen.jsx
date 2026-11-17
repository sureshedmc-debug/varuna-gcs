import { lazy, Suspense, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { StaleBadge, StatusOrb, CommandButton, CommandPanel } from '../components/ui'
import { ViewToggle, EYE, EYE_OFF, SWAP } from '../components/ViewToggle'
import VideoHUD from '../components/VideoHUD'
import MapCanvas from '../components/MapCanvas'
import LiveDetectionMarkers from '../components/LiveDetectionMarkers'
import LiveBoatMarkers from '../components/LiveBoatMarkers'
import WasteLocationsPanel from '../components/WasteLocationsPanel'
import LatestDetectionBanner from '../components/LatestDetectionBanner'
import { BoatLiveCollectCard } from '../components/BoatLiveCollectCard'
import DroneMiniMap, { DroneGpsLayer, readDroneGps, useDroneTrail } from '../components/DroneMiniMap'
import { useBoat } from '../components/BoatContext'
import { useRecommendedConf } from '../components/BackgroundDetect'
import { pick, bool } from '../lib/format'
import { cmd } from '../lib/commands'

const WebcamDetect = lazy(() => import('../components/WebcamDetect'))

// The waste-locations panel's shown/hidden choice survives a restart.
const WASTE_KEY = 'varuna.live.wasteGps'
function readShowWaste() {
  try { return localStorage.getItem(WASTE_KEY) !== 'hidden' } catch { return true }
}
const PIN = <path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z" fill="currentColor" />
const AI_CAM = <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1zm8 3a3.5 3.5 0 100 7 3.5 3.5 0 000-7z" fill="currentColor" />

function readTelemetry(t) {
  if (!t) return {}
  return {
    armed:   bool(pick(t, ['armed', 'is_armed'])),
    mode:    pick(t, ['flight_mode', 'mode', 'custom_mode']),
    lat:     pick(t, ['lat', 'latitude']),
    lng:     pick(t, ['lng', 'lon', 'longitude']),
    sats:    pick(t, ['satellites', 'satellites_visible', 'num_sats', 'sats']),
    volt:    pick(t, ['battery_voltage', 'voltage', 'battery']),
    alt:     pick(t, ['altitude', 'alt', 'relative_alt', 'rel_alt']),
    speed:   pick(t, ['speed', 'groundspeed', 'ground_speed']),
    heading: pick(t, ['heading', 'yaw', 'hdg']),
  }
}

export default function LiveScreen() {
  const { telemetry, simulated } = useSystem()
  const toast   = useToast()
  const ai      = usePolling(api.aiStatus, 5000)
  const [busy, setBusy]               = useState(null)
  const [hideWidgets, setHideWidgets] = useState(false)
  const [mainView, setMainView]       = useState('video') // 'video' | 'map' | 'webcam'
  const [showWaste, setShowWaste]     = useState(readShowWaste)
  function toggleWaste() {
    const next = !showWaste
    try { localStorage.setItem(WASTE_KEY, next ? 'shown' : 'hidden') } catch { /* private window */ }
    setShowWaste(next)
  }
  // The slider starts at the confidence the model's training run found best.
  const [conf, setConf]               = useRecommendedConf()
  // The boat's live collect, on the same screen as the drone's finds.
  const boat     = useBoat()
  const boatLive = boat.reachable === true && !!boat.telemetry.data && !!boat.live

  const t         = readTelemetry(telemetry.data)
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'
  const aiOn      = bool(pick(ai.data, ['ai_enabled', 'enabled', 'live_boxes'])) ?? false

  // The drone's live position (its Pixhawk's GPS, or the VARUNA Cam phone's on it).
  const gps       = readDroneGps(telemetry.data)
  const trail     = useDroneTrail(gps.pos)
  // Arm / take-off / land only mean something with a flight controller on the link.
  const fcUp      = telemetry.data?.fc_connected !== false

  const hasFix = t.lat != null && t.lng != null && Number(t.lat) !== 0
  const cLat   = hasFix ? Number(t.lat) : null
  const cLng   = hasFix ? Number(t.lng) : null
  // No drone fix: follow the boat, so the map still shows the collecting.
  const bt     = boat.reachable === true ? boat.telemetry.data : null
  const bLat   = !hasFix && bt && Number.isFinite(bt.lat) && bt.lat !== 0 ? bt.lat : null
  const bLng   = bLat != null && Number.isFinite(bt.lng) ? bt.lng : null
  const center = useMemo(
    () => (cLat != null && cLng != null ? [cLat, cLng] : bLat != null && bLng != null ? [bLat, bLng] : null),
    [cLat, cLng, bLat, bLng],
  )

  async function run(key, fn, okMsg) {
    setBusy(key)
    try { toast.fromResult(await fn(), okMsg) }
    catch (e) { toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` }) }
    finally   { setBusy(null) }
  }

  async function toggleAI() {
    setBusy('ai')
    try {
      toast.fromResult(await api.aiToggle(!aiOn), aiOn ? 'AI disabled' : 'AI enabled')
      ai.refresh()
    } catch { toast.push({ level: 'bad', title: 'AI toggle failed' }) }
    finally   { setBusy(null) }
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

      {/* ── Background view ── */}
      <div className="absolute inset-0 z-0 overflow-hidden rounded-2xl border border-line">
        {mainView === 'webcam' ? (
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-muted">Loading AI detector…</div>}>
            <WebcamDetect confThr={conf} />
          </Suspense>
        ) : (
          <>
            {/* The feed stays mounted under the map, so detection keeps running in Map view
                and new plastic keeps appearing on the map. */}
            <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-muted">Loading feed…</div>}>
              <WebcamDetect confThr={conf} defaultSource="auto" autoStart controlsLift={hideWidgets ? 0 : 135} />
            </Suspense>
            {mainView === 'map' && (
              <div className="absolute inset-0 z-10">
                <MapCanvas center={center} hasFix={hasFix}
                  droneMarker={<DroneGpsLayer pos={gps.pos} heading={gps.heading} acc={gps.acc} trail={trail} home={gps.home} />}>
                  <LiveDetectionMarkers />
                  <LiveBoatMarkers />
                </MapCanvas>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Top-left: status pill + action buttons (drone views only) ── */}
      {mainView !== 'webcam' && (
        <div className="absolute left-3 top-3 z-20 flex flex-col gap-2">
          {/* Status pill */}
          <div
            className="flex items-center gap-2 rounded-full px-3 py-1.5"
            style={{
              background: 'rgba(0,0,0,0.7)',
              border: '1px solid rgba(255,255,255,0.08)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <StatusOrb level={connected ? 'ok' : 'bad'} size={9} pulse={!connected} />
            <span className="text-[13px] font-bold text-ink">LIVE · VARUNA-01</span>
            <StaleBadge lastUpdate={telemetry.lastUpdate} connected={connected} />
            {simulated && (
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={{ background: 'rgba(245,158,11,0.16)', color: '#F59E0B' }}
              >
                SIM
              </span>
            )}
          </div>

          {/* AI + Capture row */}
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy === 'ai'}
              onClick={toggleAI}
              className="rounded-xl px-4 py-2 text-[12px] font-bold transition-all active:scale-95 disabled:opacity-40"
              style={aiOn
                ? { background: 'linear-gradient(135deg,#32D74B,#0e8f28)', color: '#fff', boxShadow: '0 0 16px rgba(50,215,75,0.4)', border: '1px solid rgba(50,215,75,0.4)' }
                : { background: 'rgba(255,255,255,0.07)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {aiOn ? '● AI On' : '○ AI Off'}
            </button>
            <button
              onClick={() => window.open(api.snapshotUrl(), '_blank')}
              className="rounded-xl px-4 py-2 text-[12px] font-bold transition-all active:scale-95"
              style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              📸 Capture
            </button>
          </div>
        </div>
      )}

      {/* ── View controls (bottom-center) ── */}
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
        <ViewToggle
          active={showWaste}
          onClick={toggleWaste}
          label={showWaste ? 'Hide waste GPS' : 'Show waste GPS'}
          icon={PIN}
        />
        {mainView === 'webcam' && (
          <div
            className="flex items-center gap-2 rounded-xl px-3 py-2"
            style={{ background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(10px)' }}
          >
            <span className="text-[11px] font-semibold text-muted">Conf</span>
            <input type="range" min={0.1} max={0.9} step={0.05} value={conf}
              onChange={(e) => setConf(Number(e.target.value))}
              className="w-24 accent-accent" />
            <span className="w-8 font-mono text-[11px] tnum text-accent">{Math.round(conf * 100)}%</span>
          </div>
        )}
      </div>

      {/* ── Latest detection + its GPS, big, over the video (the main thing to read on a phone) ── */}
      {mainView !== 'map' && <LatestDetectionBanner />}

      {/* ── Waste locations (bottom-right): GPS of every detection, own Show/Hide button ── */}
      <WasteLocationsPanel show={showWaste} />

      {/* ── The boat collecting what the drone finds, live (top-right) ── */}
      <AnimatePresence>
        {!hideWidgets && mainView !== 'webcam' && boatLive && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className={`absolute right-3 ${mainView === 'video' ? 'top-[14rem] lg:top-14' : 'top-3'} z-20 max-h-[calc(100%-6rem)] w-[240px] overflow-y-auto`}
          >
            <div
              className="rounded-2xl p-2 [&>div]:mb-0"
              style={{
                background: 'rgba(13,17,26,0.88)',
                border: '1px solid rgba(255,255,255,0.08)',
                backdropFilter: 'blur(16px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}
            >
              <BoatLiveCollectCard />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Bottom-left: the drone's live position on a small map (video view),
            or the video in a thumbnail (map view) ── */}
      <AnimatePresence>
        {!hideWidgets && mainView === 'video' && (
          <motion.div
            key="minimap"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-20 left-3 z-20"
          >
            <DroneMiniMap g={gps} trail={trail} onOpenMap={swap} />
          </motion.div>
        )}
        {!hideWidgets && mainView === 'map' && (
          <motion.button
            key="videopip"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            onClick={swap}
            className="isolate absolute bottom-20 left-3 z-20 h-28 w-44 overflow-hidden rounded-xl"
            style={{ border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
            title="Tap to swap main view"
          >
            <VideoHUD speed={t.speed} altitude={t.alt} heading={t.heading} aiOn={aiOn} fill />
            <span
              className="absolute inset-x-0 bottom-0 py-1 text-center text-[9px] font-bold tracking-widest text-white"
              style={{ background: 'rgba(0,0,0,0.65)' }}
            >
              TAP TO SWAP
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── Flight command ring (bottom-center above view controls): only with a
            flight controller to command (none when the phone is the drone's link) ── */}
      <AnimatePresence>
        {!hideWidgets && mainView !== 'webcam' && fcUp && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center px-3"
          >
            <div
              className="pointer-events-auto flex items-center gap-2 rounded-[40px] px-4 py-2.5"
              style={{
                background: 'rgba(10,14,24,0.88)',
                border: '1px solid rgba(255,255,255,0.08)',
                backdropFilter: 'blur(16px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}
            >
              <CommandPanel>
                <CommandButton cmd={t.armed ? 'disarm' : 'arm'} disabled={busy === 'arm'}
                  onConfirm={() => run('arm', () => cmd.arm(!t.armed), t.armed ? 'Motors disarmed' : 'Motors armed')} />
                <CommandButton cmd="takeoff" disabled={busy === 'takeoff'} onConfirm={takeoff} />
                <CommandButton cmd="rth"     disabled={busy === 'rtl'}
                  onConfirm={() => run('rtl', cmd.rtl, 'Returning to Home')} />
                <CommandButton cmd="land"    disabled={busy === 'land'}
                  onConfirm={() => run('land', cmd.land, 'Landing')} />
                <CommandButton cmd="stop"    disabled={busy === 'stop'}
                  onConfirm={() => run('stop', cmd.emergencyStop, 'Emergency stop sent')} />
              </CommandPanel>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
