import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import CachedTileLayer from '../components/CachedTileLayer'
import 'leaflet/dist/leaflet.css'
import { boatApi } from '../api/boatClient'
import { useBoat } from '../components/BoatContext'
import { useBoatVision } from '../components/BoatVisionContext'
import { useToast } from '../components/Toast'
import { usePolling } from '../hooks/usePolling'
import { boatIcon } from '../components/BoatParts'
import { Chip, NlBoatOffline } from '../components/BoatLabParts'
import { isOk } from '../lib/commands'
import { fmtCoord, relTime } from '../lib/format'
import './boatLab.css'

const DEFAULT_CENTER = [17.385, 78.4867]
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

// Turbidity bands (NTU). Lake water under 10 NTU looks clear; over 150 is murky.
export const NTU_BANDS = [
  { max: 10, label: 'Clear', color: '#059669', tone: 'ok' },
  { max: 50, label: 'Slightly cloudy', color: '#65a30d', tone: 'ok' },
  { max: 150, label: 'Cloudy', color: '#d97706', tone: 'warn' },
  { max: Infinity, label: 'Murky', color: '#dc2626', tone: 'bad' },
]
export function ntuBand(ntu) {
  const n = Number(ntu)
  if (!Number.isFinite(n)) return null
  return NTU_BANDS.find((b) => n < b.max)
}

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

/** Consecutive track points in the same band become one coloured line. */
function bandSegments(points) {
  const segs = []
  let cur = null
  for (const p of points) {
    const b = ntuBand(p.ntu)
    if (!b) continue
    const ll = [p.lat, p.lng]
    if (cur && cur.color === b.color) cur.pts.push(ll)
    else {
      if (cur) cur.pts.push(ll) // join the segments so the line has no gaps
      cur = { color: b.color, pts: cur ? [cur.pts[cur.pts.length - 1], ll] : [ll] }
      segs.push(cur)
    }
  }
  return segs.filter((s) => s.pts.length > 1)
}

function Sparkline({ points }) {
  const W = 300, H = 70, PAD = 6
  if (points.length < 2) return <div className="flex h-16 items-center justify-center nl-text nl-muted">The trend shows once the boat logs a few readings.</div>
  const t0 = points[0].t, t1 = points[points.length - 1].t
  const hi = Math.max(10, ...points.map((p) => p.ntu)) * 1.12
  const X = (t) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD)
  const Y = (n) => H - PAD - (n / hi) * (H - 2 * PAD)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.ntu).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const c = ntuBand(last.ntu)?.color || '#7c3aed'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[70px] w-full" role="img" aria-label="Turbidity over the last ten minutes"
      style={{ filter: 'drop-shadow(0 4px 8px rgba(109,40,217,0.15))' }}>
      <defs>
        <linearGradient id="ntu-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#7c3aed" stopOpacity="0.22" />
          <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[10, 50, 150].filter((v) => v < hi).map((v) => (
        <g key={v}>
          <line x1={PAD} x2={W - PAD} y1={Y(v)} y2={Y(v)} stroke="#ede9fe" strokeDasharray="3 4" />
          <text x={W - PAD} y={Y(v) - 3} textAnchor="end" fontSize="8.5" fill="#8b5cf6">{v} NTU</text>
        </g>
      ))}
      <path d={`${d} L${X(t1)},${H - PAD} L${X(t0)},${H - PAD} Z`} fill="url(#ntu-fill)" />
      <path d={d} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={X(last.t)} cy={Y(last.ntu)} r="4" fill={c} stroke="#fff" strokeWidth="1.5" />
    </svg>
  )
}

export default function WaterLabScreen({ onNavigate }) {
  const boat = useBoat()
  const bv = useBoatVision()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const [refNtu, setRefNtu] = useState('')
  const t = boat.telemetry.data
  const online = boat.reachable === true && !!t
  const water = bv.water
  const measure = bv.vision?.measure
  const pos = online && Number.isFinite(t.lat) && Number.isFinite(t.lng) ? [t.lat, t.lng] : null

  const track = usePolling(() => (online ? boatApi.waterTrack(4000) : Promise.resolve([])), 5000, [online])
  const readings = usePolling(() => (online ? boatApi.waterReadings(100) : Promise.resolve([])), 8000, [online])
  const status = usePolling(() => (online ? boatApi.waterStatus() : Promise.resolve(null)), 10000, [online])
  const pts = Array.isArray(track.data) ? track.data : []
  const rds = Array.isArray(readings.data) ? readings.data : []
  const st = status.data && !status.data._httpError ? status.data : null
  const segs = useMemo(() => bandSegments(pts), [pts])
  const recent = useMemo(() => {
    const cutoff = (pts.length ? pts[pts.length - 1].t : 0) - 600
    return pts.filter((p) => p.t >= cutoff)
  }, [pts])

  const ntu = water?.ntu
  const band = ntuBand(ntu)

  async function run(key, fn, okMsg) {
    setBusy(key)
    try {
      const res = await fn()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || 'Failed' }, okMsg)
      readings.refresh()
      status.refresh()
    } catch (e) {
      toast.push({ level: 'bad', title: `Failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="nl relative" style={{ height: 'calc(100vh - 66px)' }}>
      {/* ── Map ── */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl" style={{ border: '1.5px solid #f0ecff' }}>
        <MapContainer center={pos || DEFAULT_CENTER} zoom={18} zoomControl={false} attributionControl={false}
          style={{ height: '100%', width: '100%', background: '#0E1116' }}>
          <CachedTileLayer url={SAT_URL} maxZoom={19} />
          <CenterOnce position={pos || (pts.length ? [pts[pts.length - 1].lat, pts[pts.length - 1].lng] : null)} />
          {segs.map((s, i) => <Polyline key={i} positions={s.pts} pathOptions={{ color: s.color, weight: 6, opacity: 0.9 }} />)}
          {rds.filter((r) => Number.isFinite(r.lat)).map((r) => (
            <CircleMarker key={r.id} center={[r.lat, r.lng]} radius={9}
              pathOptions={{ color: '#fff', weight: 2.5, fillColor: ntuBand(r.ntu)?.color || '#7c3aed', fillOpacity: 0.95 }}>
              <Tooltip direction="top">{`${r.ntu} NTU · ${r.quality} · ${relTime(r.t * 1000)}`}</Tooltip>
            </CircleMarker>
          ))}
          {pos && <Marker position={pos} icon={boatIcon(t.heading ?? t.yaw)} interactive={false} zIndexOffset={1000} />}
        </MapContainer>
      </div>

      {/* ── Title pill ── */}
      <div className="absolute left-3 top-3 z-20 max-w-[calc(100vw-400px)]">
        <div className="nl-pill flex flex-wrap items-center gap-2 px-3 py-2">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#7c3aed" style={{ flexShrink: 0 }} aria-hidden="true">
            <path d="M12 2s-7 7.6-7 12.5A7 7 0 0019 14.5C19 9.6 12 2 12 2z" />
          </svg>
          <span className="nl-title">Water Lab</span>
          {online && <Chip tone={water?.connected ? 'ok' : 'bad'} dot>{water?.connected ? 'TURBIDITY SENSOR' : 'NO SENSOR'}</Chip>}
          {online && water?.connected && !water.calibrated && (
            <Chip tone="warn" title="Readings use the sensor maker's curve until you calibrate in clear water">NOT CALIBRATED</Chip>
          )}
          {water?.simulated && <Chip tone="warn">SIM</Chip>}
        </div>
      </div>

      {/* ── Side panel ── */}
      <div className="absolute right-3 top-3 z-30 w-[340px] max-w-[calc(100vw-24px)]">
        <div className="nl-panel nl-scroll max-h-[calc(100vh-66px-24px-120px)] p-4">
          <div className="mb-3 nl-eyebrow">Water quality · turbidity</div>
          {!online ? (
            <NlBoatOffline boat={boat} onNavigate={onNavigate} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="nl-card">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="nl-label">Now</div>
                    <div className="nl-big" style={{ color: band?.color, fontSize: 36 }}>
                      {ntu ?? '—'}<span className="ml-1 text-[12px] font-semibold nl-muted">NTU</span>
                    </div>
                  </div>
                  {band && <Chip tone={band.tone} dot>{band.label.toUpperCase()}</Chip>}
                </div>
                {!water?.connected && <div className="mt-2 nl-text" style={{ color: 'var(--nl-warn)' }}>{water?.error || st?.error || 'No reading from the sensor.'}</div>}
                {water?.connected && <div className="mt-1 nl-num text-[11px] nl-muted">{water.volts} V at the sensor</div>}
                <div className="mt-2"><Sparkline points={recent} /></div>
              </div>

              <div className={`nl-card${measure ? ' live' : ''}`}>
                <div className="mb-1 nl-title">Measure here</div>
                <div className="mb-2 nl-text nl-muted">
                  The boat holds still for {bv.cfg?.measure_s ?? 20} s, averages the sensor and saves a reading with its position. The route is logged anyway every few seconds.
                </div>
                {measure ? (
                  <div>
                    <div className="mb-1 nl-text font-bold" style={{ color: 'var(--nl-purple)' }}>Measuring… {Math.ceil(measure.remaining_s)} s left · {measure.samples} samples</div>
                    <div className="nl-track"><div className="nl-fill" style={{ width: `${100 - (measure.remaining_s / (bv.cfg?.measure_s || 20)) * 100}%` }} /></div>
                  </div>
                ) : (
                  <button className="nl-btn w-full" disabled={!water?.connected || !!busy}
                    onClick={() => run('measure', boatApi.waterMeasure, 'Measuring water')}>
                    {busy === 'measure' ? 'Starting…' : 'Measure water here'}
                  </button>
                )}
              </div>

              <div>
                <div className="mb-1.5 nl-eyebrow">Readings</div>
                {rds.length === 0 ? (
                  <div className="nl-text nl-muted">No readings yet. Press Measure, or tick “Measure water at the first item” when uploading a collection.</div>
                ) : (
                  <div className="nl-scroll flex max-h-48 flex-col gap-1.5 pr-0.5">
                    {rds.map((r) => {
                      const b = ntuBand(r.ntu)
                      return (
                        <div key={r.id} className="nl-row">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: b?.color }} />
                          <span className="nl-num w-14 text-xs font-bold">{r.ntu}</span>
                          <span className="flex-1 truncate text-[11px] nl-muted">{r.quality}{r.lat != null ? ` · ${fmtCoord(r.lat)}, ${fmtCoord(r.lng)}` : ''}</span>
                          <span className="nl-num shrink-0 text-[10px] nl-faint">{relTime(r.t * 1000)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="nl-card">
                <div className="mb-1 nl-title">Calibrate the sensor</div>
                <ol className="mb-2 list-decimal pl-4 nl-text nl-muted">
                  <li>Put the probe in clean, clear water (bottled water works) and press <b style={{ color: 'var(--nl-ink)' }}>Clear water</b>.</li>
                  <li>Optional: dip it in a sample of known turbidity, type its NTU and press <b style={{ color: 'var(--nl-ink)' }}>Reference</b>.</li>
                </ol>
                <div className="mb-2 nl-num text-[10px] nl-faint">
                  {st?.clear_volts ? `Clear water: ${st.clear_volts} V` : 'Using the sensor maker’s curve'}
                  {st?.ref_ntu ? ` · Reference: ${st.ref_ntu} NTU at ${st.ref_volts} V` : ''}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="nl-btn" disabled={!water?.connected || !!busy}
                    onClick={() => run('cal', () => boatApi.waterCalibrate('clear'), 'Clear-water point saved')}>Clear water</button>
                  <input id="ref-ntu" type="number" min="1" step="1" placeholder="NTU" value={refNtu} onChange={(e) => setRefNtu(e.target.value)}
                    className="nl-input nl-num w-20" aria-label="Reference sample turbidity in NTU" />
                  <button className="nl-btn soft" disabled={!water?.connected || !refNtu || !!busy}
                    onClick={() => run('cal', () => boatApi.waterCalibrate('reference', Number(refNtu)), 'Reference saved')}>Reference</button>
                  <button className="nl-btn ghost" disabled={!!busy}
                    onClick={() => run('cal', () => boatApi.waterCalibrate('reset'), 'Calibration cleared')}>Reset</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="absolute bottom-3 left-3 z-20">
        <div className="nl-panel p-3">
          <div className="mb-1.5 nl-eyebrow">Route colour · NTU</div>
          <div className="flex flex-col gap-1">
            {NTU_BANDS.map((b, i) => (
              <div key={b.label} className="flex items-center gap-2 text-[11px]">
                <span className="h-1.5 w-6 rounded-full" style={{ background: b.color }} />
                <span className="w-24 font-semibold">{b.label}</span>
                <span className="nl-num nl-muted">{i === 0 ? '< 10' : b.max === Infinity ? '150 +' : `${NTU_BANDS[i - 1].max}–${b.max}`}</span>
              </div>
            ))}
          </div>
          <div className="mt-1.5 text-[10px] nl-faint">{pts.length} points logged</div>
        </div>
      </div>
    </div>
  )
}
