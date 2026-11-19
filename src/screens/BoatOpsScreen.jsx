import { useEffect, useRef, useState } from 'react'
import { MapContainer, Marker, Polyline, CircleMarker, Circle, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import CachedTileLayer from '../components/CachedTileLayer'
import { SAT_URL } from '../components/MapCanvas'
import { boatIcon } from '../components/BoatParts'
import { useBoat } from '../components/BoatContext'
import { useBoatVision } from '../components/BoatVisionContext'
import { useToast } from '../components/Toast'
import { boatApi, boatUrls } from '../api/boatClient'
import { isOk } from '../lib/commands'
import { getLatestFrame, subscribeVision, setMatchTarget } from '../lib/boatVision'
import { latestDroneCrop, clearLatestDroneCrop } from '../lib/droneTargets'
import { useOpsStatus, fmt8, fmtM, clock } from '../lib/opsStatus'

// The Boat tab: one simple screen for drone -> boat waste collection.
// Big status line, the live boat camera with the waste-matching boxes, the
// "is it the same waste?" check, live messages, and three big buttons.
// Everything else (map, waste list, scoop, Pixhawk) sits under "More details".
// Data: boat-pi/boat_extras.py -> /api/ops/status (polled every second).

const GREEN = '#32D74B'
const RED = '#FF453A'
const AMBER = '#FF9F0A'
const BLUE = '#3B9EFF'
const GREY = '#98A0AB'
const YELLOW = '#FFD60A'
const PANEL = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)' }
const SCOOPING = new Set(['checking', 'waiting', 'to_extreme', 'holding', 'to_zero'])
const STATE_COLOR = {
  DETECTED: AMBER, SENT: AMBER, NAVIGATING: BLUE, SEARCHING: BLUE, MATCHED: GREEN, APPROACHING: GREEN,
  COLLECTING: GREEN, VERIFYING: GREEN, COLLECTED: GREEN, NOT_FOUND: RED, RETRY_REQUIRED: RED, SKIPPED: GREY,
}
const STATE_WORD = {
  DETECTED: 'Found by drone', SENT: 'Found by drone', NAVIGATING: 'Boat going there', SEARCHING: 'Camera searching',
  MATCHED: 'Matched', APPROACHING: 'Matched', COLLECTING: 'Collecting', VERIFYING: 'Collecting', COLLECTED: 'Collected',
  NOT_FOUND: 'Not found', RETRY_REQUIRED: 'Not found', SKIPPED: 'Skipped',
}
const n1 = (v, d = 1) => (Number.isFinite(v) ? Number(v).toFixed(d) : '—')
const pctOf = (v) => (Number.isFinite(v) ? Math.round(v * 100) : null)

function Card({ title, right, children, className = '', style }) {
  return (
    <div className={`rounded-2xl p-3 ${className}`} style={{ ...PANEL, ...style }}>
      {title && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12px] font-extrabold uppercase tracking-wider text-muted">{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

function Row({ k, v, color }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[13px]">
      <span className="text-muted">{k}</span>
      <span className="text-right font-mono font-semibold tnum" style={{ color: color || undefined }}>{v ?? '—'}</span>
    </div>
  )
}

function useRun() {
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  async function run(key, fn, okMsg) {
    setBusy(key)
    try {
      const res = await fn()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || (res?._httpError ? `HTTP ${res._httpError}` : 'Failed') }, okMsg)
      return res
    } catch (e) {
      toast.push({ level: 'bad', title: String(e?.message || e) })
      return null
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

// The best "same waste" score on the boat camera right now (this app's matcher
// vs the drone's picture), or null. Re-renders only when the % changes.
// The drone's newest plastic picture straight from this app (no GPS, no boat
// round trip needed), checked once a second.
function useLocalDroneCrop() {
  const [v, setV] = useState(latestDroneCrop)
  useEffect(() => {
    const iv = setInterval(() => setV((p) => {
      const n = latestDroneCrop()
      return n?.id === p?.id && n?.crop === p?.crop ? p : n
    }), 1000)
    return () => clearInterval(iv)
  }, [])
  return v
}

function useBestMatch(target, local, thr) {
  const [best, setBest] = useState(null)
  const [matched, setMatched] = useState(false)
  const run = useRef({ up: 0, down: 0 })
  const id = target?.has_reference ? target.id : local?.id || null
  const cls = (target?.has_reference ? target.object_class : local?.cls) || null
  useEffect(() => { setMatchTarget(id ? { id, cls } : null) }, [id, cls])
  useEffect(() => () => setMatchTarget(null), [])
  const thrRef = useRef(thr)
  thrRef.current = thr
  useEffect(() => { run.current = { up: 0, down: 0, last: null }; setMatched(false) }, [id])
  useEffect(() => subscribeVision((s) => {
    const list = s?.targets || []
    if (list === run.current.last) return // same AI pass (another field changed)
    run.current.last = list
    const m = list.reduce((a, b) => (Number.isFinite(b.match) && b.match > (a ?? -1) ? b.match : a), null)
    const r = m == null ? null : Math.round(m * 100) / 100
    setBest((p) => (p === r ? p : r))
    // Hysteresis: MATCHED after 2 passes at/above the threshold, cleared only
    // after 3 passes clearly below it — no blinking right at the line.
    const t = thrRef.current, c = run.current
    if (r != null && r >= t) { c.up++; c.down = 0 } else if (r == null || r < t - 0.05) { c.down++; c.up = 0 }
    if (c.up >= 2) setMatched(true)
    else if (c.down >= 3) setMatched(false)
  }), [])
  return { best, matched }
}

// ------------------------------------------------------------------ 1. what is happening now
function heroOf(ops, matched) {
  const live = ops.live?.state
  const cyc = ops.auto?.cycle?.state
  const kind = ops.banner?.kind
  if (SCOOPING.has(cyc)) return { c: GREEN, title: 'COLLECTING THE WASTE', sub: 'The scoop is moving' }
  if (kind === 'matched' || matched) return { c: GREEN, title: 'WASTE MATCHED', sub: 'Boat heading towards it' }
  if (kind === 'moving') return { c: RED, title: 'WASTE DETECTED', sub: 'Boat moving towards it' }
  if (kind === 'idle') return { c: AMBER, title: 'WASTE DETECTED', sub: 'Boat is stopped — press START to go and collect it' }
  if (live === 'running' || live === 'returning') return { c: BLUE, title: 'LOOKING FOR WASTE', sub: 'Waiting for the drone to find plastic' }
  return { c: GREY, title: 'BOAT STOPPED', sub: 'Press START to begin collecting' }
}

function Hero({ ops, matched }) {
  const h = heroOf(ops, matched)
  const t = ops.target
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl px-5 py-4" style={{ background: `${h.c}1c`, border: `3px solid ${h.c}` }}>
      <div className="min-w-0 flex-1">
        <div className="text-[30px] font-black leading-none tracking-wide md:text-[38px]" style={{ color: h.c }}>{h.title}</div>
        <div className="mt-1 text-[16px] font-bold text-ink md:text-[19px]">{h.sub}</div>
      </div>
      {t && Number.isFinite(t.distance_m) && (
        <div className="text-right">
          <div className="text-[12px] font-bold uppercase tracking-wider text-muted">Distance to waste</div>
          <div className="font-mono text-[40px] font-black leading-none tnum" style={{ color: YELLOW }}>{fmtM(t.distance_m)}</div>
        </div>
      )}
    </div>
  )
}

function Alerts({ alerts }) {
  if (!alerts?.length) return null
  return (
    <div className="grid gap-1.5">
      {alerts.map((a) => (
        <div key={a} className="rounded-xl px-4 py-2.5 text-[15px] font-extrabold" style={{ background: `${RED}24`, border: `2px solid ${RED}`, color: RED }}>⚠ {a}</div>
      ))}
    </div>
  )
}

// A plain MJPEG <img> that reconnects by itself. An <img> stream that drops
// (a brief network blip, the backend restarting) stays a broken image forever,
// so on error we reload it with a fresh cache-busting URL until it comes back.
function MjpegImg({ className, onState }) {
  const [attempt, setAttempt] = useState(0)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const base = boatUrls.video()
  const src = `${base}${base.includes('?') ? '&' : '?'}t=${attempt}`
  return (
    <img
      key={attempt}
      src={src}
      alt="Boat camera"
      className={className}
      onLoad={() => onState?.(true)}
      onError={() => {
        onState?.(false)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setAttempt((n) => n + 1), 1500)
      }}
    />
  )
}

// ------------------------------------------------------------------ 2. live camera with matching boxes
function LiveCamera({ ops }) {
  const bv = useBoatVision()
  const canvas = useRef(null)
  const engRef = useRef(null)
  const thrRef = useRef(0.55)
  thrRef.current = ops.auto?.match_threshold ?? 0.55
  const [boxes, setBoxes] = useState(0)
  const [hasFrame, setHasFrame] = useState(false)
  useEffect(() => subscribeVision((s) => {
    engRef.current = s
    setBoxes(s?.targets?.length || 0)
  }), [])
  useEffect(() => {
    let stopped = false
    let raf = 0
    let shown = false
    let lastBmp = null
    let lastTargets = null
    const draw = () => {
      if (stopped) return
      const bmp = getLatestFrame()
      const targets = engRef.current?.targets || null
      const c = canvas.current
      // Redraw at the display's refresh rate, but only when the frame or the
      // boxes actually changed — so a true 60 fps stream shows at 60 fps without
      // burning cycles repainting an identical frame.
      if (bmp && c && (bmp !== lastBmp || targets !== lastTargets)) {
        lastBmp = bmp
        lastTargets = targets
        if (c.width !== bmp.width) { c.width = bmp.width; c.height = bmp.height }
        const g = c.getContext('2d')
        g.drawImage(bmp, 0, 0)
        const fs = Math.max(16, bmp.width / 26)
        for (const b of targets || []) {
          const hasMatch = Number.isFinite(b.match)
          const same = hasMatch && b.match >= thrRef.current
          const col = !hasMatch ? BLUE : same ? GREEN : AMBER
          const text = !hasMatch ? `plastic ${pctOf(b.score)}%` : same ? `✓ SAME WASTE ${pctOf(b.match)}%` : `not a match ${pctOf(b.match)}%`
          g.lineWidth = Math.max(3, bmp.width / 160)
          g.strokeStyle = col
          g.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1)
          g.font = `800 ${fs}px sans-serif`
          const w = g.measureText(text).width + 12
          const y = Math.max(fs + 6, b.y1 - 4)
          g.fillStyle = col
          g.fillRect(b.x1, y - fs - 4, w, fs + 8)
          g.fillStyle = '#000'
          g.fillText(text, b.x1 + 6, y - 2)
        }
        if (!shown) { shown = true; setHasFrame(true) }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { stopped = true; cancelAnimationFrame(raf) }
  }, [])
  const [streamOk, setStreamOk] = useState(false)
  const camOk = ops.camera?.connected
  return (
    <div className="relative aspect-video max-h-[62vh] overflow-hidden rounded-2xl bg-black" style={PANEL}>
      <canvas ref={canvas} className={`absolute inset-0 h-full w-full object-contain ${hasFrame ? '' : 'hidden'}`} />
      {/* Only open the fallback <img> stream when Vision AI is off or errored, so we never run two simultaneous video connections over Wi-Fi. */}
      {!hasFrame && (!bv?.enabled || bv?.engine?.status === 'error') && <MjpegImg className={`absolute inset-0 h-full w-full object-contain ${streamOk ? '' : 'opacity-0'}`} onState={setStreamOk} />}
      {!hasFrame && !streamOk && (
        <div className="absolute inset-0 flex items-center justify-center text-center text-[16px] font-bold" style={{ color: camOk ? AMBER : RED }}>
          {camOk ? 'Connecting to the camera…' : 'Waiting for the boat camera…'}
        </div>
      )}
      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] font-extrabold" style={{ background: 'rgba(0,0,0,0.65)' }}>
        <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full" style={{ background: camOk ? RED : GREY }} />
        <span className="text-white">LIVE</span>
        {camOk && <span className="font-mono text-[12px] text-white/70">{n1(ops.camera.fps, 0)} fps</span>}
      </div>
      <div className="absolute right-3 top-3 rounded-lg px-2.5 py-1 text-[13px] font-bold" style={{ background: 'rgba(0,0,0,0.65)', color: hasFrame ? GREEN : AMBER }}>
        {hasFrame ? `Matching ON · ${boxes} plastic seen` : bv?.enabled ? 'Matching starting…' : 'Matching is OFF'}
      </div>
      {!hasFrame && camOk && bv && !bv.enabled && (
        <button type="button" onClick={() => bv.setEnabled(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl px-5 py-3 text-[16px] font-black"
          style={{ background: GREEN, color: '#000' }}>Turn on waste matching</button>
      )}
      <div className="absolute bottom-3 left-3 hidden gap-3 rounded-lg px-2.5 py-1 text-[11.5px] font-bold md:flex" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <span style={{ color: GREEN }}>■ same waste</span><span style={{ color: AMBER }}>■ not a match</span><span style={{ color: BLUE }}>■ plastic</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 3. is it the same waste?
function MatchCard({ ops, target, best, local, onReset }) {
  const t = target
  const thr = ops.auto?.match_threshold ?? 0.55
  const score = Number.isFinite(best) ? best : t?.match_score
  const st = t?.state
  const refSrc = t?.has_reference ? boatUrls.liveReference(t.id) : local?.crop || null
  let verdict
  if (!t && !local) verdict = ['No waste to match yet', GREY]
  else if (!ops.camera?.connected) verdict = ['Camera off — cannot match', RED]
  else if (Number.isFinite(score)) verdict = score >= thr ? ['YES — SAME WASTE', GREEN] : ['NOT SURE YET', AMBER]
  else if (st === 'SEARCHING' || !t) verdict = ['Show it to the boat camera…', BLUE]
  else verdict = ['Boat going to the spot — matching starts when close', GREY]
  return (
    <Card title="Is it the same waste?" right={(refSrc || t) && (
      <button type="button" onClick={onReset} title="Remove the drone picture and reset the matching"
        className="rounded-lg px-2.5 py-1 text-[11.5px] font-extrabold"
        style={{ background: `${RED}22`, color: RED, border: `1px solid ${RED}77` }}>✕ Reset</button>
    )}>
      <div className="flex gap-3">
        <div className="w-[42%] shrink-0">
          <div className="mb-1 text-[11px] font-bold text-muted">Drone saw this</div>
          {refSrc
            ? <img src={refSrc} alt="Drone picture" className="aspect-square w-full rounded-xl bg-black object-contain" />
            : <div className="flex aspect-square w-full items-center justify-center rounded-xl text-center text-[11px] text-muted" style={PANEL}>{t ? 'no drone picture' : 'waiting for drone'}</div>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="text-[19px] font-black leading-tight" style={{ color: verdict[1] }}>{verdict[0]}</div>
          <div className="mt-2 font-mono text-[44px] font-black leading-none tnum" style={{ color: Number.isFinite(score) ? verdict[1] : GREY }}>
            {Number.isFinite(score) ? `${pctOf(score)}%` : '—'}
          </div>
          <div className="relative mt-2 h-3 rounded-full bg-black/40">
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Number.isFinite(score) ? Math.min(100, score * 100) : 0}%`, background: verdict[1] }} />
            <div className="absolute -top-1 h-5 w-[3px] rounded bg-white" style={{ left: `${thr * 100}%` }} title="needed" />
          </div>
          <div className="mt-1 text-[11px] text-muted">needs {pctOf(thr)}% (white line)</div>
        </div>
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ 4. live messages
function iconOf(text, level) {
  const s = text.toLowerCase()
  if (level === 'warn' || /lost|fail|abort|error|unavailable|not found/.test(s)) return ['⚠', AMBER]
  if (/collected|complete/.test(s)) return ['✅', GREEN]
  if (/match/.test(s)) return ['🎯', GREEN]
  if (/scoop|servo|collect/.test(s)) return ['🪣', GREEN]
  if (/drone|detected|target/.test(s)) return ['🛰', AMBER]
  if (/navigat|moving|boat|start|stop|hold/.test(s)) return ['🚤', BLUE]
  return ['•', GREY]
}

function Messages({ events }) {
  const list = [...(events || [])].reverse().slice(0, 80)
  return (
    <Card title="Live messages" right={<span className="text-[11px] text-muted">newest on top</span>} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-[200px] flex-1 overflow-y-auto pr-1" style={{ maxHeight: '46vh' }}>
        {list.length ? list.map((e, i) => {
          const [ic, c] = iconOf(e.text || '', e.level)
          return (
            <div key={`${e.t}|${e.text}`} className="mb-1 flex gap-2 rounded-lg px-2 py-1.5"
              style={i === 0 ? { background: `${c}1f`, border: `1px solid ${c}66` } : undefined}>
              <span className="w-5 shrink-0 text-center text-[15px]">{ic}</span>
              <div className="min-w-0 flex-1">
                <div className={`${i === 0 ? 'text-[15px] font-bold' : 'text-[13.5px]'} leading-snug text-ink`}>{e.text}</div>
                <div className="font-mono text-[10.5px] text-muted">{clock(e.t)}</div>
              </div>
            </div>
          )
        }) : <div className="py-6 text-center text-[13px] text-muted">No messages yet. They appear here the moment anything happens.</div>}
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ 5. big buttons + health
// Defined outside the screens so the 1 s refresh never swaps a button mid-click.
function Big({ k, busy, color, onClick, children, solid }) {
  return (
    <button type="button" disabled={busy === k} onClick={onClick}
      className="h-14 rounded-xl px-3 text-[16px] font-black tracking-wide disabled:opacity-50"
      style={solid ? { background: color, color: '#fff' } : { background: `${color}26`, color, border: `2px solid ${color}` }}>
      {busy === k ? '…' : children}
    </button>
  )
}

function SmallBtn({ k, busy, color = BLUE, onClick, children }) {
  return (
    <button type="button" disabled={!!busy} onClick={onClick} className="rounded-xl py-2.5 text-[13px] font-extrabold disabled:opacity-50"
      style={{ background: `${color}22`, color, border: `1px solid ${color}77` }}>{busy === k ? '…' : children}</button>
  )
}

function Controls({ ops }) {
  const { busy, run } = useRun()
  const live = ops.live?.state
  const auto = ops.auto?.settings?.auto_collect
  const motor = ops.motor || {}
  const autoMotor = ops.auto?.settings?.motor_on_signal ?? motor.enabled ?? true
  const alt = ops.alert || {}
  const going = live === 'running' || live === 'returning'
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Big busy={busy} k="stop" color={RED} solid onClick={() => run('stop', boatApi.hold, 'Boat stopped')}>■ STOP</Big>
        {going
          ? <Big busy={busy} k="pause" color={AMBER} onClick={() => run('pause', boatApi.livePause, 'Boat paused')}>❚❚ PAUSE</Big>
          : <Big busy={busy} k="start" color={GREEN} onClick={() => run('start', () => boatApi.liveStart({ whenEmpty: 'wait' }), 'Started — the boat will go to each waste the drone finds')}>▶ START</Big>}
        <Big busy={busy} k="auto" color={auto ? GREEN : GREY} onClick={() => run('auto', () => boatApi.opsSettings({ auto_collect: !auto }), auto ? 'Auto scoop OFF' : 'Auto scoop ON')}>
          Auto scoop {auto ? 'ON' : 'OFF'}
        </Big>
        <Big busy={busy} k="motor" color={autoMotor ? (motor.on ? BLUE : GREEN) : GREY} onClick={() => run('motor', () => boatApi.opsSettings({ motor_on_signal: !autoMotor }), autoMotor ? 'Auto motor OFF' : 'Auto motor ON')}>
          Auto motor {autoMotor ? (motor.on ? `${motor.power_pct}%` : 'ON') : 'OFF'}
        </Big>
      </div>

      {/* Visual Alert Relay & Buzzer Quick Controls — Always Visible */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3" style={{ ...PANEL, border: alt.on ? `2px solid ${RED}` : `2px solid rgba(255,255,255,0.15)` }}>
        <div className="flex items-center gap-3">
          <span className="inline-block h-4 w-4 animate-pulse rounded-full" style={{ background: alt.on ? RED : (alt.enabled ? GREEN : GREY) }} />
          <div>
            <div className="text-[15px] font-black leading-tight text-ink">
              RELAY & BUZZER ALERT: <span style={{ color: alt.on ? RED : (alt.enabled ? GREEN : GREY) }}>{alt.on ? `PULSING RHYTHM (${alt.left_s}s left)` : (alt.enabled ? 'STANDBY (AUX 1 / Pin 50)' : 'DISABLED')}</span>
            </div>
            <div className="text-[12px] text-muted">5V Relay pulses E-minus LED strip & big buzzer together when drone finds plastic</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy === 'alt-test'} onClick={() => run('alt-test', () => boatApi.opsAlert('test'), 'Visual alert test started')}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[14px] font-black text-black shadow-lg transition active:scale-95 disabled:opacity-50"
            style={{ background: GREEN }}>
            🔔 TEST BUZZER + LED
          </button>
          <button type="button" disabled={busy === 'alt-stop'} onClick={() => run('alt-stop', () => boatApi.opsAlert('stop'), 'Alert stopped')}
            className="rounded-xl px-4 py-2.5 text-[14px] font-black text-white transition active:scale-95 disabled:opacity-50"
            style={{ background: RED }}>
            STOP ALERT
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * What the boat's own camera is doing right now. The operator should be able to
 * see at a glance why the motor is running — or why it is not.
 */
function CameraChip({ cc }) {
  if (!cc) return null
  const d = cc.distance_m
  const words = {
    idle: cc.enabled ? 'watching for plastic' : 'off',
    approach: d != null ? `going for plastic — ${d.toFixed(1)} m` : 'going for plastic',
    collecting: 'scooping',
    cooldown: 'collected — ready for the next',
  }
  const colour = { approach: BLUE, collecting: GREEN, cooldown: GREEN }[cc.state] || (cc.enabled ? undefined : GREY)
  const busy = cc.state === 'approach' || cc.state === 'collecting'
  return (
    <span className="rounded-full px-3 py-1 font-bold" title={cc.why || ''}
      style={{ background: busy ? `${colour}26` : PANEL.background, color: colour || 'inherit' }}>
      Boat camera: {words[cc.state] || cc.state}
      {cc.collected ? ` · ${cc.collected} collected` : ''}
    </span>
  )
}

function Health({ ops }) {
  const px = ops.pixhawk || {}
  const ph = ops.phone || {}
  const mot = ops.motor || {}
  const chips = [
    ['Pixhawk', px.connected, px.connected ? (px.armed ? 'armed' : 'ready') : 'lost'],
    ['Phone GPS', ph.gps_ok, ph.gps_ok ? `±${n1(ph.accuracy_m, 0)} m` : 'no fix'],
    ['Camera', ops.camera?.connected, ops.camera?.connected ? 'on' : 'off'],
  ]
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
      {chips.map(([k, ok, v]) => (
        <span key={k} className="rounded-full px-3 py-1 font-bold" style={{ background: `${ok ? GREEN : RED}1f`, color: ok ? GREEN : RED }}>
          {ok ? '●' : '○'} {k}: {v}
        </span>
      ))}
      <span className="rounded-full px-3 py-1 font-bold text-ink" style={PANEL}>Mode: {px.mode || '—'}</span>
      <span className="rounded-full px-3 py-1 font-bold text-ink" style={PANEL}>Speed: {n1(px.speed_mps)} m/s</span>
      <span className="rounded-full px-3 py-1 font-bold" style={{ background: mot.on ? `${BLUE}26` : PANEL.background, color: mot.on ? BLUE : 'inherit' }}>
        Motor: {mot.on ? `${mot.power_pct}% (${mot.left_s}s)` : mot.enabled ? 'ready' : 'off'}
      </span>
      <CameraChip cc={ops.camera_collect} />
      <span className="ml-auto text-[11.5px] text-muted">Hand control: flip <b className="text-ink">SwD</b> on the FS-i6</span>
    </div>
  )
}

// ------------------------------------------------------------------ More details
function Follow({ pos }) {
  const map = useMap()
  const first = useRef(true)
  useEffect(() => {
    if (!pos) return
    if (first.current) { map.setView(pos, 19); first.current = false } else map.panTo(pos, { animate: true })
  }, [pos?.[0], pos?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function MapPanel({ ops }) {
  const bp = ops.boat_position
  const pos = Number.isFinite(bp?.lat) ? [bp.lat, bp.lng] : null
  const t = ops.target
  const tPos = t ? [t.lat, t.lng] : null
  const acc = ops.phone?.accuracy_m
  return (
    <div className="relative h-[46vh] min-h-[300px] overflow-hidden rounded-2xl" style={PANEL}>
      <MapContainer center={pos || tPos || [20.5937, 78.9629]} zoom={pos || tPos ? 19 : 5} maxZoom={21} className="h-full w-full">
        <CachedTileLayer url={SAT_URL} maxZoom={21} maxNativeZoom={19} />
        <Follow pos={pos || tPos} />
        {pos && Number.isFinite(acc) && <Circle center={pos} radius={acc} pathOptions={{ color: BLUE, weight: 1, fillOpacity: 0.1 }} />}
        {pos && tPos && <Polyline positions={[pos, tPos]} pathOptions={{ color: YELLOW, weight: 3, dashArray: '8 6' }} />}
        {tPos && <CircleMarker center={tPos} radius={11} pathOptions={{ color: '#fff', weight: 2, fillColor: RED, fillOpacity: 0.95 }} />}
        {pos && <Marker position={pos} icon={boatIcon(ops.pixhawk?.heading_deg)} interactive={false} zIndexOffset={1000} />}
      </MapContainer>
      <div className="absolute left-2 top-2 z-[500] rounded-lg px-2.5 py-1.5 text-[12px] leading-snug" style={{ background: 'rgba(8,14,22,0.85)' }}>
        <div><span style={{ color: BLUE }}>▲</span> Boat (phone GPS)</div>
        <div><span style={{ color: RED }}>●</span> Waste found by the drone</div>
      </div>
    </div>
  )
}

function WasteList({ reachable }) {
  const [list, setList] = useState([])
  useEffect(() => {
    if (!reachable) return undefined
    let stop = false
    const load = async () => {
      const r = await boatApi.liveStatus().catch(() => null)
      if (!stop && r?.targets) setList([...r.targets].reverse())
    }
    load()
    const id = setInterval(load, 3000)
    return () => { stop = true; clearInterval(id) }
  }, [reachable])
  if (!list.length) return <div className="py-4 text-[13px] text-muted">No waste yet. Everything the drone finds appears here.</div>
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {list.map((t) => {
        const c = STATE_COLOR[t.state] || GREY
        return (
          <div key={t.id} className="flex gap-2.5 rounded-xl p-2" style={PANEL}>
            {t.has_reference
              ? <img src={boatUrls.liveReference(t.id)} alt="Drone picture" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
              : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg text-[10px] text-muted" style={PANEL}>no picture</div>}
            <div className="min-w-0 text-[12px]">
              <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: `${c}22`, color: c }}>{STATE_WORD[t.state] || 'Found by drone'}</span>
              <div className="mt-1 font-mono text-muted">{fmt8(t.lat)}</div>
              <div className="font-mono text-muted">{fmt8(t.lng)}</div>
              {Number.isFinite(t.match_score) && <div className="font-bold" style={{ color: c }}>match {pctOf(t.match_score)}%</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ScoopPanel({ ops }) {
  const { busy, run } = useRun()
  const sc = ops.scoop || {}
  const ms = ops.manual_servo || {}
  const s = ops.auto?.settings || {}
  const alt = ops.alert || {}
  const save = (patch) => run('set', () => boatApi.opsSettings(patch), 'Saved')
  const pct = Number.isFinite(sc.pos_us) ? Math.max(0, Math.min(100, ((sc.pos_us - sc.zero_us) / ((sc.extreme_us - sc.zero_us) || 1)) * 100)) : 0
  const lc = ops.auto?.last_check
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card title="Scoop (automatic)">
        <div className="mb-2 h-4 overflow-hidden rounded-full bg-black/40">
          <div className="h-full rounded-full transition-[width] duration-100" style={{ width: `${pct}%`, background: sc.moving ? AMBER : GREEN }} />
        </div>
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          <SmallBtn busy={busy} k="ext" onClick={() => run('ext', () => boatApi.opsScoop('extreme'))}>Test: open</SmallBtn>
          <SmallBtn busy={busy} k="zero" onClick={() => run('zero', () => boatApi.opsScoop('zero'))}>Test: close</SmallBtn>
          <SmallBtn busy={busy} k="abort" color={RED} onClick={() => run('abort', () => boatApi.opsScoop('abort'))}>Stop scoop</SmallBtn>
        </div>
        <label className="flex items-center gap-2 py-1 text-[13px]">
          <input type="checkbox" checked={!!s.require_match} onChange={(e) => save({ require_match: e.target.checked })} /> Only scoop when the waste is matched
        </label>
        <label className="flex items-center justify-between gap-2 py-1 text-[13px]">
          <span className="text-muted">Scoop speed</span>
          <select value={s.scoop_speed_pct ?? 50} onChange={(e) => save({ scoop_speed_pct: Number(e.target.value) })} className="rounded bg-black/30 px-2 py-1 text-ink">
            {[30, 40, 50, 60, 75, 100].map((v) => <option key={v} value={v}>{v}%</option>)}
          </select>
        </label>
        {lc && (
          <div className="mt-2 text-[12px]">
            <div className="font-bold" style={{ color: lc.ok ? GREEN : RED }}>Last try ({clock(lc.t)}): {lc.ok ? 'scooped' : 'did not scoop'}</div>
            {!lc.ok && lc.checks.filter((c) => !c.ok).map((c) => <div key={c.text} style={{ color: RED }}>✗ {c.text}</div>)}
          </div>
        )}
      </Card>
      <Card title="Second servo (your FS-i6 switch SwA)">
        <div className="rounded-xl py-4 text-center" style={PANEL}>
          <div className="text-[32px] font-black" style={{ color: ms.position ? GREEN : GREY }}>
            {ms.position === 'extreme' ? 'EXTREME' : ms.position === '0' ? '0 POSITION' : '—'}
          </div>
          <div className="text-[12px] text-muted">{ms.receiver ? 'Receiver connected' : 'No receiver signal'}</div>
        </div>
        <div className="mt-2 text-[12px] text-muted">Only the switch moves this servo. The app never moves it.</div>
      </Card>
      <Card title="Automatic Plastic Detection Motor (10% - 20% Throttle)">
        <div className="mb-2 flex items-center justify-between text-[13px]">
          <span className="text-muted">Status:</span>
          <span className="font-bold" style={{ color: (ops.motor?.on) ? BLUE : ((ops.motor?.ready) ? GREEN : AMBER) }}>
            {ops.motor?.on ? `RUNNING at ${ops.motor?.power_pct}% (${ops.motor?.left_s}s left)` : (ops.motor?.ready ? 'READY (armed in MANUAL)' : (ops.motor?.not_ready || 'Not ready'))}
          </span>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-1.5">
          <SmallBtn busy={busy} k="mot-test" color={GREEN} onClick={() => run('mot-test', () => boatApi.opsMotor('test'), 'Motor test signal sent')}>
            Test Motor (20%)
          </SmallBtn>
          <SmallBtn busy={busy} k="mot-stop" color={RED} onClick={() => run('mot-stop', () => boatApi.opsMotor('stop'), 'Motor stopped')}>
            Stop Motor
          </SmallBtn>
        </div>
        <label className="flex items-center justify-between gap-2 py-1 text-[13px]">
          <span className="text-muted">Run duration per find</span>
          <select value={s.motor_run_s ?? 10} onChange={(e) => save({ motor_run_s: Number(e.target.value) })} className="rounded bg-black/30 px-2 py-1 text-ink">
            {[3, 5, 10, 15, 20, 30].map((v) => <option key={v} value={v}>{v} seconds</option>)}
          </select>
        </label>
        <div className="mt-2 text-[11.5px] text-muted">
          When plastic is detected by drone (20% power) or boat camera (10% power), motor runs automatically. Buzzer and LED relay pulse simultaneously. Flip SwD or press STOP to cancel anytime.
        </div>
      </Card>
      <Card title="Visual Alert Beacon (5V Relay: LED + Buzzer)">
        <div className="mb-2 flex items-center justify-between text-[13px]">
          <span className="text-muted">Status:</span>
          <span className="font-bold" style={{ color: alt.on ? RED : (alt.enabled ? GREEN : GREY) }}>
            {alt.on ? `PULSING ALERT RHYTHM (${alt.left_s}s left)` : (alt.enabled ? 'READY (AUX 1 / Pin 50)' : 'DISABLED')}
          </span>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-1.5">
          <SmallBtn busy={busy} k="alt-test" color={GREEN} onClick={() => run('alt-test', () => boatApi.opsAlert('test'), 'Visual alert test started')}>
            Test Alert (LED+Buzzer)
          </SmallBtn>
          <SmallBtn busy={busy} k="alt-stop" color={RED} onClick={() => run('alt-stop', () => boatApi.opsAlert('stop'), 'Alert stopped')}>
            Stop Alert
          </SmallBtn>
        </div>
        <label className="flex items-center gap-2 py-1 text-[13px]">
          <input type="checkbox" checked={s.alert_on_signal ?? true} onChange={(e) => save({ alert_on_signal: e.target.checked })} /> Blink LED strip & sound buzzer on drone find
        </label>
        <label className="flex items-center justify-between gap-2 py-1 text-[13px]">
          <span className="text-muted">Alert pulse duration</span>
          <select value={s.alert_duration_s ?? 8} onChange={(e) => save({ alert_duration_s: Number(e.target.value) })} className="rounded bg-black/30 px-2 py-1 text-ink">
            {[3, 5, 8, 10, 15, 20].map((v) => <option key={v} value={v}>{v} seconds</option>)}
          </select>
        </label>
        <div className="mt-2 text-[11.5px] text-muted">
          5V Relay on Pixhawk AUX 1 (Pin 50) switches the E-minus LED strip and buzzer together in an alert rhythm whenever plastic is detected.
        </div>
      </Card>
    </div>
  )
}

function PixhawkPanel({ ops }) {
  const px = ops.pixhawk || {}
  const ph = ops.phone || {}
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card title="Pixhawk (USB to the phone)">
        <Row k="Connected" v={px.connected ? 'yes' : 'NO'} color={px.connected ? GREEN : RED} />
        <Row k="Armed" v={px.armed ? 'ARMED' : 'no'} color={px.armed ? AMBER : undefined} />
        <Row k="Mode" v={px.mode} />
        <Row k="Speed" v={`${n1(px.speed_mps)} m/s`} />
        <Row k="Heading (compass)" v={Number.isFinite(px.heading_deg) ? `${Math.round(px.heading_deg)}°` : '—'} />
        <Row k="Boat position (phone GPS)" v={ph.lat != null ? `${fmt8(ph.lat)}, ${fmt8(ph.lng)}` : '—'} />
      </Card>
      <Card title="Pixhawk says">
        {(px.messages || []).length ? [...px.messages].reverse().map((m) => (
          <div key={`${m.t}${m.text}`} className="py-[2px] text-[12.5px]" style={{ color: m.severity <= 3 ? RED : m.severity <= 4 ? AMBER : undefined }}>
            <span className="font-mono text-muted">{clock(m.t)}</span> {m.text}
          </div>
        )) : <div className="text-[12.5px] text-muted">Nothing new.</div>}
      </Card>
    </div>
  )
}

const MORE = [['map', 'Map'], ['list', 'All waste'], ['scoop', 'Scoop'], ['pixhawk', 'Pixhawk']]

function More({ ops, reachable }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('varuna.boatMore') || '' } catch { return '' }
  })
  const pick = (k) => {
    const next = open === k ? '' : k
    setOpen(next)
    try { localStorage.setItem('varuna.boatMore', next) } catch { /* private mode */ }
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] font-extrabold uppercase tracking-wider text-muted">More details</span>
        {MORE.map(([k, l]) => (
          <button key={k} type="button" onClick={() => pick(k)} className="rounded-lg px-3 py-1.5 text-[13px] font-bold"
            style={open === k ? { background: `${BLUE}2a`, color: BLUE, border: `1px solid ${BLUE}77` } : { ...PANEL, color: 'var(--ink, #e8eef4)' }}>
            {l} {open === k ? '▴' : '▾'}
          </button>
        ))}
      </div>
      {open && (
        <div className="mt-2">
          {open === 'map' && <MapPanel ops={ops} />}
          {open === 'list' && <WasteList reachable={reachable} />}
          {open === 'scoop' && <ScoopPanel ops={ops} />}
          {open === 'pixhawk' && <PixhawkPanel ops={ops} />}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ screen
function NotConnected({ text }) {
  return (
    <div className="mx-auto mt-6 max-w-[620px] rounded-2xl p-6" style={{ ...PANEL, border: `2px solid ${AMBER}` }}>
      <div className="text-[26px] font-black" style={{ color: AMBER }}>{text}</div>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] text-ink">
        <li>Plug the Pixhawk into the boat phone (USB).</li>
        <li>Open <b>VARUNA Boat Link</b> on the phone.</li>
        <li>On the laptop, run <b>Start VARUNA Boat</b>.</li>
      </ol>
      <div className="mt-3 text-[13px] text-muted">This page fills in by itself once the boat answers.</div>
    </div>
  )
}

export default function BoatOpsScreen() {
  const boat = useBoat()
  const reachable = boat.reachable === true
  const { ops, ageMs } = useOpsStatus(reachable)
  // Reset hides the current drone picture(s); a NEW drone find shows again.
  const [dismissed, setDismissed] = useState(() => new Set())
  const localRaw = useLocalDroneCrop()
  const local = localRaw && !dismissed.has(localRaw.id) ? localRaw : null
  const target = ops?.target && !dismissed.has(ops.target.id) ? ops.target : null
  const { best, matched } = useBestMatch(target, local, ops?.auto?.match_threshold ?? 0.55)
  const resetMatch = () => {
    setDismissed((s) => new Set([...s, localRaw?.id, ops?.target?.id].filter(Boolean)))
    clearLatestDroneCrop()
  }
  if (!reachable) return <NotConnected text="Boat not connected" />
  if (!ops) return <div className="py-16 text-center text-[15px] text-muted">Connecting to the boat…</div>
  if (ops.missing) return <NotConnected text="Old boat program running — restart it with Start VARUNA Boat" />
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-2.5 p-1 md:p-2">
      {ageMs > 4000 && ageMs !== Infinity && (
        <div className="rounded-lg px-3 py-1.5 text-[13px] font-bold" style={{ background: `${AMBER}22`, color: AMBER }}>
          No update from the boat for {Math.round(ageMs / 1000)} s
        </div>
      )}
      <Alerts alerts={ops.alerts} />
      <Hero ops={ops} matched={matched} />
      <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.75fr)_minmax(330px,1fr)]">
        <div className="flex min-w-0 flex-col gap-2.5">
          <LiveCamera ops={ops} />
          <Controls ops={ops} />
          <Health ops={ops} />
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <MatchCard ops={ops} target={target} best={best} local={local} onReset={resetMatch} />
          <Messages events={ops.events} />
        </div>
      </div>
      <More ops={ops} reachable={reachable} />
    </div>
  )
}
