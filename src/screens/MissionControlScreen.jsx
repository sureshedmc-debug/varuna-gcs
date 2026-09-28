import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { StatusOrb, StaleBadge } from '../components/ui'
import { ThemeToggle } from '../components/ThemeToggle'
import { useLivePosition, useHomePoint } from '../hooks/useLaptopGps'
import { useActiveMission, missionFor } from '../lib/missionStore'
import { useTrashLog, mapsLink } from '../lib/trashLog'
import { clusterHotspots, buildHotspotPlan } from '../lib/hotspots'
import { setPlanDraft } from '../lib/planDraftStore'
import { distanceM, estimateFlight } from '../lib/missionPatterns'
import { pick, bool, num, relTime, DASH } from '../lib/format'
import './homeDashboard.css'

const HomeDrone3D = lazy(() => import('../components/HomeDrone3D'))

/* ---------- rolling series for sparklines (real recent telemetry) ---------- */
function useRolling(value, cap = 24) {
  const [arr, setArr] = useState([])
  const last = useRef(null)
  useEffect(() => {
    const raw = Number(value)
    if (value == null || value === '' || Number.isNaN(raw)) return
    const v = Math.round(raw * 100) / 100 // ignore changes the tiles can't even show
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
    sats: pick(t, ['satellites', 'satellites_visible', 'num_sats', 'sats']),
    volt: pick(t, ['battery_voltage', 'voltage', 'battery']),
    batt: pick(t, ['battery_percent', 'battery_remaining', 'battery_level']),
    alt: pick(t, ['altitude', 'alt', 'relative_alt', 'rel_alt']),
    speed: pick(t, ['speed', 'groundspeed', 'ground_speed']), // m/s
    heading: pick(t, ['heading', 'yaw', 'hdg']),
    climb: pick(t, ['climb', 'climb_rate', 'vertical_speed']),
    hdop: pick(t, ['hdop']),
    fix: pick(t, ['fix_type', 'gps_fix_type']),
    wpCurrent: pick(t, ['mission_current', 'current_wp', 'wp_index', 'current_waypoint']),
  }
}

const toRad = (d) => (d * Math.PI) / 180
function bearingDeg(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]))
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]))
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}
const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const LEVEL_VAR = { ok: 'var(--hd-ok)', warn: 'var(--hd-warn)', bad: 'var(--hd-bad)', idle: 'var(--hd-dim)' }
const dayStart = (offsetDays = 0) => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays) // calendar days, correct across DST changes
  return d.getTime()
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/* ---------- small building blocks ---------- */
function Spark({ data, color }) {
  const gid = useId().replace(/:/g, '')
  const w = 200
  const h = 46
  if (data.length < 2) {
    return (
      <svg className="hd-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="var(--hd-line2)" strokeDasharray="3 4" />
      </svg>
    )
  }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const r = max - min || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 4 - ((v - min) / r) * (h - 12)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg className="hd-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="var(--hd-line)" strokeDasharray="3 4" />
      <path d={`${d} L${w} ${h} L0 ${h}Z`} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {/* zero-length round-capped stroke = a dot that stays round when the SVG is stretched */}
      <path d={`M${last[0]} ${last[1]}h0`} stroke={color} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Kpi({ title, value, unit, detail, series, color, level }) {
  return (
    <article className="hd-card hd-kpi s3">
      <span className="hd-stripe" style={{ background: color }} />
      <div className="hd-card-h">
        <span className="hd-t">{title}</span>
        <StatusOrb level={level} size={7} />
      </div>
      <div className="hd-kpi-v">
        <b>{value}</b>
        <span>{unit}</span>
      </div>
      <div className="hd-kpi-d">{detail}</div>
      <Spark data={series} color={color} />
    </article>
  )
}

function Meter({ label, value, pct, color }) {
  const w = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  return (
    <div className="hd-meter">
      <div className="hd-meter-h">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className="hd-track">
        <i style={{ width: `${w}%`, background: color }} />
      </div>
    </div>
  )
}

const ROSE_TICKS = (() => {
  const out = []
  for (let a = 0; a < 360; a += 5) {
    const big = a % 30 === 0
    const r1 = 92 - (big ? 12 : a % 10 === 0 ? 8 : 5)
    const rad = ((a - 90) * Math.PI) / 180
    out.push({ a, big, x1: 100 + Math.cos(rad) * r1, y1: 100 + Math.sin(rad) * r1, x2: 100 + Math.cos(rad) * 88, y2: 100 + Math.sin(rad) * 88 })
  }
  return out
})()

function Compass({ heading, homeBearing }) {
  const hd = Number(heading)
  const has = Number.isFinite(hd)
  const h = has ? ((Math.round(hd) % 360) + 360) % 360 : 0
  return (
    <div className="hd-compass">
      <svg viewBox="0 0 200 200" role="img" aria-label={has ? `Heading ${h} degrees` : 'Heading unknown'}>
        <circle cx="100" cy="100" r="92" fill="var(--hd-panel2)" stroke="var(--hd-line2)" />
        <g transform={`rotate(${-h} 100 100)`} style={{ transition: 'transform .6s ease-out' }}>
          {ROSE_TICKS.map((t) => (
            <line key={t.a} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.big ? 'var(--hd-text)' : 'var(--hd-dim)'} strokeWidth={t.big ? 1.6 : 1} />
          ))}
          {[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([l, a]) => {
            const rad = ((a - 90) * Math.PI) / 180
            const x = 100 + Math.cos(rad) * 64
            const y = 100 + Math.sin(rad) * 64
            return (
              <text key={l} x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill={l === 'N' ? 'var(--hd-bad)' : 'var(--hd-muted)'} transform={`rotate(${a} ${x} ${y})`}>
                {l}
              </text>
            )
          })}
        </g>
        <path d="M100 6 l7 12 h-14z" fill="var(--hd-accent)" />
        {homeBearing != null && (
          <g transform={`rotate(${homeBearing - h} 100 100)`}>
            <path d="M100 40 l5 9 h-10z" fill="var(--hd-warn)" />
          </g>
        )}
        <circle cx="100" cy="100" r="44" fill="var(--hd-panel)" stroke="var(--hd-line)" />
        <text x="100" y="100" textAnchor="middle" fontSize="26" fontWeight="700" fill="var(--hd-text)" style={{ fontFamily: 'var(--hd-mono)' }}>
          {has ? `${h}°` : DASH}
        </text>
        <text x="100" y="120" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--hd-muted)" letterSpacing="2">
          {has ? CARDINAL[Math.round(h / 45) % 8] : 'NO HDG'}
        </text>
      </svg>
    </div>
  )
}

// Bars are SVG (stretched to the card width); text is HTML so it never distorts.
function HourChart({ hourly }) {
  const W = 480
  const H = 104
  const top = 16
  const bw = W / 24
  const max = Math.max(1, ...hourly)
  return (
    <div className="hd-hours-wrap">
      <span className="hd-hours-max">{max}/h</span>
      <svg className="hd-hours" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Trash items detected per hour today">
        {[0, 0.5, 1].map((f) => {
          const y = top + (H - top) * (1 - f)
          return <line key={f} x1="0" x2={W} y1={y} y2={y} stroke="var(--hd-line)" vectorEffect="non-scaling-stroke" />
        })}
        {hourly.map((v, i) => {
          const bh = Math.max(v ? 4 : 2, (v / max) * (H - top))
          return (
            <rect
              key={i}
              x={i * bw + 3}
              y={H - bh}
              width={bw - 6}
              height={bh}
              rx="2.5"
              fill={v && v === max ? 'var(--hd-accent)' : v ? 'color-mix(in srgb, var(--hd-accent) 45%, transparent)' : 'var(--hd-line2)'}
            />
          )
        })}
      </svg>
      <div className="hd-hours-axis" aria-hidden="true">
        {[0, 6, 12, 18, 23].map((i) => (
          <span key={i} style={{ left: `${((i + 0.5) / 24) * 100}%` }}>{String(i).padStart(2, '0')}</span>
        ))}
      </div>
    </div>
  )
}

function PositionChip({ live }) {
  const text =
    live.source === 'drone'
      ? 'Drone GPS'
      : live.source === 'laptop'
        ? `Laptop GPS (test)${live.accuracy != null ? ` · ±${Math.round(live.accuracy)} m` : ''}`
        : live.error
          ? `No GPS · ${live.error}`
          : 'Waiting for GPS…'
  const level = live.source === 'drone' ? 'ok' : live.source === 'laptop' ? 'warn' : 'bad'
  return (
    <span className="hd-chip">
      <StatusOrb level={level} size={7} pulse={!live.source} />
      {text}
    </span>
  )
}

/* ---------- the screen ---------- */
export default function MissionControlScreen({ onNavigate }) {
  const { telemetry, health, pi, backendReachable, simulated, armedSince } = useSystem()
  const toast = useToast()
  const ai = usePolling(api.aiStatus, 5000)
  const cam = usePolling(api.cameraStatus, 6000)
  const trash = useTrashLog()

  const t = readT(telemetry.data)
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'
  const aiOn = bool(pick(ai.data, ['ai_enabled', 'enabled', 'live_boxes'])) ?? false
  const live = useLivePosition(telemetry.data)
  const center = live.position
  const homePoint = useHomePoint(telemetry.data, live, simulated)
  const activeMission = missionFor(useActiveMission(), simulated ? 'sim' : 'real')

  const battSeries = useRolling(t.volt)
  const altSeries = useRolling(t.alt)
  const spdSeries = useRolling(t.speed != null && t.speed !== '' ? Number(t.speed) * 3.6 : null)
  const satSeries = useRolling(t.sats)

  /* ----- battery ----- */
  const voltN = Number(t.volt)
  const hasVolt = t.volt != null && t.volt !== '' && Number.isFinite(voltN)
  // MAVLink battery_remaining is -1 when the autopilot doesn't know.
  const battFrac = t.batt != null && t.batt !== '' && Number.isFinite(Number(t.batt)) && Number(t.batt) >= 0
    ? Number(t.batt) / 100
    : hasVolt
      ? (voltN - 10.5) / (12.6 - 10.5) // 3S pack: 10.5 V empty … 12.6 V full
      : null
  const battPct = battFrac == null ? null : Math.round(Math.max(0, Math.min(1, battFrac)) * 100)
  const battLevel = !hasVolt ? (battPct == null ? 'idle' : battPct > 40 ? 'ok' : battPct > 20 ? 'warn' : 'bad') : voltN >= 11.1 ? 'ok' : voltN >= 10.5 ? 'warn' : 'bad'
  const battWord = { ok: 'Healthy', warn: 'Low — plan to land', bad: 'Critical — land now', idle: 'No reading' }[battLevel]
  const battDelta = battSeries.length > 1 ? battSeries.at(-1) - battSeries[0] : null

  /* ----- navigation ----- */
  const homeDist = center && homePoint ? distanceM(center, homePoint) : null
  const homeBrg = center && homePoint && homeDist > 1 ? bearingDeg(center, homePoint) : null
  const satsN = Number(t.sats)
  const gpsLevel = !live.droneFix ? 'bad' : satsN >= 6 ? 'ok' : satsN >= 4 ? 'warn' : 'bad'
  const fixText = Number(t.fix) >= 3 ? '3D fix' : Number(t.fix) === 2 ? '2D fix' : live.droneFix ? 'fix' : 'no drone fix'

  /* ----- flight status line ----- */
  const offline = !connected && !simulated
  const running = activeMission?.status === 'running'
  const statusLine = offline
    ? 'is offline'
    : t.armed === undefined
      ? 'is connected, arm state unknown'
      : t.armed
      ? running
        ? `is flying ${activeMission.name || 'the uploaded mission'}`
        : `is airborne in ${t.mode || 'flight'}`
      : 'is on standby'
  const pill = offline ? 'OFFLINE' : t.armed === undefined ? 'UNKNOWN' : t.armed ? 'IN FLIGHT' : 'STANDBY'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  /* ----- mission ----- */
  // Same estimate the mission planner uses: home → waypoints → back home, plus climb/descent.
  const mission = useMemo(() => {
    const wps = (activeMission?.waypoints || []).map((w) => [w.lat, w.lng])
    const est = estimateFlight(homePoint, wps, { altitude: Number(activeMission?.altitude) || 10, speedKmh: Number(activeMission?.speedKmh) || 5 })
    return { count: wps.length, distKm: est.lengthM / 1000, minutes: Math.max(1, Math.round(est.minutes)) }
  }, [activeMission, homePoint])
  const wpNow = Number(t.wpCurrent)
  const wpIdx = running && Number.isFinite(wpNow) ? Math.max(1, Math.min(mission.count, wpNow)) : null

  /* ----- detections (today, from the trash log) ----- */
  // Recomputed in render (the screen re-renders on every telemetry update) so
  // the day boundary rolls over at midnight even with no new detections.
  const today = dayStart(0)
  const det = useMemo(() => {
    const yesterday = dayStart(-1)
    const hourly = new Array(24).fill(0)
    let items = 0
    let prev = 0
    let confSum = 0
    let confN = 0
    let located = 0
    let photos = 0
    let entries = 0
    for (const e of trash) {
      const ts = Number(e.firstSeen) || 0
      const n = Number(e.count) || 0
      if (ts >= today) {
        entries++
        items += n
        hourly[new Date(ts).getHours()] += n
        if (Number.isFinite(e.confidence)) {
          confSum += e.confidence
          confN++
        }
        if (e.located) located++
        if (e.hasPhoto || e.photo) photos++
      } else if (ts >= yesterday) prev += n
    }
    const peak = hourly.indexOf(Math.max(...hourly))
    return {
      hourly,
      items,
      delta: items - prev,
      peak: items ? peak : null,
      avgConf: confN ? Math.round((confSum / confN) * 100) : null,
      gpsPct: entries ? Math.round((located / entries) * 100) : null,
      photos,
    }
  }, [trash, today])

  /* ----- hotspots ----- */
  const hotspots = useMemo(() => clusterHotspots(trash).slice(0, 3), [trash])
  function planHotspotMission() {
    const plan = buildHotspotPlan(trash, { home: homePoint || center })
    if (!plan.ok) {
      toast.push({ level: 'warn', title: plan.reason })
      return
    }
    setPlanDraft({
      name: `Hotspots (${plan.waypoints.length})`,
      waypoints: plan.waypoints,
      altitude: plan.altitude,
      speedKmh: plan.speedKmh,
      pattern: 'hotspot',
      lakeName: `${plan.waypoints.length} hotspots`,
      polygon: null,
      summary: `Hotspot route · ${plan.waypoints.length} stops · ${(plan.lengthM / 1000).toFixed(1)} km · ~${plan.minutes} min`,
      warnings: plan.warnings,
    })
    onNavigate('mission')
  }

  /* ----- health + diagnostics ----- */
  const p = pi.data || {}
  const temp = Number(pick(p, ['temperature', 'temp', 'cpu_temp']))
  const ram = Number(pick(p, ['ram_percent', 'memory_percent', 'ram', 'mem']))
  const disk = Number(pick(p, ['disk_percent', 'disk']))
  const th = p.throttledState || p.throttled_state
  const underVolt = !!(th && (th.under_voltage || th.undervoltage))
  const camFps = Number(pick(cam.data, ['measured_fps']))
  const camTarget = Number(pick(cam.data, ['target_fps'])) || 30
  const camLoad = Number.isFinite(camFps) ? Math.min(100, (camFps / camTarget) * 100) : null
  const aiConf = Number(pick(ai.data, ['confidence_threshold']))
  const camOk = bool(pick(cam.data, ['camera_connected'])) ?? bool(pick(health.data, ['camera_connected', 'camera']))
  const pixhawkOk = bool(pick(health.data, ['pixhawk_connected', 'pixhawk']))
  const aiModel = bool(pick(ai.data, ['model_loaded', 'ai_enabled']))
  const gpsOk = live.droneFix ? (satsN >= 6 ? true : undefined) : false
  const piLevel = underVolt ? 'bad' : Number.isFinite(temp) ? (temp >= 80 ? 'warn' : 'ok') : 'idle'
  const lvl = (ok) => (ok === true ? 'ok' : ok === false ? 'bad' : 'idle')
  const healthItems = [
    { k: 'Pixhawk', level: lvl(pixhawkOk), note: pixhawkOk ? 'connected' : pixhawkOk === false ? 'offline' : 'unknown' },
    { k: 'GPS', level: lvl(gpsOk), note: live.droneFix ? `${num(t.sats, 0)} sats` : 'no drone fix' },
    { k: 'Camera', level: lvl(camOk), note: Number.isFinite(camFps) ? `${num(camFps, 0)} fps` : camOk ? 'connected' : camOk === false ? 'offline' : 'unknown' },
    { k: 'AI model', level: lvl(aiModel), note: aiOn ? 'detecting' : aiModel ? 'loaded' : aiModel === false ? 'not loaded' : 'unknown' },
    { k: 'Backend', level: simulated ? 'warn' : lvl(backendReachable), note: simulated ? 'simulator' : backendReachable ? 'reachable' : backendReachable === false ? 'unreachable' : 'checking' },
    { k: 'Pi power', level: piLevel, note: underVolt ? 'undervoltage' : Number.isFinite(temp) ? `${num(temp, 0)} °C` : 'no data' },
  ]
  const healthOk = healthItems.filter((h) => h.level === 'ok').length
  const link = telemetry.status === 'live' ? { pct: 100, word: 'Live', bars: 4 } : telemetry.status === 'polling' ? { pct: 60, word: 'Polling', bars: 2 } : { pct: 0, word: 'Lost', bars: 0 }

  return (
    <motion.div
      initial={{ rotateX: 16, rotateY: -12, scale: 0.92, opacity: 0 }}
      animate={{ rotateX: 0, rotateY: 0, scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 90, damping: 18, mass: 0.9 }}
      style={{ transformPerspective: 1400 }}
    >
      <div className="hd">
        {/* ===== Header ===== */}
        <section className="hd-head">
          <div>
            <div className="hd-eyebrow">{dateLine} · Mission control</div>
            <h1 className="hd-h1">
              {greeting}. <em>VARUNA-01</em> {statusLine}.
            </h1>
            <div className="hd-chips">
              <PositionChip live={live} />
              <span className="hd-chip">
                <StatusOrb level={lvl(pixhawkOk)} size={7} />
                {pixhawkOk ? 'Pixhawk linked' : pixhawkOk === false ? 'Pixhawk offline' : 'Pixhawk unknown'}
              </span>
              <span className="hd-chip">
                <StatusOrb level={aiOn ? 'ok' : 'idle'} size={7} pulse={aiOn} />
                {aiOn ? 'AI detection running' : 'AI detection off'}
              </span>
              {simulated && <span className="hd-chip sim">SIMULATED</span>}
              <StaleBadge lastUpdate={telemetry.lastUpdate} connected={connected} />
            </div>
          </div>
          <ThemeToggle />
        </section>

        <section className="hd-grid">
          {/* ===== Aircraft ===== */}
          <article className="hd-card hd-hero s8">
            <div className="hd-hero-top">
              <div>
                <div className="hd-t">Aircraft</div>
                <div className="hd-name">VARUNA-01</div>
                <div className="hd-sub">River-cleanup quadcopter · Pixhawk + Raspberry Pi</div>
              </div>
              <span className={`hd-pill ${offline ? 'off' : ''}`}>{pill}</span>
            </div>
            <div className="hd-hero-body">
              <div className="hd-stage">
                <Suspense fallback={null}>
                  <HomeDrone3D battery={battPct == null ? null : battPct / 100} />
                </Suspense>
                <span className="hd-stage-tag mono">Drag to rotate</span>
              </div>
              <div className="hd-stats">
                <div className="hd-ring-row">
                  <div className="hd-ring">
                    <svg viewBox="0 0 80 80" aria-hidden="true">
                      <circle cx="40" cy="40" r="34" fill="none" stroke="var(--hd-panel2)" strokeWidth="8" />
                      <circle
                        cx="40"
                        cy="40"
                        r="34"
                        fill="none"
                        stroke={LEVEL_VAR[battLevel]}
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray="213.6"
                        strokeDashoffset={(213.6 * (1 - (battPct ?? 0) / 100)).toFixed(1)}
                        style={{ transition: 'stroke-dashoffset .8s' }}
                      />
                    </svg>
                    <b>{battPct == null ? DASH : `${battPct}%`}</b>
                  </div>
                  <div>
                    <div className="hd-t">Battery</div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{hasVolt ? `${num(voltN, 1)} V` : DASH}</div>
                    <div style={{ color: LEVEL_VAR[battLevel], fontSize: 11.5, fontWeight: 600 }}>{battWord}</div>
                  </div>
                </div>
                <div>
                  <div className="hd-kv"><span>Flight mode</span><span>{t.mode || DASH}</span></div>
                  <div className="hd-kv">
                    <span>Link</span>
                    <span>
                      <span className="hd-bars4" aria-hidden="true">
                        {[4, 7, 10, 12].map((h, i) => <i key={h} className={i < link.bars ? 'on' : ''} style={{ height: h }} />)}
                      </span>
                      {link.word}
                    </span>
                  </div>
                  <div className="hd-kv"><span>Armed</span><span>{t.armed === undefined ? DASH : t.armed ? 'Yes' : 'No'}</span></div>
                  <div className="hd-kv"><span>Altitude</span><span>{num(t.alt, 1)} m</span></div>
                </div>
              </div>
            </div>
          </article>

          {/* ===== Navigation ===== */}
          <article className="hd-card hd-nav s4">
            <div className="hd-card-h">
              <span className="hd-t">Navigation</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--hd-muted)' }}>
                {center ? `${center[0].toFixed(5)}, ${center[1].toFixed(5)}` : 'No position'}
              </span>
            </div>
            <div className="hd-nav-in">
              <Compass heading={t.heading} homeBearing={homeBrg} />
              <div className="hd-tiles2">
                <div><small>Home distance</small><b>{homeDist == null ? DASH : homeDist >= 1000 ? `${(homeDist / 1000).toFixed(2)} km` : `${Math.round(homeDist)} m`}</b></div>
                <div><small>Home bearing</small><b>{homeBrg == null ? DASH : `${Math.round(homeBrg)}°`}</b></div>
                <div><small>Vertical speed</small><b>{t.climb == null ? DASH : `${Number(t.climb) > 0 ? '+' : ''}${num(t.climb, 1)} m/s`}</b></div>
                <div><small>Flight time</small><b>{armedSince ? fmtDuration(Date.now() - armedSince) : DASH}</b></div>
              </div>
            </div>
          </article>

          {/* ===== KPI tiles ===== */}
          <Kpi
            title="Battery"
            value={hasVolt ? num(voltN, 1) : DASH}
            unit="V"
            level={battLevel}
            color={LEVEL_VAR[battLevel === 'idle' ? 'ok' : battLevel]}
            series={battSeries}
            detail={battDelta == null ? 'waiting for readings' : <><span className={`hd-delta ${battDelta < 0 ? 'hd-down' : 'hd-up'}`}>{battDelta > 0 ? '+' : ''}{battDelta.toFixed(2)}</span>recent trend</>}
          />
          <Kpi
            title="Altitude"
            value={num(t.alt, 1)}
            unit="m"
            level={t.alt == null ? 'idle' : 'ok'}
            color="var(--hd-accent)"
            series={altSeries}
            detail={activeMission?.altitude ? `mission height ${num(activeMission.altitude, 0)} m` : 'relative to home'}
          />
          <Kpi
            title="Ground speed"
            value={t.speed == null || t.speed === '' ? DASH : num(Number(t.speed) * 3.6, 1)}
            unit="km/h"
            level={t.speed == null ? 'idle' : 'ok'}
            color="var(--hd-info)"
            series={spdSeries}
            detail={activeMission?.speedKmh ? `mission speed ${num(activeMission.speedKmh, 0)} km/h` : 'cap 15 km/h'}
          />
          <Kpi
            title="GPS satellites"
            value={num(t.sats, 0)}
            unit={`sats · ${fixText}`}
            level={gpsLevel}
            color={LEVEL_VAR[gpsLevel]}
            series={satSeries}
            detail={t.hdop != null ? `HDOP ${num(t.hdop, 1)}` : satsN >= 6 ? 'good for missions' : 'need 6+ to fly missions'}
          />

          {/* ===== Mission ===== */}
          <article className="hd-card hd-mis s4">
            <div className="hd-card-h">
              <span className="hd-t">Active mission</span>
              <button className="hd-link" onClick={() => onNavigate('mission')}>Missions →</button>
            </div>
            {activeMission ? (
              <>
                <div>
                  <div className="hd-mname">{activeMission.name || 'Uploaded mission'}</div>
                  <div className="hd-msub">
                    {mission.count} waypoints · {num(activeMission.altitude, 0)} m · {num(activeMission.speedKmh, 0)} km/h
                  </div>
                </div>
                <div className="hd-pipe">
                  <span className="ok">✓ Saved</span>
                  <span className="ok">✓ Uploaded</span>
                  <span className={running ? 'now' : ''}>{running ? 'Flying' : 'Ready to start'}</span>
                </div>
                {mission.count > 0 && mission.count <= 60 && (
                  <div>
                    {wpIdx != null && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 6 }}>
                        <span style={{ color: 'var(--hd-muted)' }}>Waypoint <b className="mono" style={{ color: 'var(--hd-text)' }}>{wpIdx}</b> of {mission.count}</span>
                        <b className="mono">{Math.round(((wpIdx - 1) / Math.max(1, mission.count - 1)) * 100)}%</b>
                      </div>
                    )}
                    <div className="hd-wps" aria-hidden="true">
                      {Array.from({ length: mission.count }, (_, i) => (
                        <i key={i} className={wpIdx == null ? '' : i + 1 < wpIdx ? 'done' : i + 1 === wpIdx ? 'cur' : ''} />
                      ))}
                    </div>
                  </div>
                )}
                <div className="hd-tiles3">
                  <div><small>Round trip</small><b>{mission.distKm.toFixed(1)} km</b></div>
                  <div><small>Est. time</small><b>{mission.minutes} min</b></div>
                  <div><small>Aircraft</small><b>{activeMission.target === 'sim' ? 'Sim' : 'Real'}</b></div>
                </div>
              </>
            ) : (
              <div className="hd-empty">No mission uploaded yet. Plan one on the Missions tab, then Save → Upload.</div>
            )}
          </article>

          {/* ===== Detections today ===== */}
          <article className="hd-card hd-detc s5">
            <div className="hd-card-h">
              <span className="hd-t">Trash detected today</span>
              <button className="hd-link" onClick={() => onNavigate('detections')}>Detections →</button>
            </div>
            <div className="hd-det-top">
              <div className="hd-det-big">
                {det.items}
                <small>items</small>
              </div>
              <div style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--hd-muted)' }}>
                <span className={`hd-delta ${det.delta >= 0 ? 'hd-up' : 'hd-down'}`}>{det.delta > 0 ? '+' : ''}{det.delta}</span> vs yesterday
                <br />
                <span className="mono">{det.peak == null ? 'no detections yet' : `peak ${String(det.peak).padStart(2, '0')}:00–${String((det.peak + 1) % 24).padStart(2, '0')}:00`}</span>
              </div>
            </div>
            <HourChart hourly={det.hourly} />
            <div className="hd-foot3">
              <div><small>Avg confidence</small><b>{det.avgConf == null ? DASH : `${det.avgConf}%`}</b></div>
              <div><small>With GPS</small><b>{det.gpsPct == null ? DASH : `${det.gpsPct}%`}</b></div>
              <div><small>Photos saved</small><b>{det.photos}</b></div>
            </div>
          </article>

          {/* ===== Platform health ===== */}
          <article className="hd-card hd-hl s3">
            <div className="hd-card-h">
              <span className="hd-t">Platform health</span>
              <span className="mono" style={{ fontSize: 10.5, color: healthOk === healthItems.length ? 'var(--hd-ok)' : 'var(--hd-warn)' }}>
                {healthOk}/{healthItems.length} OK
              </span>
            </div>
            <div className="hd-health">
              {healthItems.map((h) => (
                <div key={h.k}>
                  <StatusOrb level={h.level} size={8} pulse={h.level === 'bad'} />
                  <span style={{ minWidth: 0 }}>
                    <b>{h.k}</b>
                    <small>{h.note}</small>
                  </span>
                </div>
              ))}
            </div>
          </article>

          {/* ===== Hotspots ===== */}
          <article className="hd-card s6">
            <div className="hd-card-h">
              <span className="hd-t">Worst hotspots</span>
              <button className="hd-link" onClick={planHotspotMission} disabled={!hotspots.length}>Plan hotspot mission →</button>
            </div>
            {hotspots.length ? (
              <div className="hd-hot">
                {hotspots.map((h, i) => {
                  const tone = [['rgba(239,68,68,.15)', '#EF4444'], ['rgba(249,115,22,.15)', '#F97316'], ['rgba(250,204,21,.15)', '#CA8A04']][i]
                  return (
                    <div key={h.id} className="hd-hot-row">
                      <span className="hd-rank" style={{ background: tone[0], color: tone[1] }}>{i + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <b>{h.itemsTotal} item{h.itemsTotal === 1 ? '' : 's'} · seen {relTime(h.lastSeen)}</b>
                        <small>{h.lat.toFixed(5)}, {h.lng.toFixed(5)}</small>
                        <div className="hd-heatbar"><i style={{ width: `${Math.round((h.weight / hotspots[0].weight) * 100)}%` }} /></div>
                      </div>
                      <a className="hd-link" href={mapsLink(h.lat, h.lng)} target="_blank" rel="noopener noreferrer">Map ↗</a>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="hd-empty">No trash locations recorded yet. Run detection with a GPS fix to build hotspots.</div>
            )}
          </article>

          {/* ===== Diagnostics ===== */}
          <article className="hd-card s6">
            <div className="hd-card-h">
              <span className="hd-t">Diagnostics</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--hd-muted)' }}>Raspberry Pi</span>
            </div>
            <div className="hd-meters">
              <Meter label="Camera throughput" value={camLoad == null ? DASH : `${Math.round(camLoad)}%`} pct={camLoad} color="var(--hd-ok)" />
              <Meter label="CPU temperature" value={Number.isFinite(temp) ? `${num(temp, 0)} °C` : DASH} pct={Number.isFinite(temp) ? (temp / 85) * 100 : null} color={temp >= 80 ? 'var(--hd-bad)' : temp >= 65 ? 'var(--hd-warn)' : 'var(--hd-ok)'} />
              <Meter label="AI confidence gate" value={Number.isFinite(aiConf) ? `${Math.round(aiConf * 100)}%` : DASH} pct={Number.isFinite(aiConf) ? aiConf * 100 : null} color="var(--hd-accent)" />
              <Meter label="Memory" value={Number.isFinite(ram) ? `${num(ram, 0)}%` : DASH} pct={ram} color={ram > 90 ? 'var(--hd-bad)' : ram > 75 ? 'var(--hd-warn)' : 'var(--hd-info)'} />
              <Meter label="Comms link" value={link.word} pct={link.pct} color={link.pct ? 'var(--hd-ok)' : 'var(--hd-bad)'} />
              <Meter label="Storage" value={Number.isFinite(disk) ? `${num(disk, 0)}%` : DASH} pct={disk} color={disk > 90 ? 'var(--hd-bad)' : 'var(--hd-info)'} />
            </div>
          </article>
        </section>
      </div>
    </motion.div>
  )
}
