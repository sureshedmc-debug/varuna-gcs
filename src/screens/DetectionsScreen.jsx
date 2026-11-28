import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MapContainer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import CachedTileLayer from '../components/CachedTileLayer'
import { api } from '../api/client'
import { usePolling, useNow } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { StatusOrb, Spinner } from '../components/ui'
import { fmtClock, fmtCoord, num } from '../lib/format'
import { useTrashStats, resetTrashStats } from '../lib/detectionStats'
import { useTrashLog, clearTrashLog, mapsLink, ensurePhoto, hydratePhotos, getTrashLog } from '../lib/trashLog'
import { useMissionRecording, captureMissionPoster, clearMissionRecording } from '../lib/missionRecording'
import { generateReportNarrative } from '../lib/reportAi'
import { getLlmConfig, isLlmConfigReady } from '../lib/assistant/llmSettings'
import LlmPicker from '../components/LlmPicker'
import { EmptyState, Kpi, MoreOptions, Page, Section, TabHeader } from '../components/simple/Simple'
import { renderReportCharts } from '../lib/reportChart'
import { buildTrashDataset, downloadWordReport, fallbackNarrative } from '../lib/reportDoc'
import { fetchBoatReportData } from '../lib/boatReport'
import { describeSighting, estimateWeightG, fmtLength, fmtWeight, getFovSettings, sizeClassOf, SIZE_LABEL } from '../lib/sizeEstimate'
import { heatPoints, buildHotspotPlan } from '../lib/hotspots'
import { googleMapsMultiStopUrl } from '../lib/collectionRoute'
import { setPlanDraft, navigateTo } from '../lib/planDraftStore'
import { getAlertSettings } from '../lib/alertSettings'
import { buildAlertText } from '../lib/alerts/format'
import { sendReportReadyEmail } from '../lib/alerts/email'
import { openWhatsApp } from '../lib/alerts/whatsapp'
import HeatLayer from '../components/HeatLayer'
import TypeBreakdownChart from '../components/TypeBreakdownChart'
import { useImpactStats, resetImpactStats } from '../lib/impactStats'
import { openCertificatePrintView, buildCertificateHtml } from '../lib/certificate'
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
    largestM: s.largestM ?? null, largeCount: s.largeCount ?? 0, totalAreaM2: s.totalAreaM2 ?? null,
    spanM: s.spanM ?? null, cluster: !!s.cluster, sizeCounts: s.sizeCounts || null,
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
    <div className="relative overflow-hidden rounded-b-[14px]" style={{ height: 340 }}>
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
        <div className="pointer-events-none absolute inset-0 z-[400] flex items-center justify-center bg-slate-900/45 p-4 text-center">
          <span className="rounded-xl px-4 py-2.5 text-[13.5px] font-semibold" style={{ background: 'var(--sx-card)', color: 'var(--sx-ink)', boxShadow: 'var(--sx-shadow)' }}>
            No locations yet: finds from the Live tab appear here
          </span>
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
        background: 'var(--sx-card)',
        border: '1px solid var(--sx-line)',
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
            <span className="font-mono text-[11px] tnum text-muted">#{n}</span>
            <span className="text-[14px] font-semibold capitalize text-ink">{d.class}</span>
            {d.count > 1 && (
              <span className="rounded-full px-1.5 py-0.5 font-mono text-[10px] tnum font-bold"
                style={{ background: `${col}22`, color: col }}>×{d.count}</span>
            )}
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
              style={{ background: `${o.color}18`, color: o.color }}>{o.label}</span>
            {d.largestM > 0 && (
              <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                title={describeSighting(d) || ''}
                style={{ background: d.largeCount > 0 ? 'rgba(255,159,10,0.16)' : 'rgba(255,255,255,0.07)', color: d.largeCount > 0 ? '#FF9F0A' : 'var(--muted)' }}>
                {d.cluster ? 'Cluster · ' : ''}{SIZE_LABEL[sizeClassOf(d.largestM)]} {fmtLength(d.largestM)}
              </span>
            )}
          </div>

          {/* Coords */}
          <div className="mt-0.5 font-mono text-[11.5px] tnum text-muted">
            {d.located ? `${fmtCoord(d.lat)}, ${fmtCoord(d.lng)}` : 'No location: there was no GPS fix when it was seen'}
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
                className="rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                style={{ background: 'var(--sx-accent-soft)', color: 'var(--sx-accent-text)' }}>Map ↗</a>
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
                {d.estWidthM  != null && <Detail k="Largest item" v={`${d.estWidthM.toFixed(2)} × ${d.estHeightM.toFixed(2)} m`} />}
                {d.largestM   >  0    && <Detail k="Size class"   v={`${SIZE_LABEL[sizeClassOf(d.largestM)]} (${fmtLength(d.largestM)})`} level={d.largeCount > 0 ? 'warn' : undefined} />}
                {d.totalAreaM2 > 0    && <Detail k="Debris area"  v={`≈${d.totalAreaM2 < 1 ? d.totalAreaM2.toFixed(2) : d.totalAreaM2.toFixed(1)} m²`} />}
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
  const c = level ? { ok: 'var(--sx-ok)', warn: 'var(--sx-warn)' }[level] : 'var(--sx-ink)'
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">{k}</span>
      <span className="font-mono tnum font-semibold" style={{ color: c }}>{v}</span>
    </div>
  )
}

function fmtHours(sec) {
  const h = (Number(sec) || 0) / 3600
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round((Number(sec) || 0) / 60)} min`
}
function fmtArea(m2) {
  m2 = Number(m2) || 0
  return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DetectionsScreen() {
  const det        = usePolling(() => api.aiDetections(50), 5000)
  const toast      = useToast()
  const trashStats = useTrashStats()
  const sightings  = useTrashLog()
  const video      = useMissionRecording()
  const impact     = useImpactStats()

  const [reporting,  setReporting]  = useState(false)
  const [expanded,   setExpanded]   = useState(null)
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
  const types = Object.entries(byClassCounts).sort((a, b) => b[1] - a[1])
  return (
    <Page>
    <TabHeader icon="detections" title="Detections"
      hint="Every piece of plastic the drone has found and where it was. Turn it into a report for the authorities in one click.">
      <button type="button" className="sx-btn" disabled={reporting} onClick={generateReport}>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>
        {reporting ? 'Generating…' : 'Generate report'}
      </button>
    </TabHeader>

    <div className="sx-kpis">
      <Kpi label="Plastic found" value={allRows.length} note={types.length ? `${types.length} type${types.length === 1 ? '' : 's'}` : 'none yet'} color="var(--sx-accent)" />
      <Kpi label="With GPS location" value={locatedCount} note={allRows.length ? `${Math.round((locatedCount / allRows.length) * 100)}% of finds` : '—'} color="var(--sx-ok)" />
      <Kpi label="Area covered" value={fmtArea(impact.areaCoveredM2)} />
      <Kpi label="Flight time" value={fmtHours(impact.flightSeconds)} />
      <Kpi label="Missions flown" value={impact.missionsCompleted} />
    </div>

    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
      {/* ── Left: map + list ── */}
      <div className="flex min-w-0 flex-col gap-4">
        <Section title="Where it was found" sub={locatedCount ? `${locatedCount} location${locatedCount === 1 ? '' : 's'} on the map` : 'Locations appear as the drone finds plastic'}
          actions={<>
            <button type="button" className="sx-btn ghost sm" aria-pressed={showHeat} onClick={() => setShowHeat((v) => !v)}
              style={showHeat ? { borderColor: 'var(--sx-accent)', color: 'var(--sx-accent-text)', background: 'var(--sx-accent-soft)' } : undefined}>Heatmap</button>
            <button type="button" className="sx-btn ghost sm" onClick={planFromHotspots} disabled={locatedCount === 0}>Plan from hotspots</button>
            <button type="button" className="sx-btn ghost sm" onClick={openCollectionRoute} disabled={locatedCount === 0}>Collection route ↗</button>
          </>} flush>
          <TrashMap rows={allRows} sightings={sightings} showHeat={showHeat} />
        </Section>

        <Section title="All detections" sub={rows.length !== allRows.length ? `${rows.length} of ${allRows.length} shown` : `${allRows.length} total`} flush>
          <div className="flex flex-wrap items-center gap-2 border-b px-[18px] py-3" style={{ borderColor: 'var(--sx-line)' }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by type, e.g. bottle"
              className="sx-input min-w-[160px] flex-1" style={{ minHeight: 36 }} aria-label="Search detections" />
            <div className="sx-seg" role="group" aria-label="Filter">
              {[{ id: 'all', label: 'All' }, { id: 'located', label: 'Located' }, { id: 'pi', label: 'Drone AI' }, { id: 'webcam', label: 'Webcam' }].map((f) => (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            <select value={sortMode} onChange={(e) => setSortMode(e.target.value)} className="sx-input" style={{ width: 150, minHeight: 36 }} aria-label="Sort">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="conf">Most confident</option>
            </select>
          </div>
          <div className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto p-3">
            {det.loading && rows.length === 0 ? (
              <Spinner label="Loading detections" />
            ) : rows.length === 0 ? (
              allRows.length > 0
                ? <div className="py-10 text-center text-[14px] text-muted">Nothing matches these filters.</div>
                : <EmptyState icon="detections" title="No plastic found yet">
                    Turn on the plastic finder on the Live tab. Every find is saved here with the drone&apos;s GPS position.
                  </EmptyState>
            ) : (
              rows.map((d, i) => (
                <DetectionRow key={d.key} d={d} n={i + 1}
                  expanded={expanded === d.key} onToggle={toggleRow} onWhatsApp={onWhatsApp} />
              ))
            )}
          </div>
          {sightings.length > 0 && (
            <div className="flex justify-end border-t px-[18px] py-2.5" style={{ borderColor: 'var(--sx-line)' }}>
              <button type="button" onClick={clearLog} className="sx-btn ghost sm">Clear recorded locations</button>
            </div>
          )}
        </Section>
      </div>

      {/* ── Right: report, types, impact ── */}
      <div className="flex min-w-0 flex-col gap-4">
        <Section title="Report for the authorities" sub="A Word document with charts, a short analysis and every location with a Google Maps link.">
          <button type="button" className="sx-btn lg w-full" disabled={reporting} onClick={generateReport}>
            {reporting ? 'Generating…' : `Generate report · ${locatedCount} location${locatedCount === 1 ? '' : 's'}`}
          </button>
          <div className="sx-well mt-3 flex items-center justify-between gap-2 px-3 py-2.5 text-[13px]">
            <div className="flex min-w-0 items-center gap-2">
              <StatusOrb level={video.recording ? 'ok' : clips.length ? 'idle' : 'warn'} size={8} pulse={video.recording} />
              <span className="truncate text-muted">
                {video.recording
                  ? <>Recording mission video <RecordingElapsed startedAt={video.startedAt} /></>
                  : clips.length
                    ? `${clips.length} video clip${clips.length === 1 ? '' : 's'} · ${fmtDuration(clipsMs)} · ${fmtBytes(clipsBytes)}`
                    : 'No mission video yet (added to the report when there is one)'}
              </span>
            </div>
            {clips.length > 0 && !video.recording && (
              <div className="flex shrink-0 gap-3">
                <button type="button" onClick={() => downloadMissionVideo(null, false)} className="font-semibold" style={{ color: 'var(--sx-accent-text)' }}>Save</button>
                <button type="button" onClick={() => { clearMissionRecording(); toast.push({ level: 'ok', title: 'Mission video cleared' }) }}
                  className="font-semibold text-muted hover:text-bad">Clear</button>
              </div>
            )}
          </div>
          <MoreOptions id="report-ai" title="AI writing for the report" hint="optional">
            <LlmPicker kind="report" />
            <p className="mt-2 text-[12px] text-muted">
              Separate from the assistant&apos;s AI and kept only in this browser. Without one, the built-in report is used.
            </p>
          </MoreOptions>
          <div className="mt-3 flex items-center justify-between text-[12.5px] text-muted">
            <span>Most seen at once on camera: <b className="tnum text-ink">{trashStats.peak}</b>{trashStats.updatedAt > 0 && <> · {fmtClock(trashStats.updatedAt)}</>}</span>
            <button type="button" className="font-semibold hover:text-ink" onClick={() => { resetTrashStats(); toast.push({ level: 'ok', title: 'Camera count reset' }) }}>Reset</button>
          </div>
        </Section>

        <Section title="By type" sub={types.length ? 'How many of each kind of plastic' : undefined}>
          {types.length ? <TypeBreakdownChart byClass={byClassCounts} /> : <div className="py-3 text-[13.5px] text-muted">The mix of plastic types shows here after the first finds.</div>}
        </Section>

        <Section title="Impact certificate" sub="A printable certificate of the cleanup so far.">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="sx-btn ghost" onClick={() => openCertificatePrintView(buildCertificateHtml({ stats: impact }))}>Open certificate</button>
            <button type="button" className="sx-btn ghost" onClick={() => { if (window.confirm('Reset the impact totals for this browser?')) resetImpactStats() }}>Reset totals</button>
          </div>
        </Section>
      </div>
    </div>
    </Page>
  )
}
