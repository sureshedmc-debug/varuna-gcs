import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Polyline, useMap } from 'react-leaflet'
import CachedTileLayer from '../components/CachedTileLayer'
import 'leaflet/dist/leaflet.css'
import { boatApi } from '../api/boatClient'
import { useBoat } from '../components/BoatContext'
import { useToast } from '../components/Toast'
import { usePolling } from '../hooks/usePolling'
import { Btn, StaleBadge, CommandButton, CommandPanel } from '../components/ui'
import { boatIcon, itemIcon, MISSION_STATE, BoatOffline, BLUE, GREEN } from '../components/BoatParts'
import { homeIcon } from '../components/MapCanvas'
import { BoatVisionWidgets } from '../components/BoatVisionWidgets'
import { num, relTime } from '../lib/format'
import { isOk } from '../lib/commands'

const DEFAULT_CENTER = [17.385, 78.4867]
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const TRAIL_STYLE = { color: '#5AC8FA', weight: 2, opacity: 0.75 }
const PLAN_STYLE = { color: BLUE, weight: 2.5, opacity: 0.9, dashArray: '2 8' }

function CenterOnce({ position }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || !position) return
    done.current = true
    map.setView(position, Math.max(map.getZoom(), 18), { animate: false })
  }, [position, map])
  return null
}
function FollowButton({ position }) {
  const map = useMap()
  if (!position) return null
  return (
    <button
      onClick={() => map.setView(position, Math.max(map.getZoom(), 18), { animate: true })}
      className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold"
      style={{ position: 'absolute', left: 12, top: 64, zIndex: 500, background: 'rgba(0,0,0,0.72)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      ⌖ Center on boat
    </button>
  )
}

const SEVERITY_COLOR = (s) => (s <= 3 ? '#FF453A' : s <= 4 ? '#FF9F0A' : 'var(--muted)')
const GPS_FIX = ['No GPS', 'No fix', '2D', '3D', 'DGPS', 'RTK float', 'RTK fixed', 'Static', 'PPP']

function Tile({ label, value, unit, level }) {
  const c = level === 'bad' ? '#FF453A' : level === 'warn' ? '#FF9F0A' : level === 'ok' ? GREEN : undefined
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-[15px] font-bold tnum text-ink" style={c ? { color: c } : undefined}>
        {value}{unit && <span className="ml-0.5 text-[10px] font-normal text-muted">{unit}</span>}
      </div>
    </div>
  )
}

export default function BoatScreen({ onNavigate }) {
  const boat = useBoat()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const t = boat.telemetry.data
  const online = boat.reachable === true && !!t
  const pos = online && Number.isFinite(t.lat) && Number.isFinite(t.lng) ? [t.lat, t.lng] : null
  const home = online && t.home ? [t.home.lat, t.home.lng] : null
  const mission = boat.mission
  const mState = MISSION_STATE[mission?.state] || MISSION_STATE.none
  const armed = online && t.armed === true
  const canCommand = online && boat.fcConnected

  // Position trail: the boat's recent track, then extended live.
  const track = usePolling(() => (boat.reachable === true ? boatApi.track(300) : Promise.resolve([])), 5000, [boat.reachable])
  const trail = useMemo(() => {
    const pts = Array.isArray(track.data) ? track.data.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [p.lat, p.lng]) : []
    if (pos) pts.push(pos)
    return pts
  }, [track.data, pos?.[0], pos?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  const history = usePolling(() => (boat.reachable === true ? boatApi.missionList() : Promise.resolve([])), 15000, [boat.reachable])
  const historyList = Array.isArray(history.data) ? history.data : []

  const wps = mission?.waypoints || []
  const reached = new Set(mission?.reached || [])
  const planLine = useMemo(() => {
    if (!wps.length) return []
    const start = home || pos
    const line = wps.map((w) => [w.lat, w.lng])
    return start ? [start, ...line, start] : line
  }, [wps, home?.[0], home?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run(key, fn, okMsg) {
    if (!canCommand && key !== 'stop') return toast.push({ level: 'warn', title: 'Boat not connected' })
    setBusy(key)
    try {
      const res = await fn()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || (res?._httpError ? `HTTP ${res._httpError}` : 'Failed') }, okMsg)
    } catch (e) {
      toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }

  const batt = online ? t.battery_percent : null
  const battLevel = batt == null ? undefined : batt < 20 ? 'bad' : batt < 35 ? 'warn' : 'ok'
  const fix = online ? Number(t.gps_fix) || 0 : 0
  const progress = mission?.total ? Math.round((mission.reached_count / mission.total) * 100) : 0

  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>

      {/* ── Full-screen satellite map ── */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl border border-line">
        <MapContainer center={pos || home || DEFAULT_CENTER} zoom={17} zoomControl={false} attributionControl={false}
          style={{ height: '100%', width: '100%', background: '#0E1116' }}>
          <CachedTileLayer url={SAT_URL} maxZoom={19} />
          <CenterOnce position={pos || home} />
          <FollowButton position={pos} />
          {trail.length > 1 && <Polyline positions={trail} pathOptions={TRAIL_STYLE} />}
          {planLine.length > 1 && <Polyline positions={planLine} pathOptions={PLAN_STYLE} />}
          {wps.map((w, i) => (
            <Marker key={w.id} position={[w.lat, w.lng]} interactive={false}
              icon={itemIcon(i + 1, reached.has(w.id) ? 'done' : mission?.current_index === i + 1 ? 'current' : 'todo')} />
          ))}
          {home && <Marker position={home} icon={homeIcon()} interactive={false} />}
          {pos && <Marker position={pos} icon={boatIcon(t.heading ?? t.yaw)} interactive={false} zIndexOffset={1000} />}
        </MapContainer>
      </div>

      {/* ── Floating title pill (top-left) ── */}
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl px-3 py-2"
          style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(12px)' }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="var(--accent-hex)" style={{ flexShrink: 0 }}>
            <path d="M3 15h18l-2.5 5h-13L3 15zM11 3v10H5l6-10zm2 3l5 7h-5V6z" />
          </svg>
          <span className="text-[13px] font-bold text-ink">BOAT CONTROL</span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={online ? { background: 'rgba(50,215,75,0.14)', color: GREEN } : { background: 'rgba(255,69,58,0.14)', color: '#FF453A' }}>
            {online ? 'BOAT LINK' : boat.reachable === undefined ? 'CONNECTING' : 'NO BOAT LINK'}
          </span>
          {online && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={boat.fcConnected ? { background: 'rgba(50,215,75,0.14)', color: GREEN } : { background: 'rgba(255,159,10,0.14)', color: '#FF9F0A' }}>
              {boat.fcConnected ? 'PIXHAWK' : 'NO PIXHAWK'}
            </span>
          )}
          {boat.simulated && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'rgba(245,158,11,0.14)', color: '#F59E0B' }}>SIM</span>
          )}
        </div>
      </div>

      {/* ── Floating status panel (top-right) ── */}
      <div className="absolute right-3 top-3 z-30 w-[330px] max-w-[calc(100vw-24px)]">
        <div className="max-h-[calc(100vh-66px-24px-150px)] overflow-y-auto rounded-2xl p-4"
          style={{ background: 'rgba(11,14,22,0.92)', border: '1px solid rgba(255,255,255,0.09)', backdropFilter: 'blur(18px)', boxShadow: '0 8px 32px rgba(0,0,0,0.55)' }}>
          <div className="mb-3 flex items-center justify-between">
            <span className="eyebrow">Boat · VARUNA-B1</span>
            <StaleBadge lastUpdate={boat.telemetry.lastUpdate} connected={online} />
          </div>

          {!online ? (
            <BoatOffline boat={boat} onNavigate={onNavigate} />
          ) : (
            <>
              {!boat.fcConnected && (
                <div className="mb-3 rounded-xl p-3 text-[12px]" style={{ background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.3)' }}>
                  <div className="font-bold text-warn">Pixhawk not connected</div>
                  <div className="mt-0.5 text-muted">{t.link_error || 'The boat Pi is online but has no heartbeat from its flight controller.'}</div>
                </div>
              )}

              <div className="mb-3 grid grid-cols-3 gap-2">
                <Tile label="Mode" value={t.flight_mode || '—'} />
                <Tile label="Motors" value={armed ? 'ARMED' : 'SAFE'} level={armed ? 'warn' : 'ok'} />
                <Tile label="Battery" value={batt == null ? num(t.battery_voltage, 1) : num(batt, 0)} unit={batt == null ? 'V' : '%'} level={battLevel} />
                <Tile label="GPS" value={GPS_FIX[fix] || fix} unit={`· ${num(t.satellites, 0)}`} level={fix >= 3 ? 'ok' : 'bad'} />
                <Tile label="Speed" value={num(t.groundspeed, 1)} unit="m/s" />
                <Tile label="Heading" value={t.heading == null ? '—' : num(t.heading, 0)} unit="°" />
              </div>

              {/* Mission progress */}
              <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-bold text-ink">{mission?.name || 'Collection mission'}</span>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold"
                    style={{ background: `${mState.color}22`, color: mState.color }}>{mState.label.toUpperCase()}</span>
                </div>
                {mission && mission.state !== 'none' ? (
                  <>
                    <div className="mb-1 flex justify-between text-[11px]">
                      <span className="text-muted">Collected</span>
                      <span className="font-mono font-semibold tnum text-ink">{mission.reached_count} / {mission.total}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-chip2">
                      <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: GREEN }} />
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">
                      {mission.state === 'running' && mission.current_index ? `Heading to item ${mission.current_index} of ${mission.total}` : null}
                      {mission.state === 'returning' ? 'All items done — driving back to launch.' : null}
                      {mission.state === 'paused' ? 'Paused — press Resume to continue.' : null}
                      {mission.state === 'uploaded' ? 'Uploaded to the Pixhawk — start it from the Collect tab.' : null}
                      {mission.state === 'completed' ? `Finished ${mission.ended_at ? relTime(mission.ended_at * 1000) : ''}.${armed ? ' Disarm the boat once it is safely back.' : ''}` : null}
                    </div>
                    <div className={`mt-2.5 grid gap-2 ${mission.state === 'completed' ? 'grid-cols-1' : 'grid-cols-2'}`}>
                      {mission.state === 'completed' ? null : mission.state === 'running' || mission.state === 'returning' ? (
                        <Btn className="h-9 text-xs" variant="secondary" disabled={!!busy || !canCommand}
                          onClick={() => run('pause', boatApi.missionPause, 'Collection paused')}>
                          {busy === 'pause' ? 'Pausing…' : 'Pause'}
                        </Btn>
                      ) : (
                        <Btn className="h-9 text-xs" disabled={!!busy || !canCommand || !['paused', 'uploaded'].includes(mission.state)}
                          onClick={() => run('resume', boatApi.missionStart, mission.state === 'paused' ? 'Collection resumed' : 'Collection started')}>
                          {busy === 'resume' ? 'Starting…' : mission.state === 'paused' ? 'Resume' : 'Start'}
                        </Btn>
                      )}
                      <Btn className="h-9 text-xs" variant="ghost" onClick={() => onNavigate?.('collect')}>Collect tab →</Btn>
                    </div>
                  </>
                ) : (
                  <div className="text-[11px] text-muted">
                    No collection mission on the boat yet.
                    <button className="ml-1 font-semibold text-accent" onClick={() => onNavigate?.('collect')}>Plan one in Collect →</button>
                  </div>
                )}
              </div>

              <BoatVisionWidgets onNavigate={onNavigate} />

              {/* Pixhawk messages */}
              <div>
                <div className="mb-1.5 eyebrow">Pixhawk messages</div>
                {(t.messages || []).length === 0 ? (
                  <div className="text-[11px] text-muted">No messages yet.</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {[...t.messages].reverse().slice(0, 6).map((m, i) => (
                      <div key={`${m.t}-${i}`} className="flex gap-2 text-[11px]">
                        <span className="shrink-0 font-mono tnum text-faint">{relTime(m.t * 1000)}</span>
                        <span style={{ color: SEVERITY_COLOR(m.severity) }} className="text-ink">{m.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Recent boat missions (bottom-left) ── */}
      <div className="absolute bottom-3 left-3 z-20 w-[260px] max-w-[calc(100vw-24px)]">
        <div className="rounded-xl p-3" style={{ background: 'rgba(11,14,22,0.88)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(14px)' }}>
          <div className="mb-2 eyebrow">Boat Missions</div>
          {historyList.length === 0 ? (
            <div className="text-xs text-muted">{online ? 'None uploaded yet.' : 'Boat offline.'}</div>
          ) : (
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
              {historyList.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <span className="truncate text-xs font-medium text-ink">{m.name}</span>
                  <span className="ml-2 shrink-0 font-mono text-[10px] tnum text-muted">{num(m.waypoint_count, 0)} items</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Boat commands (bottom-center) ── */}
      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div className="flex items-center rounded-[40px] px-4 py-2.5"
          style={{ background: 'rgba(10,14,24,0.88)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(16px)' }}>
          <CommandPanel title="BOAT COMMANDS">
            <CommandButton cmd={armed ? 'boatDisarm' : 'boatArm'} disabled={!canCommand || !!busy}
              onConfirm={() => run('arm', () => boatApi.arm(!armed), armed ? 'Boat disarmed' : 'Boat armed')} />
            <CommandButton cmd="boatHold" disabled={!canCommand || !!busy}
              onConfirm={() => run('hold', boatApi.hold, 'Holding position')} />
            <CommandButton cmd="boatRth" disabled={!canCommand || !!busy}
              onConfirm={() => run('rtl', boatApi.rtl, 'Boat returning home')} />
            <CommandButton cmd="boatStop" disabled={!online || busy === 'stop'}
              onConfirm={() => run('stop', boatApi.emergencyStop, 'Boat stopped')} />
          </CommandPanel>
        </div>
      </div>
    </div>
  )
}
