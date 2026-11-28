import { lazy, Suspense, useMemo, useState } from 'react'
import { Pill } from '../components/simple/Simple'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { StaleBadge, CommandButton, CommandPanel } from '../components/ui'
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
import { pick, bool, num } from '../lib/format'
import { cmd } from '../lib/commands'

const WebcamDetect = lazy(() => import('../components/WebcamDetect'))

const PANEL = { background: 'var(--sx-card)', border: '1px solid var(--sx-line)', boxShadow: 'var(--sx-shadow)' }

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
  // "Full view" hides the side panel; remembered across restarts.
  const [hideWidgets, setHideRaw]     = useState(() => { try { return localStorage.getItem('varuna.live.full') === '1' } catch { return false } })
  const setHideWidgets = (f) => setHideRaw((v) => {
    const n = typeof f === 'function' ? f(v) : f
    try { localStorage.setItem('varuna.live.full', n ? '1' : '0') } catch { /* private window */ }
    return n
  })
  const [mainView, setMainView]       = useState('video') // 'video' | 'map' | 'webcam'
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
  const batt = pick(telemetry.data, ['battery_percent', 'battery_remaining'])
  const flight = [
    ['Mode', t.mode ?? '—'],
    ['Motors', t.armed == null ? '—' : t.armed ? 'Armed' : 'Disarmed', t.armed ? 'var(--sx-warn)' : undefined],
    ['Altitude', t.alt != null ? `${num(t.alt, 1)} m` : '—'],
    ['Speed', t.speed != null ? `${num(t.speed, 1)} m/s` : '—'],
    ['Satellites', t.sats != null ? num(t.sats, 0) : '—'],
    ['Battery', batt != null ? `${num(batt, 0)}%` : t.volt != null ? `${num(t.volt, 1)} V` : '—'],
  ]
  const VIEWS = [['video', 'Drone camera'], ['map', 'Map'], ['webcam', 'Laptop AI cam']]

  return (
    <div className="flex flex-col gap-3 pb-3 lg:h-[calc(100vh-66px)] lg:pb-0">

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-[14px] px-4 py-2.5" style={PANEL}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px]" style={{ background: 'var(--sx-accent-soft)', color: 'var(--sx-accent-text)' }}>
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2.5" /><path d="M15.5 10.5l6-3.5v10l-6-3.5" /></svg>
          </span>
          <div className="min-w-0">
            <h1 className="text-[17px] font-bold leading-tight tracking-tight text-ink">Live</h1>
            <p className="truncate text-[12.5px] text-muted">Drone camera, map and flight controls</p>
          </div>
          <Pill tone={connected ? 'ok' : 'bad'} pulse={!connected}>{connected ? 'Drone connected' : 'Drone offline'}</Pill>
          {simulated && <Pill tone="warn">Simulator</Pill>}
        </div>
        <span className="hidden flex-1 lg:block" />
        <div className="sx-seg max-w-full overflow-x-auto" role="tablist" aria-label="View">
          {VIEWS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={mainView === k} aria-pressed={mainView === k} onClick={() => setMainView(k)}>{l}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mainView === 'webcam' ? (
            <label className="sx-well flex items-center gap-2 px-3" style={{ minHeight: 36 }}>
              <span className="text-[12.5px] font-semibold text-muted">Confidence</span>
              <input type="range" min={0.1} max={0.9} step={0.05} value={conf} onChange={(e) => setConf(Number(e.target.value))} className="w-24 accent-accent" />
              <span className="w-9 font-mono text-[12px] tnum text-ink">{Math.round(conf * 100)}%</span>
            </label>
          ) : (
            <>
              <button type="button" disabled={busy === 'ai'} onClick={toggleAI} aria-pressed={aiOn}
                className="sx-btn ghost sm" style={aiOn ? { borderColor: 'var(--sx-ok)', color: 'var(--sx-ok)' } : undefined}>
                <span className="h-2 w-2 rounded-full" style={{ background: aiOn ? 'var(--sx-ok)' : 'var(--sx-line2)' }} />
                Plastic finder {aiOn ? 'on' : 'off'}
              </button>
              <button type="button" className="sx-btn ghost sm" onClick={() => window.open(api.snapshotUrl(), '_blank')}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                Photo
              </button>
            </>
          )}
          <button type="button" className="sx-btn ghost sm hidden lg:inline-flex" aria-pressed={hideWidgets} onClick={() => setHideWidgets((v) => !v)}
            title={hideWidgets ? 'Show the side panel' : 'Hide the side panel'}>
            {hideWidgets ? 'Show panel' : 'Full view'}
          </button>
        </div>
      </div>

      {/* ── Stage + side panel ── */}
      <div className={`grid min-h-0 gap-3 lg:flex-1 ${hideWidgets ? '' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className="sx-keepdark relative h-[58vh] min-h-[320px] overflow-hidden rounded-[14px] lg:h-auto lg:flex-1"
            style={{ background: '#0b1120', border: '1px solid var(--sx-line)' }}>
            {mainView === 'webcam' ? (
              <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-white/60">Loading AI detector…</div>}>
                <WebcamDetect confThr={conf} />
              </Suspense>
            ) : (
              <>
                {/* The feed stays mounted under the map, so detection keeps running in Map view
                    and new plastic keeps appearing on the map. */}
                <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-sm text-white/60">Loading feed…</div>}>
                  <WebcamDetect confThr={conf} defaultSource="auto" autoStart />
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

            {/* Latest detection + its GPS, big, over the video */}
            {mainView !== 'map' && <LatestDetectionBanner />}

            {/* Map view: the video in a thumbnail */}
            {mainView === 'map' && (
              <button type="button" onClick={swap} title="Back to the drone camera"
                className="isolate absolute bottom-3 left-3 z-20 h-28 w-44 overflow-hidden rounded-xl"
                style={{ border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 4px 20px rgba(0,0,0,0.45)' }}>
                <VideoHUD speed={t.speed} altitude={t.alt} heading={t.heading} aiOn={aiOn} fill />
                <span className="absolute inset-x-0 bottom-0 py-1 text-center text-[10px] font-semibold tracking-wide text-white" style={{ background: 'rgba(0,0,0,0.6)' }}>
                  Drone camera
                </span>
              </button>
            )}
          </div>

          {/* ── Flight controls ── */}
          {mainView !== 'webcam' && (
            <div className="sx-keepdark flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[14px] px-4 py-2.5"
              style={{ background: '#0b1120', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-white">Flight controls</div>
                <div className="text-[12px] text-white/55">{fcUp ? 'Each command asks you to confirm first.' : 'No flight controller on the link: commands are off.'}</div>
              </div>
              {fcUp && (
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
              )}
            </div>
          )}
        </div>

        {/* ── Side panel ── */}
        {!hideWidgets && (
          <aside className="flex min-h-0 min-w-0 flex-col gap-3 lg:overflow-y-auto lg:pr-0.5 [&>*]:shrink-0">
            <section className="overflow-hidden rounded-[14px]" style={PANEL}>
              <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: 'var(--sx-line)' }}>
                <span className="text-[14px] font-semibold text-ink">Flight</span>
                {telemetry.status !== 'live' && <StaleBadge status={telemetry.status} />}
              </div>
              <div className="grid grid-cols-3 gap-px" style={{ background: 'var(--sx-line)' }}>
                {flight.map(([k, v, c]) => (
                  <div key={k} className="px-3 py-2.5" style={{ background: 'var(--sx-card)' }}>
                    <div className="text-[11.5px] font-medium text-muted">{k}</div>
                    <div className="truncate font-mono text-[14.5px] font-semibold tnum text-ink" style={c ? { color: c } : undefined}>{v}</div>
                  </div>
                ))}
              </div>
            </section>

            {mainView !== 'webcam' && <DroneMiniMap embedded g={gps} trail={trail} onOpenMap={mainView === 'video' ? swap : undefined} />}

            {boatLive && (
              <section className="overflow-hidden rounded-[14px] p-2 [&>div]:mb-0" style={PANEL}>
                <BoatLiveCollectCard />
              </section>
            )}

            <WasteLocationsPanel show inline />
          </aside>
        )}
      </div>
    </div>
  )
}
