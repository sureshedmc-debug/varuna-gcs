// Mission replay: scrub a slider back through a recorded flight. The map
// marker moves along the position samples, the mission video's currentTime
// is set from the same elapsed offset, and trash sightings whose firstSeen
// falls before the scrubber pop in as markers.
//
// Data source: positionHistory (samples during a mission) + missionRecording
// (the mission video clips) + trashLog (sightings). All in-memory — replay
// only works in the same browser session as the recording, matching how
// mission-video clips already behave.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from 'react-leaflet'
import { StatusOrb, TiltCard } from '../components/ui'
import { fmtCoord, num } from '../lib/format'
import { usePositionHistory, replayableRuns } from '../lib/positionHistory'
import { useMissionRecording } from '../lib/missionRecording'
import { useTrashLog, mapsLink } from '../lib/trashLog'

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

function droneIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#3B9EFF 60%);box-shadow:0 0 12px #3B9EFF;border:2px solid #fff"></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}
function trashMarker(color = '#00B8A9') {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color}aa;border:2px solid #0E1116"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  })
}
const _dIcon = droneIcon()
const _tIcon = trashMarker()

function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
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
  const history = usePositionHistory()
  const video = useMissionRecording()
  const sightings = useTrashLog()
  const runs = useMemo(() => replayableRuns(), [history])
  const [runId, setRunId] = useState(() => runs[runs.length - 1]?.id || null)
  const run = runs.find((r) => r.id === runId) || runs[runs.length - 1] || null
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef(null)

  useEffect(() => {
    if (!run) return
    setIdx(0)
  }, [run?.id])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setIdx((i) => (run && i + 1 < run.samples.length ? i + 1 : (setPlaying(false), i)))
    }, 200)
    return () => clearInterval(t)
  }, [playing, run])

  const sample = run?.samples[idx] || null
  const elapsedMs = sample && run ? sample.t - run.startedAt : 0

  // Best matching video clip: the one whose window (startedAt → startedAt+dur)
  // overlaps the scrubbed timestamp. If none, use the closest by start time.
  const clipObj = useMemo(() => {
    if (!sample) return null
    const list = video.clips || []
    if (!list.length) return null
    for (const c of list) {
      const start = c.startedAt
      const end = start + (c.durationMs || 0)
      if (sample.t >= start && sample.t <= end) return { clip: c, offsetMs: sample.t - start }
    }
    // Fall back to the clip nearest in time.
    let best = null
    let bestDelta = Infinity
    for (const c of list) {
      const d = Math.abs(c.startedAt - (sample?.t || 0))
      if (d < bestDelta) {
        bestDelta = d
        best = { clip: c, offsetMs: 0 }
      }
    }
    return best
  }, [sample, video.clips])

  const clipUrl = useMemo(() => (clipObj ? URL.createObjectURL(clipObj.clip.blob) : null), [clipObj?.clip])
  useEffect(() => () => { if (clipUrl) URL.revokeObjectURL(clipUrl) }, [clipUrl])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !clipObj) return
    const target = Math.max(0, (clipObj.offsetMs || 0) / 1000)
    // Only re-seek if the difference is meaningful — avoids constant re-buffering.
    if (Math.abs((v.currentTime || 0) - target) > 0.25) {
      try {
        v.currentTime = target
      } catch {
        /* the media may not be ready yet */
      }
    }
  }, [clipObj, idx])

  const points = useMemo(() => (run ? run.samples.map((s) => [s.lat, s.lng]) : []), [run])

  const visibleTrash = useMemo(() => {
    if (!sample) return []
    return sightings.filter((s) => s.located && Number(s.firstSeen || 0) <= sample.t)
  }, [sightings, sample])

  if (!runs.length) {
    return (
      <div className="mx-auto max-w-4xl">
        <TiltCard tilt={false} className="p-6">
          <h2 className="mb-2 text-base font-semibold text-ink">Mission replay</h2>
          <p className="text-sm text-muted">
            No replay yet. Start a mission (Save → Upload → Start on Missions) and let it run for a bit — VARUNA records the drone's position through the flight so you can scrub through it here later. Recordings live in this browser session only.
          </p>
        </TiltCard>
      </div>
    )
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[1.5fr_1fr]">
      <TiltCard tilt={false} className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Mission replay</h2>
          <select
            value={run?.id || ''}
            onChange={(e) => setRunId(e.target.value)}
            className="inp px-2 py-1 text-xs"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.startedAt).toLocaleString()} · {r.samples.length} pts
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3 h-[46vh] overflow-hidden rounded-xl border border-line">
          <MapContainer center={points[0] || [17.385, 78.4867]} zoom={17} zoomControl={false} attributionControl={false} style={{ height: '100%', width: '100%', background: '#0E1116' }}>
            <TileLayer url={SAT_URL} maxZoom={19} />
            <FitToRun points={points} />
            {points.length > 1 && <Polyline positions={points} pathOptions={{ color: '#3B9EFF', weight: 2, opacity: 0.6 }} />}
            {sample && <Marker position={[sample.lat, sample.lng]} icon={_dIcon} />}
            {visibleTrash.map((s) => (
              <Marker key={s.id} position={[s.lat, s.lng]} icon={_tIcon}>
                <Popup>
                  <div style={{ font: '12px Inter' }}>
                    <b>{s.class}</b>{s.count > 1 ? ` · ${s.count} items` : ''}<br />
                    <a href={mapsLink(s.lat, s.lng)} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setPlaying((v) => !v)}
            className="rounded-md bg-chip px-3 py-1.5 text-xs font-semibold text-ink hover:bg-chip2"
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, (run?.samples.length || 1) - 1)}
            step={1}
            value={idx}
            onChange={(e) => setIdx(Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="w-24 text-right font-mono tnum text-xs text-muted">
            {fmtHMS(elapsedMs)} / {fmtHMS(run ? (run.stoppedAt || run.samples.at(-1)?.t || run.startedAt) - run.startedAt : 0)}
          </span>
        </div>
      </TiltCard>

      <div className="flex flex-col gap-3">
        <TiltCard tilt={false} className="p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Video (synced)</div>
          {clipUrl ? (
            <video ref={videoRef} src={clipUrl} className="h-auto w-full rounded-md" controls muted playsInline />
          ) : (
            <div className="rounded-md bg-chip px-3 py-6 text-center text-xs text-muted">
              No recorded video for this run. Turn on the AI camera on the Live tab before Start next time.
            </div>
          )}
        </TiltCard>
        <TiltCard tilt={false} className="p-3 text-xs">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">At this moment</div>
          {sample ? (
            <div className="flex flex-col gap-1">
              <div><StatusOrb level="ok" size={8} /> <span className="font-mono tnum">{fmtCoord(sample.lat)}, {fmtCoord(sample.lng)}</span></div>
              <div>Alt: <span className="font-mono tnum">{sample.alt != null ? `${num(sample.alt, 1)} m` : '—'}</span></div>
              <div>Heading: <span className="font-mono tnum">{sample.heading != null ? `${num(sample.heading, 0)}°` : '—'}</span></div>
              <div>Trash spotted so far: <span className="font-mono tnum">{visibleTrash.length}</span></div>
            </div>
          ) : (
            <div className="text-muted">Move the slider to scrub through the flight.</div>
          )}
        </TiltCard>
      </div>
    </div>
  )
}
