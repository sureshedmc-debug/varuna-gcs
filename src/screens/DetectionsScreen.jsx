import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MapContainer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import CachedTileLayer from '../components/CachedTileLayer'
import { api } from '../api/client'
import { usePolling, useNow } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Btn, StaleBadge, StatusOrb, TiltCard, Spinner } from '../components/ui'
import { ViewToggle, EYE, EYE_OFF } from '../components/ViewToggle'
import { fmtClock, fmtCoord, num } from '../lib/format'
import { useTrashStats, resetTrashStats } from '../lib/detectionStats'
import { useTrashLog, clearTrashLog, mapsLink, ensurePhoto, hydratePhotos, getTrashLog } from '../lib/trashLog'
import { useMissionRecording, captureMissionPoster, clearMissionRecording } from '../lib/missionRecording'
import { generateReportNarrative } from '../lib/reportAi'
import { getLlmConfig, isLlmConfigReady } from '../lib/assistant/llmSettings'
import LlmPicker from '../components/LlmPicker'
import { renderReportCharts } from '../lib/reportChart'
import { buildTrashDataset, downloadWordReport, fallbackNarrative } from '../lib/reportDoc'
import { estimateWeightG, fmtWeight, getFovSettings } from '../lib/sizeEstimate'
import { fetchBoatReportData } from '../lib/boatReport'
import { heatPoints, buildHotspotPlan } from '../lib/hotspots'
import { googleMapsMultiStopUrl } from '../lib/collectionRoute'
import { setPlanDraft, navigateTo } from '../lib/planDraftStore'
import { getAlertSettings } from '../lib/alertSettings'
import { buildAlertText } from '../lib/alerts/format'
import { sendReportReadyEmail } from '../lib/alerts/email'
import { openWhatsApp } from '../lib/alerts/whatsapp'
import HeatLayer from '../components/HeatLayer'
import TypeBreakdownChart from '../components/TypeBreakdownChart'
import ImpactStatStrip from '../components/ImpactStatStrip'
import { useHomePoint, useLivePosition } from '../hooks/useLaptopGps'
import { useSystem } from '../components/SystemContext'

const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const ORIGIN = {
  pi:     { label: 'PI AI',      color: '#3B9EFF' },
  webcam: { label: 'WEBCAM',     color: '#BF5AF2' },
  stream: { label: 'DRONE FEED', color: '#32D74B' },
}
const POS_SOURCE = { drone: 'Drone GPS (live)', laptop: 'Laptop GPS', sim: 'Simulated drone' }

// Per-class accent colour — matches WebcamDetect.jsx CLASS_COLOR
const CLASS_COLOR = {
  'plastic bottle': '#3b82f6',
  'plastic bag':    '#a78bfa',
  styrofoam:        '#f472b6',
  can:              '#fb923c',
  glass:            '#34d399',
  paper:            '#fbbf24',
  tire:             '#f87171',
  cloth:            '#60a5fa',
  'river trash':    '#00ffd4',
  trash:            '#3b82f6',
  human:            '#FFD60A',
  debris:           '#3b82f6',
}
const CLASS_ICON = {
  'plastic bottle': '🍶',
  'plastic bag':    '🛍',
  styrofoam:        '☕',
  can:              '🥫',
  glass:            '🍾',
  paper:            '📄',
  tire:             '🛞',
  cloth:            '🧻',
  'river trash':    '🌊',
  trash:            '🗑',
  debris:           '📦',
  human:            '🧍',
}
function classColor(label) { return CLASS_COLOR[(label || '').toLowerCase()] || '#3b82f6' }
function classIcon(label)  { return CLASS_ICON[(label || '').toLowerCase()] || '📦' }

// ── Utilities ─────────────────────────────────────────────────────────────────
function toMs(ts) {
  if (ts == null) return null
  const n = Number(ts)
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
  const p = Date.parse(ts); return Number.isFinite(p) ? p : null
}
function fromBackend(d, i) {
  const located = d.located !== false && d.lat != null && d.lng != null
  return {
    key: `pi-${d.id ?? (d.timestamp != null ? `${d.timestamp}-${d.class || 'debris'}` : i)}`,
    class: d.class || 'debris', confidence: d.confidence,
    lat: located ? Number(d.lat) : null, lng: located ? Number(d.lng) : null,
    located, alt: d.alt ?? d.altitude ?? null, count: 1,
    origin: 'pi', posSource: located ? 'drone' : null,
    time: toMs(d.timestamp), lastSeen: null,
  }
}
function fromSighting(s) {
  return {
    key: s.id, class: s.class || 'trash', confidence: s.confidence,
    lat: s.lat, lng: s.lng, located: s.located, alt: s.alt, count: s.count,
    origin: s.source === 'stream' ? 'stream' : 'webcam',
    posSource: s.posSource, accuracy: s.accuracy,
    photo: s.photo || null, hasPhoto: !!(s.photo || s.hasPhoto),
    estWidthM: s.estWidthM ?? null, estHeightM: s.estHeightM ?? null,
    estWeightG: estimateWeightG(s.class || 'trash', s.count, getFovSettings().avgWeightG),
    time: s.firstSeen, lastSeen: s.lastSeen,
  }
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—'
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`
}
function stamp() {
  const d = new Date(), p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
function confPctOf(v) {
  const c = Number(v)
  if (v == null || Number.isNaN(c)) return null
  return c <= 1 ? c * 100 : c
}

// ── Live relative age (e.g. "2 min ago") ─────────────────────────────────────
function useRelativeAge(ts) {
  const now = useNow(10000)
  if (!ts) return null
  const s = Math.floor((now - ts) / 1000)
  if (s < 10)  return 'just now'
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m} min ago`
  return `${Math.floor(m / 60)}h ago`
}
function AgeLabel({ time }) {
  const age   = useRelativeAge(time)
  const fresh = time && Date.now() - time < 120000
  const old   = time && Date.now() - time > 600000
  return (
    <span className="text-[10px] font-semibold"
      style={{ color: fresh ? '#32D74B' : old ? 'var(--faint)' : 'var(--muted)' }}>
      {age || '—'}
    </span>
  )
}

// ── Pulsing radar-style map marker ────────────────────────────────────────────
const radarIconCache = new Map()
function radarIcon(label, color, count) {
  const key = `${label}|${color}|${count}`
  if (radarIconCache.has(key)) return radarIconCache.get(key)
  const text  = count > 1 ? `×${count}` : classIcon(label)
  const icon  = L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center">
        <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.18;animation:orb-pulse 2s ease-out infinite"></div>
        <div style="width:22px;height:22px;border-radius:50%;background:${color};color:#04121F;display:flex;align-items:center;justify-content:center;font:700 10px Inter;box-shadow:0 0 10px ${color}aa;border:2px solid #0E1116;position:relative;z-index:1">${text}</div>
      </div>`,
    iconSize:   [28, 28],
    iconAnchor: [14, 14],
  })
  radarIconCache.set(key, icon)
  return icon
}

function FitToPoints({ points }) {
  const map = useMap()
  const n   = points.length
  useEffect(() => {
    if (!n) return
    if (n === 1) map.setView(points[0], 18)
    else map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 18 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, map])
  return null
}

const TrashMap = memo(function TrashMap({ rows, sightings, showHeat }) {
  const { located, points, numberOf } = useMemo(() => {
    const numberOf = new Map(rows.map((r, i) => [r.key, i + 1]))
    const located  = rows.filter((r) => r.located)
    return { located, points: located.map((r) => [r.lat, r.lng]), numberOf }
  }, [rows])
  const heat = useMemo(() => (showHeat ? heatPoints(sightings || []) : []), [sightings, showHeat])
  return (
    <div className="relative mb-3 overflow-hidden rounded-xl border border-line" style={{ height: 220 }}>
      <MapContainer center={points[0] || [17.385, 78.4867]} zoom={16} zoomControl={false}
        attributionControl={false} style={{ height: '100%', width: '100%', background: '#0E1116' }}>
        <CachedTileLayer url={SAT_URL} maxZoom={19} />
        <FitToPoints points={points} />
        {showHeat && heat.length > 0 && <HeatLayer points={heat} />}
        {located.map((r) => (
          <Marker key={r.key} position={[r.lat, r.lng]}
            icon={radarIcon(r.class, classColor(r.class), r.count > 1 ? r.count : numberOf.get(r.key))}>
            <Popup>
              <div style={{ font: '12px Inter', minWidth: 170 }}>
                <b>{r.class}</b> · {ORIGIN[r.origin].label}
                {r.count > 1 && <> · {r.count} items</>}<br />
                <span style={{ fontFamily: 'monospace' }}>{fmtCoord(r.lat)}, {fmtCoord(r.lng)}</span><br />
                {fmtClock(r.time)}<br />
                <a href={mapsLink(r.lat, r.lng)} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      {!located.length && (
        <div className="pointer-events-none absolute inset-0 z-[400] flex items-center justify-center bg-black/40 text-center text-xs text-muted">
          No trash locations yet — start detection on the Live tab.
        </div>
      )}
    </div>
  )
})

// ── Detection row (redesigned, all expand/photo logic intact) ─────────────────
const DetectionRow = memo(function DetectionRow({ d, n, expanded, onToggle, onWhatsApp }) {
  const confPct = confPctOf(d.confidence)
  const o       = ORIGIN[d.origin]
  const col     = classColor(d.class)
  const icon    = classIcon(d.class)

  return (
    <motion.div layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
      className="overflow-hidden rounded-xl"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      whileHover={{ borderColor: `${col}44`, boxShadow: `0 0 0 1px ${col}18` }}
    >
      {/* Main row */}
      <div className="flex w-full items-center gap-0">
        {/* Left accent bar */}
        <div className="w-[3px] self-stretch shrink-0 rounded-l-xl" style={{ background: col }} />

        {/* Thumbnail / emoji */}
        <div
          className="mx-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg"
          style={{ background: `${col}14` }}
        >
          {d.photo
            ? <img src={d.photo} alt="" className="h-full w-full rounded-lg object-cover" />
            : icon}
        </div>

        {/* Main info */}
        <button onClick={() => onToggle(d.key)} className="flex min-w-0 flex-1 flex-col py-2.5 pr-2 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] tnum text-faint">#{n}</span>
            <span className="font-semibold text-ink">{d.class}</span>
            {d.count > 1 && (
              <span className="rounded-full px-1.5 py-0.5 font-mono text-[10px] tnum font-bold"
                style={{ background: `${col}22`, color: col }}>×{d.count}</span>
            )}
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
              style={{ background: `${o.color}18`, color: o.color }}>{o.label}</span>
          </div>

          {/* Coords */}
          <div className="mt-0.5 font-mono text-[10px] tnum text-muted">
            {d.located ? `${fmtCoord(d.lat)}, ${fmtCoord(d.lng)}` : 'Unlocated — no GPS fix at capture'}
          </div>

          {/* Confidence bar */}
          {confPct != null && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-chip2">
                <div className="h-full rounded-full transition-all" style={{ width: `${confPct}%`, background: col }} />
              </div>
              <span className="font-mono text-[10px] tnum text-muted">{num(confPct, 0)}%</span>
            </div>
          )}
        </button>

        {/* Right meta */}
        <div className="flex shrink-0 flex-col items-end gap-1.5 px-3 py-2.5">
          {d.located
            ? <a href={mapsLink(d.lat, d.lng)} target="_blank" rel="noreferrer"
                className="rounded-md px-2 py-0.5 text-[10px] font-bold text-accent"
                style={{ background: 'rgba(59,158,255,0.1)' }}>Map ↗</a>
            : <StatusOrb level="warn" size={8} />}
          <AgeLabel time={d.time} />
        </div>
      </div>

      {/* Expanded body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className="flex gap-3 border-t border-line px-4 py-3"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              {d.photo
                ? <img src={d.photo} alt="Trash detection" className="h-20 w-28 shrink-0 rounded-lg object-cover" />
                : d.hasPhoto
                  ? <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg bg-chip text-[10px] text-muted">Loading…</div>
                  : null}
              <div className="grid flex-1 grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <Detail k="Latitude"      v={d.located ? fmtCoord(d.lat) : '—'} />
                <Detail k="Longitude"     v={d.located ? fmtCoord(d.lng) : '—'} />
                <Detail k="Altitude"      v={d.alt != null && Number.isFinite(Number(d.alt)) ? `${num(d.alt, 1)} m` : '—'} />
                <Detail k="Items seen"    v={d.count} />
                <Detail k="Confidence"    v={confPct != null ? `${num(confPct, 0)}%` : '—'} />
                <Detail k="Position from" v={(POS_SOURCE[d.posSource] || '—') + (d.accuracy ? ` ±${d.accuracy} m` : '')} level={d.located ? 'ok' : 'warn'} />
                <Detail k="Detected by"   v={o.label} />
                <Detail k="First seen"    v={fmtClock(d.time)} />
                <Detail k="Last seen"     v={d.lastSeen ? fmtClock(d.lastSeen) : '—'} />
                {d.estWidthM  != null && <Detail k="Est. size"   v={`${d.estWidthM.toFixed(2)} × ${d.estHeightM.toFixed(2)} m`} />}
                {d.estWeightG != null && <Detail k="Est. weight" v={d.estWeightG >= 1000 ? `~${(d.estWeightG / 1000).toFixed(1)} kg` : `~${d.estWeightG} g`} />}
              </div>
            </div>
            {d.located && (
              <div className="flex flex-wrap gap-2 border-t border-line px-4 py-2"
                style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <button onClick={() => onWhatsApp?.(d)}
                  className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-ink transition-colors hover:bg-chip2"
                  style={{ background: 'var(--chip)' }}>
                  Alert on WhatsApp
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}, sameRow)

function sameRow(a, b) {
  if (a.n !== b.n || a.expanded !== b.expanded || a.onToggle !== b.onToggle || a.onWhatsApp !== b.onWhatsApp) return false
  if (a.d === b.d) return true
  const ka = Object.keys(a.d)
  return ka.length === Object.keys(b.d).length && ka.every((k) => a.d[k] === b.d[k])
}
function RecordingElapsed({ startedAt }) {
  const now = useNow(1000); return fmtDuration(now - startedAt)
}
function Detail({ k, v, level }) {
  const c = level ? { ok: '#32D74B', warn: '#FF9F0A' }[level] : '#F2F4F7'
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted">{k}</span>
      <span className="font-mono tnum font-semibold" style={{ color: c }}>{v}</span>
    </div>
  )
}

// ── Stat block (top stats row) ────────────────────────────────────────────────
function Stat({ label, value, level }) {
  const c = level ? { ok: '#32D74B', warn: '#FF9F0A' }[level] : 'var(--accent-hex)'
  return (
    <div className="rounded-xl px-3 py-2.5 text-center"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="font-mono text-xl font-bold tnum" style={{ color: c }}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted">{label}</div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DetectionsScreen() {
  const det        = usePolling(() => api.aiDetections(50), 5000)
  const toast      = useToast()
  const trashStats = useTrashStats()
  const sightings  = useTrashLog()
  const video      = useMissionRecording()

  const [reporting,  setReporting]  = useState(false)
  const [expanded,   setExpanded]   = useState(null)
  const [showReport, setShowReport] = useState(true)
  const [showHeat,   setShowHeat]   = useState(false)
  const [filter,     setFilter]     = useState('all')   // 'all' | 'pi' | 'webcam' | 'located'
  const [search,     setSearch]     = useState('')
  const [sortMode,   setSortMode]   = useState('newest')

  const toggleRow = useCallback((key) => {
    setExpanded((cur) => (cur === key ? null : key))
    ensurePhoto(key)
  }, [])

  const { telemetry, simulated } = useSystem()
  const live      = useLivePosition(telemetry.data)
  const homePoint = useHomePoint(telemetry.data, live, simulated)

  const onWhatsApp = useCallback((d) => {
    const text = buildAlertText({ itemCount: d.count, cls: d.class, lat: d.lat, lng: d.lng, source: d.origin })
    const ok   = openWhatsApp(text)
    if (!ok) toast.push({ level: 'warn', title: 'Popup blocked — allow pop-ups for VARUNA to open WhatsApp.' })
  }, [toast])

  function planFromHotspots() {
    const plan = buildHotspotPlan(sightings, { home: homePoint })
    if (!plan.ok) return toast.push({ level: 'warn', title: 'Cannot plan from hotspots', msg: plan.reason })
    setPlanDraft({
      name: `Hotspots (${plan.waypoints.length})`, waypoints: plan.waypoints,
      altitude: plan.altitude, speedKmh: plan.speedKmh, pattern: 'hotspot',
      lakeName: `${plan.waypoints.length} hotspots`, polygon: null,
      summary: `Hotspot route · ${plan.waypoints.length} stops · ${(plan.lengthM / 1000).toFixed(1)} km · ~${plan.minutes} min`,
      warnings: plan.warnings,
    })
    navigateTo('mission')
    toast.push({ level: 'ok', title: 'Hotspot draft loaded on Missions', msg: 'Review, then Save → Upload → Start.' })
  }

  function openCollectionRoute() {
    const points = rows.filter((r) => r.located).map((r) => [r.lat, r.lng])
    if (!points.length) return toast.push({ level: 'warn', title: 'No located trash yet.' })
    if (homePoint) points.unshift(homePoint)
    const { url, dropped, stops } = googleMapsMultiStopUrl(points)
    if (!url) return toast.push({ level: 'warn', title: 'Could not build a route.' })
    window.open(url, '_blank', 'noopener,noreferrer')
    toast.push({ level: dropped ? 'warn' : 'ok', title: dropped ? `Route opened with ${stops} stops (${dropped} dropped)` : `Route opened (${stops} stops)` })
  }

  const backend = det.data?.detections
  const allRows = useMemo(() => {
    const all = [...sightings.map(fromSighting), ...(backend || []).map(fromBackend)]
    return all.sort((a, b) => (b.time || 0) - (a.time || 0))
  }, [sightings, backend])

  // Filter + search + sort
  const rows = useMemo(() => {
    let r = allRows
    if (filter === 'pi')      r = r.filter((d) => d.origin === 'pi')
    if (filter === 'webcam')  r = r.filter((d) => d.origin !== 'pi')
    if (filter === 'located') r = r.filter((d) => d.located)
    if (search.trim())        r = r.filter((d) => d.class.toLowerCase().includes(search.toLowerCase()))
    if (sortMode === 'oldest')  r = [...r].sort((a, b) => (a.time || 0) - (b.time || 0))
    if (sortMode === 'conf')    r = [...r].sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    return r
  }, [allRows, filter, search, sortMode])

  const locatedCount = allRows.filter((d) => d.located).length
  const byClassCounts = useMemo(() => {
    const out = {}
    for (const r of allRows) { const c = r.class || 'trash'; out[c] = (out[c] || 0) + Math.max(1, Number(r.count) || 1) }
    return out
  }, [allRows])

  function clearLog() {
    if (!sightings.length) return
    if (!window.confirm(`Clear ${sightings.length} recorded trash location(s) from this browser?`)) return
    clearTrashLog(); toast.push({ level: 'ok', title: 'Trash locations cleared' })
  }

  const clips      = video.clips
  const clipsMs    = clips.reduce((a, c) => a + c.durationMs, 0)
  const clipsBytes = clips.reduce((a, c) => a + c.blob.size, 0)
  const clipNames  = (s) => clips.map((_, i) => `varuna-mission-${s}${clips.length > 1 ? `-${i + 1}` : ''}.webm`)

  function downloadMissionVideo(names, silent) {
    if (!clips.length) return []
    const files = names || clipNames(stamp())
    clips.forEach((c, i) => {
      const url = URL.createObjectURL(c.blob), a = document.createElement('a')
      a.href = url; a.download = files[i]; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    })
    if (!silent) toast.push({ level: 'ok', title: `Mission video downloaded (${files.length} file${files.length === 1 ? '' : 's'})`, msg: files.join(', ') })
    return files
  }

  async function generateReport() {
    setReporting(true)
    const reportCfg = getLlmConfig('report')
    try {
      await hydratePhotos(500)
      const withPhotos = [...getTrashLog().map(fromSighting), ...(backend || []).map(fromBackend)]
        .sort((a, b) => (b.time || 0) - (a.time || 0))
      const data   = buildTrashDataset(withPhotos, trashStats)
      data.boat    = await fetchBoatReportData().catch(() => null)
      const boatHasData = !!(data.boat?.catch?.total || data.boat?.water?.readings?.length || data.boat?.wildlife?.sightings?.length)
      if (data.summary.total === 0 && !trashStats.peak && !clips.length && !boatHasData) {
        toast.push({ level: 'warn', title: 'No detection data yet', msg: 'Run the AI camera or wait for detections first.' }); return
      }
      const charts = renderReportCharts(data)
      let videoFiles = []
      if (clips.length) {
        videoFiles = clipNames(stamp())
        const posterDataUrl = await captureMissionPoster()
        data.video = {
          clips: clips.map((c, i) => ({ filename: videoFiles[i], durationMs: c.durationMs, sizeBytes: c.blob.size, startedAt: c.startedAt })),
          posterDataUrl,
        }
      }
      let narrative
      if (isLlmConfigReady(reportCfg)) {
        try {
          const { video: _v, ...slim } = data
          const rowsSlim = slim.detections.slice(0, 40).map(({ photo, mapUrl, lastSeen, ...d }) => d)
          narrative = await generateReportNarrative({ ...slim, detections: rowsSlim, detectionsShown: `${rowsSlim.length} of ${slim.detections.length}` }, { config: reportCfg })
          toast.push({ level: 'ok', title: 'AI analysis ready', msg: 'Building Word document…' })
        } catch (e) {
          narrative = fallbackNarrative(data)
          toast.push({ level: 'warn', title: 'AI unavailable', msg: `${e.message || e}. Used a built-in report instead.` })
        }
      } else {
        narrative = fallbackNarrative(data)
        toast.push({ level: 'warn', title: 'AI not configured', msg: 'Pick a provider under the report card, or continue with the built-in report.' })
      }
      const filename = downloadWordReport({ data, narrative, charts })
      if (videoFiles.length) downloadMissionVideo(videoFiles, true)
      resetTrashStats()
      if (getAlertSettings().enableEmailOnReport) {
        sendReportReadyEmail({ filename, summary: `${data.summary.total} detection(s), ${data.summary.located} located, est. ${fmtWeight(data.summary.totalEstWeightG || 0)} total.` }).catch(() => {})
      }
      toast.push({ level: 'ok', title: 'Report downloaded', msg: videoFiles.length ? `${filename} + ${videoFiles.length} video file${videoFiles.length === 1 ? '' : 's'} · live-cam count reset` : `${filename} · live-cam count reset` })
    } catch (e) { toast.push({ level: 'bad', title: 'Report failed', msg: String(e?.message || e) }) }
    finally { setReporting(false) }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={`mx-auto grid max-w-5xl gap-4 ${showReport ? 'lg:grid-cols-[1.3fr_1fr]' : 'lg:grid-cols-1'}`}>

      {/* ── Left: Detection log ── */}
      <TiltCard tilt={false} className="p-5">

        {/* Header */}
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Detection log</h2>
          <div className="flex items-center gap-2">
            <StaleBadge lastUpdate={det.lastUpdate} connected={!det.error} />
            <ViewToggle compact active={!showReport} onClick={() => setShowReport((v) => !v)}
              label={showReport ? 'Focus' : 'Report'} icon={showReport ? EYE_OFF : EYE} />
          </div>
        </div>

        {/* Stats row */}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Total"         value={allRows.length} />
          <Stat label="Located"       value={locatedCount}               level="ok" />
          <Stat label="Unlocated"     value={allRows.length - locatedCount} level="warn" />
          <Stat label="Live-cam peak" value={trashStats.peak} />
        </div>

        {/* Impact strip */}
        <div className="mb-3 rounded-xl px-3 py-2"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted">Impact so far</div>
          <ImpactStatStrip />
        </div>

        {/* Action buttons */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button onClick={() => setShowHeat((v) => !v)}
            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-ink transition-colors hover:bg-chip2"
            style={{ background: showHeat ? 'rgba(59,158,255,0.15)' : 'var(--chip)', border: showHeat ? '1px solid rgba(59,158,255,0.3)' : '1px solid transparent' }}>
            {showHeat ? '🌡 Hide heatmap' : '🌡 Heatmap'}
          </button>
          <button onClick={planFromHotspots} disabled={locatedCount === 0}
            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-ink transition-colors hover:bg-chip2 disabled:opacity-40"
            style={{ background: 'var(--chip)' }}>
            ✈ Plan from hotspots
          </button>
          <button onClick={openCollectionRoute} disabled={locatedCount === 0}
            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-ink transition-colors hover:bg-chip2 disabled:opacity-40"
            style={{ background: 'var(--chip)' }}>
            🗺 Collection route ↗
          </button>
        </div>

        {/* Map */}
        <TrashMap rows={allRows} sightings={sightings} showHeat={showHeat} />

        {/* Type breakdown */}
        {allRows.length > 0 && (
          <div className="mb-3 rounded-xl px-3 py-2"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted">Type breakdown</div>
            <TypeBreakdownChart byClass={byClassCounts} />
          </div>
        )}

        {/* Filter + search bar */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍  Search class…"
            className="inp min-w-[120px] flex-1 rounded-xl px-3 py-1.5 text-xs"
          />
          {[
            { id: 'all',     label: 'All' },
            { id: 'pi',      label: 'PI AI' },
            { id: 'webcam',  label: 'Webcam' },
            { id: 'located', label: 'Located' },
          ].map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className="rounded-full px-3 py-1 text-[11px] font-semibold transition-all"
              style={filter === f.id
                ? { background: 'rgba(59,158,255,0.15)', color: 'var(--accent-hex)', border: '1px solid rgba(59,158,255,0.3)' }
                : { background: 'var(--chip)', color: 'var(--muted)', border: '1px solid transparent' }}>
              {f.label}
            </button>
          ))}
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value)}
            className="inp rounded-xl px-2.5 py-1 text-xs" style={{ width: 130 }}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="conf">Highest conf.</option>
          </select>
        </div>

        {/* Detection list */}
        <div className="flex max-h-[46vh] flex-col gap-2 overflow-y-auto pr-1">
          {det.loading && rows.length === 0 ? (
            <Spinner label="Loading detections" />
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted">
              {allRows.length > 0 ? 'No results match your filters.' : 'No trash detected yet.'}
              {allRows.length === 0 && (
                <div className="mt-1 text-xs">Start detection on the Live tab — each sighting is stamped with the drone&apos;s live GPS.</div>
              )}
            </div>
          ) : (
            rows.map((d, i) => (
              <DetectionRow key={d.key} d={d} n={i + 1}
                expanded={expanded === d.key} onToggle={toggleRow} onWhatsApp={onWhatsApp} />
            ))
          )}
        </div>

        {sightings.length > 0 && (
          <div className="mt-2 flex justify-end">
            <button onClick={clearLog}
              className="rounded-md px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:text-bad">
              Clear recorded locations
            </button>
          </div>
        )}
      </TiltCard>

      {/* ── Right: Report card ── */}
      <AnimatePresence>
        {showReport && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
            <TiltCard className="flex h-full flex-col p-5">
              <h2 className="mb-1 text-base font-semibold text-ink">AI environmental report</h2>
              <p className="mb-3 text-xs text-muted">
                Generates a Word document with 3D graphs, analysis, and every trash location with coordinates and a Google Maps link.
              </p>

              {/* LLM picker */}
              <div className="mb-3 rounded-xl p-3"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <LlmPicker kind="report" />
                <p className="mt-2 text-[10px] text-muted">
                  Independent from the voice assistant's AI. Stored only in this browser. Nothing configured → built-in report is used.
                </p>
              </div>

              {/* Generate button */}
              <Btn disabled={reporting} onClick={generateReport} className="mb-3">
                {reporting ? 'Generating…' : `📄 Generate report (Word) · ${locatedCount} location${locatedCount === 1 ? '' : 's'}`}
              </Btn>

              {/* Video status */}
              <div className="mb-3 flex items-center justify-between rounded-xl px-3 py-2.5 text-xs"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-2">
                  <StatusOrb level={video.recording ? 'ok' : clips.length ? 'idle' : 'warn'} size={8} pulse={video.recording} />
                  <span className="text-muted">
                    {video.recording
                      ? <><>Recording… </><RecordingElapsed startedAt={video.startedAt} /></>
                      : clips.length
                        ? `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${fmtDuration(clipsMs)} · ${fmtBytes(clipsBytes)}`
                        : 'No mission video yet'}
                  </span>
                </div>
                {clips.length > 0 && !video.recording && (
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => downloadMissionVideo(null, false)} className="font-semibold text-accent">↓ Save</button>
                    <button onClick={() => { clearMissionRecording(); toast.push({ level: 'ok', title: 'Mission video cleared' }) }}
                      className="font-semibold text-muted transition-colors hover:text-bad">Clear</button>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-[11px] text-muted">
                <span>
                  Live-cam peak: <span className="font-mono tnum text-ink">{trashStats.peak}</span>
                  {trashStats.updatedAt > 0 && <span className="ml-1">· {fmtClock(trashStats.updatedAt)}</span>}
                </span>
                <button
                  onClick={() => { resetTrashStats(); toast.push({ level: 'ok', title: 'Live-cam count reset' }) }}
                  className="rounded-md px-2 py-1 font-semibold text-muted transition-colors hover:text-ink">
                  Reset
                </button>
              </div>
            </TiltCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
