// Mission replay: scrub a slider back through a recorded flight. The map
// marker moves along the position samples, the mission video's currentTime
// is set from the same elapsed offset, and trash sightings whose firstSeen
// falls before the scrubber pop in as markers.
//
// Data source: positionHistory (samples during a mission) + missionRecording
// (the mission video clips) + trashLog (sightings). All in-memory — replay
// only works in the same browser session as the recording.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Polyline, Popup, useMap } from 'react-leaflet'
import CachedTileLayer from '../components/CachedTileLayer'
import { StatusOrb, TiltCard } from '../components/ui'
import { fmtCoord, num } from '../lib/format'
import { usePositionHistory, replayableRuns } from '../lib/positionHistory'
import { useMissionRecording } from '../lib/missionRecording'
import { useTrashLog, mapsLink } from '../lib/trashLog'

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

// Per-class colour for timeline dots (mirrors DetectionsScreen)
const CLASS_COLOR = {
  'plastic bottle': '#3b82f6', 'plastic bag': '#a78bfa', styrofoam: '#f472b6',
  can: '#fb923c', glass: '#34d399', paper: '#fbbf24', tire: '#f87171',
  cloth: '#60a5fa', 'river trash': '#00ffd4', trash: '#3b82f6', debris: '#3b82f6',
}
function classColor(label) { return CLASS_COLOR[(label || '').toLowerCase()] || '#3b82f6' }

const CLASS_ICON = {
  'plastic bottle': '🍶', 'plastic bag': '🛍', styrofoam: '☕', can: '🥫',
  glass: '🍾', paper: '📄', tire: '🛞', cloth: '🧻', 'river trash': '🌊',
  trash: '🗑', debris: '📦',
}
function classIcon(label) { return CLASS_ICON[(label || '').toLowerCase()] || '📦' }

function droneIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#3B9EFF 60%);box-shadow:0 0 12px #3B9EFF;border:2px solid #fff"></div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  })
}
function trashMarkerIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color}aa;border:2px solid #0E1116"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  })
}
const _dIcon = droneIcon()

function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function FitToRun({ points }) {
  const map = useMap()
  const key = points.length
  useEffect(() => {
    if (!key) return
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 19 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return null
}

export default function ReplayScreen() {
  const history  = usePositionHistory()
  const video    = useMissionRecording()
  const sightings = useTrashLog()
  const runs     = useMemo(() => replayableRuns(), [history])
  const [runId,    setRunId]   = useState(() => runs[runs.length - 1]?.id || null)
  const run      = runs.find((r) => r.id === runId) || runs[runs.length - 1] || null
  const [idx,     setIdx]     = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed,   setSpeed]   = useState(1)  // playback multiplier: 0.5 / 1 / 2
  const videoRef = useRef(null)

  useEffect(() => { if (!run) return; setIdx(0) }, [run?.id])

  useEffect(() => {
    if (!playing) return
    const ms = Math.round(200 / speed)
    const t  = setInterval(() => {
      setIdx((i) => (run && i + 1 < run.samples.length ? i + 1 : (setPlaying(false), i)))
    }, ms)
    return () => clearInterval(t)
  }, [playing, run, speed])

  const sample    = run?.samples[idx] || null
  const elapsedMs = sample && run ? sample.t - run.startedAt : 0
  const totalMs   = run ? (run.stoppedAt || run.samples.at(-1)?.t || run.startedAt) - run.startedAt : 0

  const clipObj = useMemo(() => {
    if (!sample) return null
    const list = video.clips || []
    if (!list.length) return null
    for (const c of list) {
      const end = c.startedAt + (c.durationMs || 0)
      if (sample.t >= c.startedAt && sample.t <= end) return { clip: c, offsetMs: sample.t - c.startedAt }
    }
    let best = null, bestDelta = Infinity
    for (const c of list) {
      const d = Math.abs(c.startedAt - (sample?.t || 0))
      if (d < bestDelta) { bestDelta = d; best = { clip: c, offsetMs: 0 } }
    }
    return best
  }, [sample, video.clips])

  const clipUrl = useMemo(() => (clipObj ? URL.createObjectURL(clipObj.clip.blob) : null), [clipObj?.clip])
  useEffect(() => () => { if (clipUrl) URL.revokeObjectURL(clipUrl) }, [clipUrl])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !clipObj) return
    const target = Math.max(0, (clipObj.offsetMs || 0) / 1000)
    if (Math.abs((v.currentTime || 0) - target) > 0.25) {
      try { v.currentTime = target } catch { /* not ready */ }
    }
  }, [clipObj, idx])

  const points      = useMemo(() => (run ? run.samples.map((s) => [s.lat, s.lng]) : []), [run])
  const visibleTrash = useMemo(() => {
    if (!sample) return []
    return sightings.filter((s) => s.located && Number(s.firstSeen || 0) <= sample.t)
  }, [sightings, sample])
  const allTrash = sightings.filter((s) => s.located)

  // ── No-data empty state ────────────────────────────────────────────────────
  if (!runs.length) {
    return (
      <div className="mx-auto max-w-4xl">
        <TiltCard tilt={false} className="p-6">
          <h2 className="mb-2 text-base font-semibold text-ink">Mission replay</h2>
          <p className="text-sm text-muted">
            No replay yet. Start a mission (Save → Upload → Start on Missions) and let it run for a bit — VARUNA records the drone&apos;s position through the flight so you can scrub through it here later. Recordings live in this browser session only.
          </p>
        </TiltCard>
      </div>
    )
  }

  const progressPct = run?.samples.length > 1 ? (idx / (run.samples.length - 1)) * 100 : 0

  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[1.5fr_1fr]">

      {/* ── Left column: map + scrubber ── */}
      <TiltCard tilt={false} className="p-4">

        {/* Run selector — pill chips */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="eyebrow shrink-0">Run</span>
          {runs.map((r) => {
            const label = new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const on    = r.id === (run?.id)
            return (
              <button key={r.id} onClick={() => setRunId(r.id)}
                className="rounded-full px-3 py-1 text-[11px] font-semibold transition-all"
                style={on
                  ? { background: 'rgba(59,158,255,0.15)', color: 'var(--accent-hex)', border: '1px solid rgba(59,158,255,0.3)' }
                  : { background: 'var(--chip)', color: 'var(--muted)', border: '1px solid transparent' }}>
                {label} · {r.samples.length} pts
              </button>
            )
          })}
        </div>

        {/* Map */}
        <div className="mb-3 overflow-hidden rounded-xl border border-line" style={{ height: '46vh' }}>
          <MapContainer center={points[0] || [17.385, 78.4867]} zoom={17} zoomControl={false}
            attributionControl={false} style={{ height: '100%', width: '100%', background: '#0E1116' }}>
            <CachedTileLayer url={SAT_URL} maxZoom={19} />
            <FitToRun points={points} />
            {/* Full path (faded) */}
            {points.length > 1 && (
              <Polyline positions={points} pathOptions={{ color: '#3B9EFF', weight: 2, opacity: 0.3 }} />
            )}
            {/* Played path (bright) */}
            {points.length > 1 && idx > 0 && (
              <Polyline positions={points.slice(0, idx + 1)} pathOptions={{ color: '#3B9EFF', weight: 2.5, opacity: 0.9 }} />
            )}
            {/* Drone position */}
            {sample && <Marker position={[sample.lat, sample.lng]} icon={_dIcon} />}
            {/* Trash markers — visible = reached, future = dimmed */}
            {allTrash.map((s) => {
              const col      = classColor(s.class)
              const reached  = Number(s.firstSeen || 0) <= (sample?.t || 0)
              const icon     = L.divIcon({
                className: '',
                html: `<div style="width:${reached ? 14 : 10}px;height:${reached ? 14 : 10}px;border-radius:50%;background:${col};opacity:${reached ? 1 : 0.28};box-shadow:${reached ? `0 0 8px ${col}aa` : 'none'};border:2px solid #0E1116"></div>`,
                iconSize:   [reached ? 14 : 10, reached ? 14 : 10],
                iconAnchor: [reached ? 7 : 5,   reached ? 7 : 5],
              })
              return (
                <Marker key={s.id} position={[s.lat, s.lng]} icon={icon}>
                  <Popup>
                    <div style={{ font: '12px Inter' }}>
                      <b>{s.class}</b>{s.count > 1 ? ` · ${s.count} items` : ''}{!reached ? ' (not reached yet)' : ''}<br />
                      <a href={mapsLink(s.lat, s.lng)} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
                    </div>
                  </Popup>
                </Marker>
              )
            })}
          </MapContainer>
        </div>

        {/* Scrubber panel */}
        <div className="rounded-xl p-3"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>

          {/* Speed controls */}
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Timeline</span>
            <div className="flex gap-1.5">
              {[0.5, 1, 2].map((s) => (
                <button key={s} onClick={() => setSpeed(s)}
                  className="rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all"
                  style={speed === s
                    ? { background: 'var(--accent-hex)', color: '#04121F' }
                    : { background: 'var(--chip)', color: 'var(--muted)' }}>
                  {s}×
                </button>
              ))}
            </div>
          </div>

          {/* Progress bar with event dots */}
          <div className="relative mb-2" style={{ height: 20 }}>
            {/* Track */}
            <div className="absolute left-0 right-0 top-1/2 h-[4px] -translate-y-1/2 overflow-hidden rounded-full bg-chip2">
              <div className="h-full rounded-full bg-accent transition-all duration-200"
                style={{ width: `${progressPct}%` }} />
            </div>
            {/* Event dots */}
            {run && allTrash.map((s, i) => {
              const eventT  = Number(s.firstSeen || 0)
              const runT    = run.startedAt
              const endT    = run.stoppedAt || run.samples.at(-1)?.t || runT
              if (eventT < runT || eventT > endT) return null
              const pct     = ((eventT - runT) / (endT - runT)) * 100
              const col     = classColor(s.class)
              const reached = eventT <= (sample?.t || 0)
              return (
                <div key={i} title={`${s.class}${s.count > 1 ? ` ×${s.count}` : ''}`}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ left: `${pct}%`, width: 10, height: 10, background: col, opacity: reached ? 1 : 0.35, border: '2px solid #0E1116', zIndex: 2 }} />
              )
            })}
            {/* Thumb */}
            <input type="range" min={0} max={Math.max(0, (run?.samples.length || 1) - 1)}
              step={1} value={idx} onChange={(e) => setIdx(Number(e.target.value))}
              className="absolute inset-0 w-full opacity-0 cursor-pointer" style={{ zIndex: 3 }} />
          </div>

          {/* Play + time */}
          <div className="flex items-center gap-3">
            <button onClick={() => setPlaying((v) => !v)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-bold text-white transition-all"
              style={{ background: 'var(--accent-hex)', boxShadow: '0 0 12px rgba(59,158,255,0.4)' }}>
              {playing ? '⏸' : '▶'}
            </button>
            <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-chip2">
              <div className="h-full rounded-full bg-accent transition-all duration-200" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="w-24 shrink-0 text-right font-mono text-xs tnum text-muted">
              {fmtHMS(elapsedMs)} / {fmtHMS(totalMs)}
            </span>
          </div>
        </div>
      </TiltCard>

      {/* ── Right column: video + at-this-moment + trash timeline ── */}
      <div className="flex flex-col gap-3">

        {/* Synced video */}
        <TiltCard tilt={false} className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Video (synced)</span>
            {video.clips?.length > 0 && (
              <span className="text-[10px] text-muted">{video.clips.length} clip{video.clips.length === 1 ? '' : 's'}</span>
            )}
          </div>
          {clipUrl ? (
            <video ref={videoRef} src={clipUrl}
              className="w-full rounded-lg" style={{ aspectRatio: '16/9', background: '#000' }}
              controls muted playsInline />
          ) : (
            <div className="rounded-lg px-3 py-6 text-center text-xs text-muted"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              No recorded video for this run. Turn on the AI camera on the Live tab before Start next time.
            </div>
          )}
        </TiltCard>

        {/* At this moment — grid layout */}
        <TiltCard tilt={false} className="p-3">
          <div className="mb-2 eyebrow">At this moment</div>
          {sample ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { k: 'Latitude',  v: fmtCoord(sample.lat) },
                  { k: 'Longitude', v: fmtCoord(sample.lng) },
                  { k: 'Altitude',  v: sample.alt != null ? `${num(sample.alt, 1)} m` : '—' },
                  { k: 'Heading',   v: sample.heading != null ? `${num(sample.heading, 0)}°` : '—' },
                ].map(({ k, v }) => (
                  <div key={k} className="rounded-lg px-2.5 py-2"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <div className="text-[9px] uppercase tracking-wider text-faint">{k}</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tnum text-ink">{v}</div>
                  </div>
                ))}
              </div>
              {/* Trash progress */}
              <div className="mt-2 rounded-lg px-2.5 py-2"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="mb-1 text-[9px] uppercase tracking-wider text-faint">Trash spotted so far</div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-bold tnum text-accent">{visibleTrash.length}</span>
                  <div className="flex-1 overflow-hidden rounded-full bg-chip2" style={{ height: 4 }}>
                    <div className="h-full rounded-full bg-accent transition-all"
                      style={{ width: allTrash.length > 0 ? `${(visibleTrash.length / allTrash.length) * 100}%` : '0%' }} />
                  </div>
                  <span className="text-[10px] text-faint">of {allTrash.length}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="py-2 text-sm text-muted">Move the slider to scrub through the flight.</div>
          )}
        </TiltCard>

        {/* Trash event timeline */}
        {allTrash.length > 0 && (
          <TiltCard tilt={false} className="p-3">
            <div className="mb-2 eyebrow">Detections in run</div>
            <div className="flex flex-col">
              {sightings.filter((s) => s.located).slice(0, 10).map((s, i) => {
                const col     = classColor(s.class)
                const icon    = classIcon(s.class)
                const reached = Number(s.firstSeen || 0) <= (sample?.t || 0)
                const elapsed = run ? fmtHMS(Number(s.firstSeen || 0) - run.startedAt) : null
                return (
                  <div key={i}
                    className="flex items-center gap-2 border-b py-1.5"
                    style={{ borderColor: 'rgba(255,255,255,0.06)', opacity: reached ? 1 : 0.35 }}>
                    <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: col }} />
                    <span className="text-xs text-ink flex-1 truncate">
                      {icon} {s.class}{s.count > 1 ? ` ×${s.count}` : ''}
                    </span>
                    {elapsed && (
                      <span className="font-mono text-[10px] tnum text-faint shrink-0">{elapsed}</span>
                    )}
                  </div>
                )
              })}
              {sightings.filter((s) => s.located).length > 10 && (
                <div className="pt-1 text-[10px] text-faint">+{sightings.filter((s) => s.located).length - 10} more</div>
              )}
              {!sample && (
                <div className="mt-1 text-[10px] text-faint">Dimmed items not yet reached in replay</div>
              )}
            </div>
          </TiltCard>
        )}
      </div>
    </div>
  )
}
