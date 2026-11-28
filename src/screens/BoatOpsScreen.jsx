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
import { latestDroneCrop, clearLatestDroneCrop, onLatestDroneCrop } from '../lib/droneTargets'
import { getDroneCanvas, droneFrameAge } from '../lib/droneView'
import DroneVideo from '../components/DroneVideo'
import { useOpsStatus, fmt8, fmtM, clock } from '../lib/opsStatus'
import { MoreOptions, Pill, TabHeader } from '../components/simple/Simple'

// The Boat tab: one simple screen for drone -> boat waste collection.
// Big status line, the live boat camera with the waste-matching boxes, the
// "is it the same waste?" check, live messages, and three big buttons.
// Everything else (map, waste list, scoop, boat brain) sits under "More details".
// Data: boat-pi/boat_extras.py -> /api/ops/status (polled every second).

// Signal colours, readable on both themes: bright on the dark theme, deeper
// shades on the light theme (WCAG AA on white). Repainted when the theme changes.
const DARK_SET = { GREEN: '#32D74B', RED: '#FF453A', AMBER: '#FF9F0A', BLUE: '#3B9EFF', GREY: '#98A0AB', YELLOW: '#FFD60A' }
const LIGHT_SET = { GREEN: '#15803d', RED: '#dc2626', AMBER: '#b45309', BLUE: '#1d4ed8', GREY: '#64748b', YELLOW: '#a16207' }
let GREEN, RED, AMBER, BLUE, GREY, YELLOW
const PANEL = { background: 'var(--sx-card)', border: '1px solid var(--sx-line)', boxShadow: 'var(--sx-shadow)' }
const SCOOPING = new Set(['checking', 'waiting', 'to_extreme', 'holding', 'to_zero'])
const STATE_COLOR = {}
function paint() {
  ;({ GREEN, RED, AMBER, BLUE, GREY, YELLOW } = document.documentElement.dataset.theme === 'light' ? LIGHT_SET : DARK_SET)
  Object.assign(STATE_COLOR, {
    DETECTED: AMBER, SENT: AMBER, NAVIGATING: BLUE, SEARCHING: BLUE, MATCHED: GREEN, APPROACHING: GREEN,
    COLLECTING: GREEN, VERIFYING: GREEN, COLLECTED: GREEN, NOT_FOUND: RED, RETRY_REQUIRED: RED, SKIPPED: GREY,
  })
}
paint()
if (typeof MutationObserver !== 'undefined') new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
const STATE_WORD = {
  DETECTED: 'Found by drone', SENT: 'Found by drone', NAVIGATING: 'Boat going there', SEARCHING: 'Camera searching',
  MATCHED: 'Matched', APPROACHING: 'Matched', COLLECTING: 'Collecting', VERIFYING: 'Collecting', COLLECTED: 'Collected',
  NOT_FOUND: 'Not found', RETRY_REQUIRED: 'Not found', SKIPPED: 'Skipped',
}
const n1 = (v, d = 1) => (Number.isFinite(v) ? Number(v).toFixed(d) : '—')
const pctOf = (v) => (Number.isFinite(v) ? Math.round(v * 100) : null)

function Card({ title, right, children, className = '', bodyClass = '', style }) {
  return (
    <div className={`overflow-hidden rounded-[14px] ${className}`} style={{ ...PANEL, ...style }}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: 'var(--sx-line)' }}>
          <span className="text-[14px] font-semibold text-ink">{title}</span>
          {right}
        </div>
      )}
      <div className={`p-4 ${bodyClass}`}>{children}</div>
    </div>
  )
}

/** One labelled reading in a status grid: a coloured dot, the label, the value. */
function StatusItem({ label, value, color, wide }) {
  return (
    <div className={`sx-well flex min-w-0 items-center gap-2.5 px-3 py-2.5 ${wide ? 'col-span-2' : ''}`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color || 'var(--sx-line2)' }} />
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-muted">{label}</div>
        <div className="truncate text-[13.5px] font-semibold tnum text-ink" title={typeof value === 'string' ? value : undefined}>{value}</div>
      </div>
    </div>
  )
}

const WARN_ICON = <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></svg>
const sentence = (t) => (t ? t.charAt(0) + t.slice(1).toLowerCase() : t)

function Row({ k, v, color }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[13px]">
      <span className="text-muted">{k}</span>
      <span className="text-right font-mono font-semibold tnum" style={{ color: color || undefined }}>{v ?? '—'}</span>
    </div>
  )
}

// The match threshold the operator sets on the Boat tab. While the slider moves
// the new value is used at once (card, video boxes, MATCHED); it is saved to the
// boat (match_threshold, kept across restarts) a moment after the slider stops.
function useMatchThreshold(ops) {
  const toast = useToast()
  const saved = Number.isFinite(ops?.auto?.match_threshold) ? ops.auto.match_threshold : 0.55
  const [draft, setDraft] = useState(null)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  // The boat reports the saved value: the draft is no longer needed.
  useEffect(() => { if (draft != null && Math.abs(saved - draft) < 0.001) setDraft(null) }, [saved, draft])
  const set = (v) => {
    const val = Math.round(Math.min(0.95, Math.max(0.2, v)) * 100) / 100
    setDraft(val)
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await boatApi.setVisionConfig({ match_threshold: val })
        if (!isOk(res)) {
          toast.push({ level: 'bad', title: `Threshold not saved: ${res?.message || (res?._httpError ? `HTTP ${res._httpError}` : 'no answer from the boat')}` })
          setDraft(null)
        }
      } catch (e) {
        toast.push({ level: 'bad', title: `Threshold not saved: ${e?.message || e}` })
        setDraft(null)
      }
    }, 450)
  }
  return [draft ?? saved, set, draft != null]
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
// round trip needed): the same detections the Live tab makes, the moment each
// new picture is taken.
function useLocalDroneCrop() {
  const [v, setV] = useState(latestDroneCrop)
  useEffect(() => {
    setV(latestDroneCrop())
    return onLatestDroneCrop(setV)
  }, [])
  return v
}

// The drone find the boat itself is homing onto (its reply to the camera AI), or null.
function useBoatHomingId() {
  const [id, setId] = useState(null)
  useEffect(() => subscribeVision((s) => {
    const n = s?.matching?.id || null
    setId((p) => (p === n ? p : n))
  }), [])
  return id
}

// A clock tick, for "seen 3s ago".
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(iv)
  }, [ms])
  return now
}

// `pic`: the drone picture the card shows. The camera AI matches the boat
// camera against exactly that picture.
function useBestMatch(pic, thr) {
  const [best, setBest] = useState(null)
  const [parts, setParts] = useState(null)
  const [matched, setMatched] = useState(false)
  const run = useRef({ up: 0, down: 0 })
  const id = pic?.id || null
  const cls = pic?.cls || null
  const crop = pic?.kind === 'live' ? pic.crop : null
  const key = pic?.kind === 'live' ? pic.key : null
  useEffect(() => { setMatchTarget(id ? { id, cls, crop, key } : null) }, [id, cls, crop, key])
  useEffect(() => () => setMatchTarget(null), [])
  const thrRef = useRef(thr)
  thrRef.current = thr
  useEffect(() => { run.current = { up: 0, down: 0, last: null }; setMatched(false) }, [id])
  useEffect(() => subscribeVision((s) => {
    const list = s?.targets || []
    if (list === run.current.last) return // same AI pass (another field changed)
    run.current.last = list
    const top = list.reduce((a, b) => (Number.isFinite(b.match) && b.match > (a?.match ?? -1) ? b : a), null)
    const m = top ? top.match : null
    const r = m == null ? null : Math.round(m * 100) / 100
    setBest((p) => (p === r ? p : r))
    // Why the score is what it is (look / kind / detector), in 5% steps so it re-renders rarely.
    const pp = top?.matchParts || null
    const q = (v) => (Number.isFinite(v) ? Math.round(v * 20) / 20 : null)
    const np = pp ? { look: q(pp.look), cls: q(pp.class), det: q(pp.detector), shape: q(pp.shape), label: top.label || null } : null
    setParts((p) => (p && np && p.look === np.look && p.cls === np.cls && p.det === np.det && p.shape === np.shape && p.label === np.label) || (!p && !np) ? p : np)
    // Hysteresis: MATCHED after 2 passes at/above the threshold, cleared only
    // after 3 passes clearly below it — no blinking right at the line.
    const t = thrRef.current, c = run.current
    if (r != null && r >= t) { c.up++; c.down = 0 } else if (r == null || r < t - 0.05) { c.down++; c.up = 0 }
    if (c.up >= 2) setMatched(true)
    else if (c.down >= 3) setMatched(false)
  }), [])
  return { best, matched, parts }
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

function HeroStat({ label, value, color }) {
  return (
    <div className="min-w-[120px] border-l pl-5 text-left max-sm:border-l-0 max-sm:pl-0" style={{ borderColor: 'var(--sx-line)' }}>
      <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className="font-mono text-[26px] font-semibold leading-tight tnum" style={{ color: color || 'var(--sx-ink)' }}>{value}</div>
    </div>
  )
}

function Hero({ ops, matched }) {
  const h = heroOf(ops, matched)
  const t = ops.target
  const live = ops.live?.state
  const collected = ops.live?.counts?.collected
  const active = live === 'running' || live === 'returning'
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] px-5 py-4" style={{ ...PANEL, borderLeft: `5px solid ${h.c}` }}>
      <span className="hidden h-12 w-12 shrink-0 place-items-center rounded-xl sm:grid" style={{ background: `${h.c}1a` }}>
        <span className={`h-3.5 w-3.5 rounded-full ${active ? 'animate-pulse' : ''}`} style={{ background: h.c, boxShadow: `0 0 0 5px ${h.c}26` }} />
      </span>
      <div className="min-w-[240px] flex-1">
        <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">Right now</div>
        <div className="text-[22px] font-bold leading-tight tracking-tight md:text-[26px]" style={{ color: h.c }}>{sentence(h.title)}</div>
        <div className="mt-0.5 text-[14.5px]" style={{ color: 'var(--sx-sub)' }}>{h.sub}</div>
      </div>
      {t && Number.isFinite(t.distance_m) && <HeroStat label="Distance to waste" value={fmtM(t.distance_m)} color={YELLOW} />}
      {Number.isFinite(collected) && <HeroStat label="Collected" value={collected} />}
    </div>
  )
}

function Alerts({ alerts }) {
  if (!alerts?.length) return null
  return (
    <div className="grid gap-2">
      {alerts.map((a) => (
        <div key={a} className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[14px] font-semibold" style={{ background: `${RED}12`, border: `1px solid ${RED}55`, color: RED }}>
          {WARN_ICON}<span className="text-ink">{a}</span>
        </div>
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

// Long range: the camera AI also scans zoomed-in pieces of the far water, and the
// boat may act on plastic out to camera_long_range_max_m (a boat setting, so
// the app and the boat agree; it is kept across restarts).
function LongRangeSwitch({ bv }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const cfg = bv?.cfg
  if (!cfg || !('camera_long_range' in cfg)) return null // a boat program from before long range
  const on = !!cfg.camera_long_range
  const maxM = Math.round(Number(cfg.camera_long_range_max_m) || 30)
  const flip = async () => {
    setBusy(true)
    try {
      const res = await bv.updateConfig({ camera_long_range: !on })
      if (!isOk(res)) toast.push({ level: 'bad', title: `Long range not changed: ${res?.message || 'no answer from the boat'}` })
    } catch (e) {
      toast.push({ level: 'bad', title: `Long range not changed: ${e?.message || e}` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" onClick={flip} disabled={busy} aria-pressed={on}
      title={on ? `Long range ON: also scanning the far water, plastic up to ${maxM} m counts. Click to turn off.` : 'Long range: also look for small, far plastic (uses more computer power)'}
      className="rounded-lg px-2.5 py-1 text-[12.5px] font-bold disabled:opacity-60"
      style={{ background: on ? `${BLUE}cc` : 'rgba(0,0,0,0.65)', color: on ? '#fff' : 'rgba(255,255,255,0.85)', border: `1px solid ${on ? BLUE : 'rgba(255,255,255,0.25)'}` }}>
      🔭 Long range {busy ? '…' : on ? `ON · ${maxM} m` : 'OFF'}
    </button>
  )
}

// ------------------------------------------------------------------ 2. the two live streams, side by side
// Same frame for both, so the drone's and the boat's views come out the same size.
const STREAM_BOX = 'relative aspect-video w-full overflow-hidden rounded-[14px] bg-black'

function StreamTag({ icon, text, live, color, extra }) {
  return (
    <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] font-bold" style={{ background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(8px)' }}>
      <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full" style={{ background: live ? RED : GREY }} />
      <span style={{ color }}>{icon} {text}</span>
      <span className="text-white/90">{live ? 'LIVE' : ''}</span>
      {extra}
    </div>
  )
}

// The drone camera with its AI boxes. The drone's detector already runs off
// screen while this tab is open (App.jsx -> BackgroundDetect); this mirrors its
// picture instead of opening a second stream. If the detector draws nothing for
// a while (still loading, or it failed), the plain drone video shows instead.
function DroneLive() {
  const canvas = useRef(null)
  const [mirror, setMirror] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [plainOk, setPlainOk] = useState(false)
  useEffect(() => {
    let stopped = false
    let raf = 0
    let shown = false
    let waited = false
    let t0 = performance.now()
    const draw = () => {
      if (stopped) return
      const src = getDroneCanvas()
      const c = canvas.current
      const fresh = droneFrameAge() < 1500
      if (src && c && fresh && src.width > 2 && src.height > 2) {
        if (c.width !== src.width || c.height !== src.height) { c.width = src.width; c.height = src.height }
        const g = c.getContext('2d')
        g.clearRect(0, 0, c.width, c.height)
        g.drawImage(src, 0, 0)
        if (!shown) { shown = true; setMirror(true); setFallback(false) }
      } else if (shown && !fresh) {
        shown = false
        waited = false
        t0 = performance.now()             // the drone AI stopped drawing: plain video again in 6 s
        setMirror(false)
      }
      if (!shown && !waited && performance.now() - t0 > 6000) { waited = true; setFallback(true) }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { stopped = true; cancelAnimationFrame(raf) }
  }, [])
  const live = mirror || (fallback && plainOk)
  return (
    <div className={STREAM_BOX} style={PANEL}>
      <canvas ref={canvas} className={`absolute inset-0 h-full w-full object-contain ${mirror ? '' : 'hidden'}`} />
      {!mirror && fallback && (
        <DroneVideo alt="Drone camera" className={`absolute inset-0 h-full w-full object-contain ${plainOk ? '' : 'opacity-0'}`}
          onLoad={() => setPlainOk(true)} onError={() => setPlainOk(false)} />
      )}
      {!live && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[16px] font-bold" style={{ color: AMBER }}>
          Waiting for the drone camera…
        </div>
      )}
      <StreamTag icon="🛰" text="DRONE" live={live} color={AMBER} />
      <div className="absolute right-3 top-3 rounded-lg px-2.5 py-1 text-[13px] font-bold" style={{ background: 'rgba(0,0,0,0.65)', color: mirror ? GREEN : GREY }}>
        {mirror ? 'Drone AI finding plastic' : live ? 'Drone AI starting…' : ''}
      </div>
      <div className="absolute bottom-3 left-3 rounded-lg px-2.5 py-1 text-[12px] font-bold text-white/85" style={{ background: 'rgba(0,0,0,0.6)' }}>
        Step 1 · the drone finds the plastic from the air
      </div>
    </div>
  )
}

// The boat camera's best candidate right now, cut out of its picture, so the
// match card can show "drone saw this" next to "boat sees this".
function BoatCrop({ thr }) {
  const canvas = useRef(null)
  const thrRef = useRef(thr)
  thrRef.current = thr
  const [info, setInfo] = useState(null)
  useEffect(() => subscribeVision((s) => {
    const list = s?.targets || []
    const c = canvas.current
    const bmp = getLatestFrame()
    if (!c) return
    const matched = list.filter((b) => Number.isFinite(b.match))
    const top = matched.length
      ? matched.reduce((a, b) => (b.match > a.match ? b : a))
      : list.reduce((a, b) => ((Number(b.score) || 0) > (Number(a?.score) || -1) ? b : a), null)
    if (!top || !bmp) {
      setInfo((p) => (p === null ? p : null))
      return
    }
    const bw = top.x2 - top.x1, bh = top.y2 - top.y1
    const side = Math.max(bw, bh) * 1.5
    const cx = (top.x1 + top.x2) / 2, cy = (top.y1 + top.y2) / 2
    const sx = Math.max(0, Math.min(bmp.width - side, cx - side / 2))
    const sy = Math.max(0, Math.min(bmp.height - side, cy - side / 2))
    const sw = Math.min(side, bmp.width), sh = Math.min(side, bmp.height)
    try {
      c.width = 320; c.height = 320
      const g = c.getContext('2d')
      g.fillStyle = '#000'
      g.fillRect(0, 0, 320, 320)
      const k = Math.min(320 / sw, 320 / sh)
      g.drawImage(bmp, sx, sy, sw, sh, (320 - sw * k) / 2, (320 - sh * k) / 2, sw * k, sh * k)
    } catch {
      return // that frame was already released: keep the last picture
    }
    const m = Number.isFinite(top.match) ? Math.round(top.match * 100) : null
    const same = m != null && top.match >= thrRef.current
    const next = { m, same, label: top.label || 'plastic' }
    setInfo((p) => (p && p.m === next.m && p.same === next.same && p.label === next.label ? p : next))
  }), [])
  return (
    <div>
      <canvas ref={canvas} className={`aspect-square w-full rounded-xl bg-black object-contain ${info ? '' : 'hidden'}`}
        style={info ? { outline: `3px solid ${info.m == null ? BLUE : info.same ? GREEN : AMBER}`, outlineOffset: -3 } : undefined} />
      {!info && (
        <div className="flex aspect-square w-full items-center justify-center rounded-xl px-2 text-center text-[11px] text-muted" style={PANEL}>
          no plastic in the boat camera yet
        </div>
      )}
      {info && <div className="mt-1 truncate text-[11px] text-muted">{info.label}{info.m != null ? ` · ${info.m}% alike` : ''}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ live boat camera with matching boxes
function LiveCamera({ ops, thr }) {
  const bv = useBoatVision()
  const canvas = useRef(null)
  const engRef = useRef(null)
  const thrRef = useRef(0.55)
  thrRef.current = thr
  // The scoop's mouth in the picture (boat setting, fractions): drawn on the
  // stream, green when the waste the boat is going for is inside it.
  const zs = ops.auto?.settings
  const zoneRef = useRef(null)
  zoneRef.current = zs && zs.camera_scoop_inside !== false && Number.isFinite(zs.scoop_zone_x1)
    ? [zs.scoop_zone_x1, zs.scoop_zone_y1, zs.scoop_zone_x2, zs.scoop_zone_y2] : null
  // What the BOAT says about it (the green box is the app's view; the boat
  // checks everything again and may still refuse - show why, not just green).
  const ccRef = useRef(null)
  ccRef.current = ops.camera_collect || null
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
          const text = (!hasMatch ? `plastic ${pctOf(b.score)}%` : same ? `✓ SAME WASTE ${pctOf(b.match)}%` : `not a match ${pctOf(b.match)}%`)
            + (b.unsure ? ' ?' : '') // the self-learner isn't sure: shown, never acted on
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
        const z = zoneRef.current
        if (z) {
          const W = bmp.width, H = bmp.height
          const lb = engRef.current?.lock?.box
          const trapped = Array.isArray(lb) && engRef.current?.lock?.visible !== false && (() => {
            const cx = (lb[0] + lb[2]) / 2, cy = (lb[1] + lb[3]) / 2
            return cx >= z[0] && cx <= z[2] && cy >= z[1] && cy <= z[3]
          })()
          const zc = trapped ? GREEN : 'rgba(255,255,255,0.85)'
          g.save()
          g.setLineDash([14, 9])
          g.lineWidth = Math.max(3, W / 200)
          g.strokeStyle = zc
          g.strokeRect(z[0] * W, z[1] * H, (z[2] - z[0]) * W, (z[3] - z[1]) * H)
          g.restore()
          const zt = trapped ? '✓ WASTE IN THE SCOOP' : 'SCOOP'
          g.font = `900 ${fs}px sans-serif`
          const zw = g.measureText(zt).width + 14
          const zx = z[0] * W + ((z[2] - z[0]) * W - zw) / 2
          const zy = Math.max(fs + 8, z[1] * H - 6)
          g.fillStyle = trapped ? GREEN : 'rgba(0,0,0,0.7)'
          g.fillRect(zx, zy - fs - 4, zw, fs + 8)
          g.fillStyle = trapped ? '#000' : '#fff'
          g.fillText(zt, zx + 7, zy - 2)
          const cc = ccRef.current
          const boatSays = !trapped || !cc ? null
            : cc.state === 'collecting' ? 'SCOOPING'
            : cc.state === 'cooldown' ? null
            : cc.scoop_why || cc.why || null
          if (boatSays) {
            const bs = `boat: ${boatSays}`.slice(0, 70)
            const f2 = Math.round(fs * 0.8)
            g.font = `800 ${f2}px sans-serif`
            const bw = g.measureText(bs).width + 12
            const bx = Math.max(4, Math.min(W - bw - 4, z[0] * W + ((z[2] - z[0]) * W - bw) / 2))
            const by = zy + f2 + 10
            g.fillStyle = boatSays === 'SCOOPING' ? GREEN : 'rgba(245,158,11,0.95)'
            g.fillRect(bx, by - f2 - 4, bw, f2 + 8)
            g.fillStyle = '#000'
            g.fillText(bs, bx + 6, by - 2)
          }
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
    <div className={STREAM_BOX} style={PANEL}>
      <canvas ref={canvas} className={`absolute inset-0 h-full w-full object-contain ${hasFrame ? '' : 'hidden'}`} />
      {/* Only open the fallback <img> stream when Vision AI is off or errored, so we never run two simultaneous video connections over Wi-Fi. */}
      {!hasFrame && (!bv?.enabled || bv?.engine?.status === 'error') && <MjpegImg className={`absolute inset-0 h-full w-full object-contain ${streamOk ? '' : 'opacity-0'}`} onState={setStreamOk} />}
      {!hasFrame && !streamOk && (
        <div className="absolute inset-0 flex items-center justify-center text-center text-[16px] font-bold" style={{ color: camOk ? AMBER : RED }}>
          {camOk ? 'Connecting to the camera…' : 'Waiting for the boat camera…'}
        </div>
      )}
      <StreamTag icon="🚤" text="BOAT" live={!!camOk} color={BLUE}
        extra={camOk ? <span className="font-mono text-[12px] font-bold text-white/70">{n1(ops.camera.fps, 0)} fps</span> : null} />
      <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
        <div className="rounded-lg px-2.5 py-1 text-[13px] font-bold" style={{ background: 'rgba(0,0,0,0.65)', color: hasFrame ? GREEN : AMBER }}>
          {hasFrame ? `Matching ON · ${boxes} plastic seen` : bv?.enabled ? 'Matching starting…' : 'Matching is OFF'}
        </div>
        <LongRangeSwitch bv={bv} />
      </div>
      {!hasFrame && camOk && bv && !bv.enabled && (
        <button type="button" onClick={() => bv.setEnabled(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl px-5 py-3 text-[16px] font-bold"
          style={{ background: GREEN, color: '#000' }}>Turn on waste matching</button>
      )}
      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2.5 py-1 text-[12px] font-bold" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <span className="text-white/85">Step 2 · the boat's camera matches it</span>
        <span style={{ color: GREEN }}>■ same waste</span><span style={{ color: AMBER }}>■ not a match</span><span style={{ color: BLUE }}>■ plastic</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 3. is it the same waste?
function MatchCard({ ops, target, pic, held, best, parts, thr, onThr, thrSaving, onReset, onHold }) {
  const t = target
  const boatPic = pic?.kind === 'boat'
  const score = Number.isFinite(best) ? best : boatPic && t?.id === pic.id ? t?.match_score : null
  const st = t?.state
  const now = useNow(1000)
  const ageS = pic?.at ? Math.max(0, Math.round((now - pic.at) / 1000)) : null
  const fresh = ageS != null && ageS <= 2
  let verdict
  if (!pic && !t) verdict = ['No waste to match yet', GREY]
  else if (!ops.camera?.connected) verdict = ['Camera off — cannot match', RED]
  else if (Number.isFinite(score)) verdict = score >= thr ? ['YES — SAME WASTE', GREEN] : ['NOT SURE YET', AMBER]
  else if (!boatPic || st === 'SEARCHING' || !t) verdict = ['Show it to the boat camera…', BLUE]
  else verdict = ['Boat going to the spot — matching starts when close', GREY]
  let tag = null
  if (boatPic) tag = ['Boat is going for this', BLUE]
  else if (held) tag = ['Held', AMBER]
  else if (pic) tag = [fresh ? '● NEW' : `detected ${ageS}s ago`, fresh ? GREEN : GREY]
  return (
    <Card title="Is it the same waste?" right={(pic || t) && (
      <div className="flex gap-1.5">
        {pic?.kind === 'live' && (
          <button type="button" onClick={onHold}
            title={held ? "Show the drone's next detection again" : 'Keep this photo even if the drone detects another plastic'}
            className="rounded-lg px-2.5 py-1 text-[11.5px] font-semibold"
            style={{ background: `${AMBER}22`, color: AMBER, border: `1px solid ${AMBER}77` }}>{held ? 'Follow drone' : 'Hold'}</button>
        )}
        <button type="button" onClick={onReset} title="Remove the drone picture and reset the matching"
          className="rounded-lg px-2.5 py-1 text-[11.5px] font-semibold"
          style={{ background: `${RED}22`, color: RED, border: `1px solid ${RED}77` }}>Reset</button>
      </div>
    )}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)] items-center gap-2 md:gap-5">
        <div className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-1 text-[12px] font-bold">
            <span style={{ color: AMBER }}>🛰 DRONE SAW THIS</span>
            {tag && <span className="text-[11px]" style={{ color: tag[1] }}>{tag[0]}</span>}
          </div>
          {pic?.src
            ? <img src={pic.src} alt="Drone picture" className="aspect-square w-full rounded-xl bg-black object-contain" />
            : <div className="flex aspect-square w-full items-center justify-center rounded-xl text-center text-[11px] text-muted" style={PANEL}>{t ? 'no drone picture' : 'waiting for the drone to see plastic'}</div>}
          {pic && (pic.cls || Number.isFinite(pic.conf)) && (
            <div className="mt-1 truncate text-[11px] text-muted">
              {pic.cls || 'plastic'}{Number.isFinite(pic.conf) ? ` · ${pctOf(pic.conf)}%` : ''}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col items-center justify-center text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Step 3 · same waste?</div>
          <div className="mt-1 flex items-center gap-2 text-[22px] font-bold text-muted md:text-[26px]">
            <span>⟵</span><span className="text-[13px] md:text-[14px]">compare</span><span>⟶</span>
          </div>
          <div className="mt-1 text-[18px] font-bold leading-tight md:text-[22px]" style={{ color: verdict[1] }}>{verdict[0]}</div>
          <div className="mt-1 font-mono text-[40px] font-bold leading-none tnum md:text-[54px]" style={{ color: Number.isFinite(score) ? verdict[1] : GREY }}>
            {Number.isFinite(score) ? `${pctOf(score)}%` : '—'}
          </div>
          <div className="relative mt-2 h-3 w-full rounded-full bg-black/40">
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Number.isFinite(score) ? Math.min(100, score * 100) : 0}%`, background: verdict[1] }} />
            <div className="absolute -top-1 h-5 w-[3px] rounded bg-white" style={{ left: `${thr * 100}%` }} title="needed" />
          </div>
          <div className="mt-1 text-[11px] text-muted">needs {pctOf(thr)}% (white line)</div>
          {parts && Number.isFinite(score) && (
            <div className="mt-1.5 flex flex-wrap justify-center gap-x-2.5 gap-y-0.5 text-[11px] font-bold" title="What the score is made of: how alike the two pictures look (most of it), whether both AIs call it the same kind, and how sure the boat's AI is">
              {Number.isFinite(parts.look) && <span style={{ color: parts.look >= 0.5 ? GREEN : AMBER }}>look {pctOf(parts.look)}%</span>}
              {Number.isFinite(parts.cls) && (
                <span style={{ color: parts.cls >= 0.95 ? GREEN : parts.cls >= 0.5 ? GREY : RED }}>
                  {parts.cls >= 0.95 ? 'same kind' : parts.cls >= 0.5 ? 'kind unknown' : `different kind${parts.label ? ` (${parts.label})` : ''}`}
                </span>
              )}
              {Number.isFinite(parts.shape) && <span style={{ color: parts.shape >= 0.7 ? GREEN : AMBER }}>bottle shape {parts.shape >= 0.7 ? '✓' : '~'}</span>}
              {Number.isFinite(parts.det) && <span className="text-muted">boat AI {pctOf(parts.det)}%</span>}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-right text-[12px] font-bold" style={{ color: BLUE }}>BOAT SEES THIS 🚤</div>
          <BoatCrop thr={thr} />
        </div>
      </div>
      <div className="mt-3 rounded-xl px-3 py-2" style={PANEL}>
        <div className="flex items-center justify-between text-[12px] font-bold">
          <label htmlFor="match-thr" className="text-muted">Match threshold</label>
          <span className="font-mono tnum" style={{ color: thrSaving ? AMBER : 'var(--ink, #e8eef4)' }}>
            {pctOf(thr)}%{thrSaving ? ' · saving…' : ''}
          </span>
        </div>
        <input id="match-thr" type="range" min={20} max={95} step={1} value={Math.round(thr * 100)}
          onChange={(e) => onThr(Number(e.target.value) / 100)}
          className="mt-1 w-full" style={{ accentColor: GREEN }}
          aria-label="Match threshold: how alike the boat's view must be to the drone's photo" />
        <div className="flex justify-between text-[10.5px] text-muted">
          <span>looser: matches more</span><span>stricter: fewer false matches</span>
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
    <Card title="Live messages" right={<span className="text-[12px] text-muted">newest on top</span>} className="flex min-h-0 flex-1 flex-col" bodyClass="flex min-h-0 flex-1 flex-col !p-2">
      <div className="min-h-[200px] flex-1 overflow-y-auto pr-1" style={{ maxHeight: '46vh' }}>
        {list.length ? list.map((e, i) => {
          const [ic, c] = iconOf(e.text || '', e.level)
          return (
            <div key={`${e.t}|${e.text}`} className="mb-0.5 flex gap-2.5 rounded-lg px-2.5 py-2"
              style={i === 0 ? { background: `${c}14`, border: `1px solid ${c}40` } : { borderBottom: '1px solid var(--sx-line)' }}>
              <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: c }} title={ic} />
              <div className="min-w-0 flex-1">
                <div className={`${i === 0 ? 'text-[14.5px] font-semibold' : 'text-[13.5px]'} leading-snug text-ink`}>{e.text}</div>
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
function Big({ k, busy, color, onClick, children, solid, icon }) {
  return (
    <button type="button" disabled={busy === k} onClick={onClick}
      className="inline-flex h-12 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold tracking-tight transition active:scale-[0.98] disabled:opacity-50"
      style={solid ? { background: color, color: '#fff', boxShadow: `0 8px 18px -10px ${color}` } : { background: 'var(--sx-card)', color: 'var(--sx-ink)', border: '1px solid var(--sx-line2)' }}>
      {busy === k ? '…' : <>{icon}{children}</>}
    </button>
  )
}

/** An on/off setting shown as a labelled switch. */
function Toggle({ k, busy, on, label, value, onClick }) {
  return (
    <button type="button" disabled={busy === k} onClick={onClick} aria-pressed={on}
      className="flex h-12 items-center justify-between gap-3 rounded-xl px-4 text-left transition disabled:opacity-50"
      style={{ background: 'var(--sx-card)', border: `1px solid ${on ? `${GREEN}66` : 'var(--sx-line2)'}` }}>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold leading-tight text-ink">{label}</span>
        <span className="block truncate text-[11.5px] text-muted">{busy === k ? 'Saving…' : value}</span>
      </span>
      <span className="relative h-5 w-9 shrink-0 rounded-full transition-colors" style={{ background: on ? GREEN : 'var(--sx-line2)' }}>
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all" style={{ left: on ? 18 : 2 }} />
      </span>
    </button>
  )
}

const ICON_STOP = <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" /></svg>
const ICON_PLAY = <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" /></svg>
const ICON_PAUSE = <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" /></svg>

function SmallBtn({ k, busy, color = BLUE, onClick, children }) {
  return (
    <button type="button" disabled={!!busy} onClick={onClick} className="rounded-xl py-2.5 text-[13px] font-semibold disabled:opacity-50"
      style={{ background: `${color}22`, color, border: `1px solid ${color}77` }}>{busy === k ? '…' : children}</button>
  )
}

function Controls({ ops }) {
  const { busy, run } = useRun()
  const live = ops.live?.state
  const auto = ops.auto?.settings?.auto_collect
  const motor = ops.motor || {}
  const autoMotor = ops.auto?.settings?.motor_on_signal ?? motor.enabled ?? true
  const going = live === 'running' || live === 'returning'
  return (
    <div className="grid grid-cols-2 gap-2 rounded-[14px] p-2 sm:grid-cols-4" style={PANEL}>
      <Big busy={busy} k="stop" color={RED} solid icon={ICON_STOP} onClick={() => run('stop', boatApi.hold, 'Boat stopped')}>Stop</Big>
      {going
        ? <Big busy={busy} k="pause" color={AMBER} solid icon={ICON_PAUSE} onClick={() => run('pause', boatApi.livePause, 'Boat paused')}>Pause</Big>
        : <Big busy={busy} k="start" color={GREEN} solid icon={ICON_PLAY} onClick={() => run('start', () => boatApi.liveStart({ whenEmpty: 'wait' }), 'Started — the boat will go to each waste the drone finds')}>Start collecting</Big>}
      <Toggle busy={busy} k="auto" on={!!auto} label="Auto scoop" value={auto ? 'Scoops when it matches' : 'Off'}
        onClick={() => run('auto', () => boatApi.opsSettings({ auto_collect: !auto }), auto ? 'Auto scoop OFF' : 'Auto scoop ON')} />
      <Toggle busy={busy} k="motor" on={!!autoMotor} label="Auto motor" value={autoMotor ? (motor.on ? `Running ${motor.power_pct}%` : 'Runs for real plastic') : 'Off'}
        onClick={() => run('motor', () => boatApi.opsSettings({ motor_on_signal: !autoMotor }), autoMotor ? 'Auto motor OFF' : 'Auto motor ON')} />
    </div>
  )
}


/** The AI captain on the boat phone (VARUNA Boat Link 2.4+). The laptop sends it
 *  the plastic / home / bin once a second; full control is switched on only on
 *  the phone itself, so here there is just its state and STOP. */
const CAPTAIN_MODE = {
  watch_only: ['WATCH ONLY', 'advises, does not drive'],
  full_waiting: ['FULL CONTROL', 'waiting for its checks'],
  full_driving: ['DRIVING', 'the AI captain is steering the boat'],
}

function CaptainCard({ ops }) {
  const { busy, run } = useRun()
  const cf = ops.captain
  if (!cf || !cf.phone) return null
  const c = cf.captain
  const ctl = c?.control || (c ? 'watch_only' : null)
  const [word, sub] = ctl ? (CAPTAIN_MODE[ctl] || [ctl, '']) : ['NOT SEEN', cf.error ? 'boat phone not answering' : 'needs Boat Link 2.4 on the boat phone']
  const color = ctl === 'full_driving' ? GREEN : ctl === 'full_waiting' ? AMBER : ctl ? BLUE : GREY
  const full = ctl === 'full_driving' || ctl === 'full_waiting'
  const steer = Number(c?.steer)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] px-4 py-3" style={{ ...PANEL, borderLeft: `4px solid ${color}` }}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${color}1a`, color }}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.5" /><path d="M12 3.5v6M12 14.5v6M3.5 12h6M14.5 12h6" /></svg>
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold leading-tight text-ink">
            AI captain
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${ctl === 'full_driving' ? 'animate-pulse' : ''}`} style={{ background: `${color}1f`, color }}>{word}</span>
            <span className="text-[13px] font-normal text-muted">{sub}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-muted">
            {c?.ready
              ? <>wants throttle <b className="tnum">{pctOf(Number(c.throttle)) ?? '—'}%</b>, steer <b className="tnum">{Number.isFinite(steer) ? `${steer >= 0 ? 'R' : 'L'} ${Math.abs(steer).toFixed(2)}` : '—'}</b> · {c.goal || '—'}
                {c.nearest_plastic_m != null && <> · plastic {n1(c.nearest_plastic_m)} m</>}{c.home_m != null && <> · home {Math.round(c.home_m)} m</>}</>
              : c ? <>not ready: {c.why || c.error || '—'}</> : null}
            {' '}· sent {cf.plastic} plastic{cf.last_sent_s != null ? ` ${n1(cf.last_sent_s)} s ago` : ''}{cf.error ? ` · ${cf.error}` : ''}
          </div>
          {c?.note && <div className="mt-0.5 text-[12px] font-semibold" style={{ color: AMBER }}>{c.note}</div>}
        </div>
      </div>
      <button type="button" disabled={busy === 'cap-stop' || !c} onClick={() => run('cap-stop', boatApi.opsCaptainStop, 'AI captain stopped — watch only')}
        className="rounded-xl px-4 py-2.5 text-[14px] font-semibold disabled:opacity-50"
        style={full ? { background: RED, color: '#fff' } : { background: 'var(--sx-card)', color: RED, border: `1px solid ${RED}66` }}>
        {busy === 'cap-stop' ? '…' : 'Stop captain'}
      </button>
    </div>
  )
}

/** The relay LED strip + buzzer that flash when the drone finds plastic: test / stop. */
function AlertRelay({ ops }) {
  const { busy, run } = useRun()
  const alt = ops.alert || {}
  const color = alt.on ? RED : (alt.enabled ? GREEN : GREY)
  return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] px-4 py-3" style={{ ...PANEL, borderLeft: `4px solid ${color}` }}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${alt.on ? 'animate-pulse' : ''}`} style={{ background: color }} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold leading-tight text-ink">
              Alert light and buzzer
              <span className="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider" style={{ background: `${color}1f`, color }}>
                {alt.on ? `Pulsing · ${alt.left_s}s left` : (alt.enabled ? 'Standby' : 'Disabled')}
              </span>
            </div>
            <div className="mt-0.5 text-[12.5px] text-muted">The relay flashes the LED strip and sounds the buzzer when the drone finds plastic (AUX 1 / pin 50).</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy === 'alt-test'} onClick={() => run('alt-test', () => boatApi.opsAlert('test'), 'Visual alert test started')}
            className="sx-btn ghost sm disabled:opacity-50">Test</button>
          <button type="button" disabled={busy === 'alt-stop'} onClick={() => run('alt-stop', () => boatApi.opsAlert('stop'), 'Alert stopped')}
            className="rounded-[10px] px-3.5 py-2 text-[13.5px] font-semibold text-white transition active:scale-95 disabled:opacity-50" style={{ background: RED }}>
            Stop alert
          </button>
        </div>
      </div>
  )
}

/**
 * What the boat's own camera is doing right now. The operator should be able to
 * see at a glance why the motor is running — or why it is not.
 */
function cameraState(cc) {
  if (!cc) return null
  const d = cc.distance_m
  const words = {
    idle: cc.enabled ? 'Watching for plastic' : 'Off',
    approach: d != null ? `Going for plastic, ${d.toFixed(1)} m` : 'Going for plastic',
    collecting: 'Scooping',
    cooldown: 'Collected, ready for the next',
  }
  const colour = { approach: BLUE, collecting: GREEN, cooldown: GREEN }[cc.state] || (cc.enabled ? GREEN : GREY)
  return [`${words[cc.state] || cc.state}${cc.collected ? ` · ${cc.collected} collected` : ''}`, colour, cc.why || '']
}

function Health({ ops }) {
  const px = ops.pixhawk || {}
  const ph = ops.phone || {}
  const mot = ops.motor || {}
  const cam = cameraState(ops.camera_collect)
  return (
    <Card title="Boat status" right={<span className="text-[12px] text-muted">Hand control: flip <b className="text-ink">SwD</b> on the FS-i6</span>}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatusItem label={brainLabel(ph)} value={px.connected ? (px.armed ? 'Armed' : 'Ready') : 'Lost'} color={px.connected ? (px.armed ? AMBER : GREEN) : RED} />
        <StatusItem label="Phone GPS" value={ph.gps_ok ? `±${n1(ph.accuracy_m, 0)} m` : 'No fix'} color={ph.gps_ok ? GREEN : RED} />
        <StatusItem label="Camera" value={ops.camera?.connected ? 'On' : 'Off'} color={ops.camera?.connected ? GREEN : RED} />
        <StatusItem label="Mode" value={px.mode || '—'} color={BLUE} />
        <StatusItem label="Speed" value={`${n1(px.speed_mps)} m/s`} color={BLUE} />
        <StatusItem label="Motor" value={mot.on ? `${mot.power_pct}% (${mot.left_s}s)` : mot.enabled ? 'Ready' : 'Off'} color={mot.on ? BLUE : mot.enabled ? GREEN : GREY} />
        {cam && <StatusItem wide label="Boat camera" value={cam[0]} color={cam[1]} />}
      </div>
    </Card>
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
        {'camera_scoop_inside' in s && (
          <>
            <label className="flex items-center gap-2 py-1 text-[13px]">
              <input type="checkbox" checked={s.camera_scoop_inside !== false} onChange={(e) => save({ camera_scoop_inside: e.target.checked })} /> Only scoop when the waste is trapped inside the scoop
            </label>
            {s.camera_scoop_inside !== false && 'camera_scoop_seen_first' in s && (
              <label className="flex items-center gap-2 py-1 pl-5 text-[12.5px]">
                <input type="checkbox" checked={!!s.camera_scoop_seen_first} onChange={(e) => save({ camera_scoop_seen_first: e.target.checked })} /> …and only if the camera saw it on the water first (off: a bottle put straight into the scoop counts)
              </label>
            )}
            {s.camera_scoop_inside !== false && (
              <div className="mt-1 rounded-xl px-3 py-2" style={PANEL}>
                <div className="mb-1 text-[12px] font-bold text-muted">Scoop area in the boat camera picture (the dashed box)</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {[['scoop_zone_x1', 'Left edge'], ['scoop_zone_x2', 'Right edge'], ['scoop_zone_y1', 'Top edge'], ['scoop_zone_y2', 'Bottom edge']].map(([k, label]) => (
                    <label key={k} className="flex items-center justify-between gap-2 text-[12.5px]">
                      <span className="text-muted">{label}</span>
                      <select value={Math.round((s[k] ?? 0) * 100)} onChange={(e) => save({ [k]: Number(e.target.value) / 100 })} className="rounded bg-black/30 px-1.5 py-0.5 text-ink">
                        {Array.from({ length: 21 }, (_, i) => i * 5).map((v) => <option key={v} value={v}>{v}%</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="mt-1 text-[11px] text-muted">0% = left / top of the picture, 100% = right / bottom. Move the box until it sits over the scoop&apos;s mouth.</div>
              </div>
            )}
          </>
        )}
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
          <div className="text-[32px] font-bold" style={{ color: ms.position ? GREEN : GREY }}>
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
        <label className="flex items-center gap-2 py-1 text-[13px]">
          <input type="checkbox" checked={s.camera_alert ?? true} onChange={(e) => save({ camera_alert: e.target.checked })} /> Blink LED strip & sound buzzer when the boat camera sees plastic
        </label>
        <label className="flex items-center justify-between gap-2 py-1 text-[13px]">
          <span className="text-muted">Alert pulse duration</span>
          <select value={s.alert_duration_s ?? 8} onChange={(e) => save({ alert_duration_s: Number(e.target.value) })} className="rounded bg-black/30 px-2 py-1 text-ink">
            {[3, 5, 8, 10, 15, 20].map((v) => <option key={v} value={v}>{v} seconds</option>)}
          </select>
        </label>
        <div className="mt-2 text-[11.5px] text-muted">
          5V relay on the boat brain (UNO R4: pin D7; Pixhawk: AUX 1 / pin 50) switches the E-minus LED strip and buzzer together in an alert rhythm whenever plastic is detected.
        </div>
      </Card>
    </div>
  )
}

// The phone reports which brain is on its USB: the UNO R4 air-boat brain or a Pixhawk.
function brainLabel(ph) {
  if (ph?.brain === 'uno_r4') return 'Brain (UNO R4)'
  if (ph?.brain === 'pixhawk') return 'Pixhawk'
  return 'Boat brain'
}

function PixhawkPanel({ ops }) {
  const px = ops.pixhawk || {}
  const ph = ops.phone || {}
  const r4 = ph.brain === 'uno_r4'
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card title={`${brainLabel(ph)} (USB to the phone)`}>
        <Row k="Connected" v={px.connected ? 'yes' : 'NO'} color={px.connected ? GREEN : RED} />
        <Row k="Armed" v={px.armed ? 'ARMED' : 'no'} color={px.armed ? AMBER : undefined} />
        <Row k="Mode" v={px.mode} />
        <Row k="Speed" v={`${n1(px.speed_mps)} m/s`} />
        <Row k={r4 ? 'Heading (brain: phone compass + GPS course)' : 'Heading (compass)'} v={Number.isFinite(px.heading_deg) ? `${Math.round(px.heading_deg)}°` : '—'} />
        {ph.compass_deg != null && <Row k="Phone compass" v={`${Math.round(ph.compass_deg)}°`} />}
        {ph.compass_calibrate && <Row k="Phone compass" v="CALIBRATE: figure 8, away from the motors" color={AMBER} />}
        <Row k="Boat position (phone GPS)" v={ph.lat != null ? `${fmt8(ph.lat)}, ${fmt8(ph.lng)}` : '—'} />
      </Card>
      <Card title={`${brainLabel(ph)} says`}>
        {(px.messages || []).length ? [...px.messages].reverse().map((m) => (
          <div key={`${m.t}${m.text}`} className="py-[2px] text-[12.5px]" style={{ color: m.severity <= 3 ? RED : m.severity <= 4 ? AMBER : undefined }}>
            <span className="font-mono text-muted">{clock(m.t)}</span> {m.text}
          </div>
        )) : <div className="text-[12.5px] text-muted">Nothing new.</div>}
      </Card>
    </div>
  )
}

const MORE = [['map', 'Map'], ['list', 'All waste'], ['scoop', 'Scoop'], ['pixhawk', 'Boat brain']]

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
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[13px] font-semibold text-muted">Details</span>
        <div className="sx-seg max-w-full overflow-x-auto" role="tablist" aria-label="Boat details">
          {MORE.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={open === k} aria-pressed={open === k} onClick={() => pick(k)}>{l}</button>
          ))}
        </div>
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
function BoatHeader({ children }) {
  return (
    <TabHeader icon="boat" title="Boat"
      hint="The drone finds plastic, then the boat goes and collects it. Press START to send the boat; STOP always stops it.">
      {children}
    </TabHeader>
  )
}

function NotConnected({ text }) {
  return (
    <div className="relative z-[1] mx-auto max-w-[1600px] px-1 pt-2 md:px-3">
    <BoatHeader><Pill tone="bad">Not connected</Pill></BoatHeader>
    <div className="mx-auto mt-8 max-w-[560px] rounded-[14px] p-7 text-center" style={PANEL}>
      <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl" style={{ background: `${AMBER}1a`, color: AMBER }}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 15l2.5 4h13L21 15H3z" /><path d="M12 4v11M12 5l6 7h-6" /></svg>
      </span>
      <h2 className="text-[20px] font-bold tracking-tight text-ink">{text}</h2>
      <p className="mt-1 text-[14px] text-muted">This page fills in by itself once the boat answers.</p>
      <ol className="mx-auto mt-5 max-w-[420px] space-y-2 text-left text-[14px] text-ink">
        {['Plug the boat brain into the boat phone (USB-C / OTG).', 'Open VARUNA Boat Link on the phone.', 'On the laptop, run Start VARUNA Boat.'].map((step, i) => (
          <li key={step} className="sx-well flex items-center gap-3 px-3 py-2.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-bold" style={{ background: 'var(--sx-accent-soft)', color: 'var(--sx-accent-text)' }}>{i + 1}</span>
            {step}
          </li>
        ))}
      </ol>
    </div>
    </div>
  )
}

export default function BoatOpsScreen() {
  const boat = useBoat()
  const reachable = boat.reachable === true
  const { ops, ageMs } = useOpsStatus(reachable)
  // Reset clears the picture; the drone's NEXT picture shows again (even of
  // the same waste). It also hides the boat's current target picture.
  const [resetAt, setResetAt] = useState(0)
  const [dismissed, setDismissed] = useState(() => new Set())
  const [held, setHeld] = useState(null)
  const localRaw = useLocalDroneCrop()
  const local = held || (localRaw && localRaw.at > resetAt ? localRaw : null)
  const target = ops?.target && !dismissed.has(ops.target.id) ? ops.target : null
  const homingId = useBoatHomingId()
  // While the boat itself homes onto a drone find, the camera AI matches against
  // that find's picture, so the card shows that one. Otherwise: the live picture.
  let pic = null
  if (homingId && !dismissed.has(homingId)) {
    pic = { kind: 'boat', id: homingId, src: boatUrls.liveReference(homingId), cls: target?.id === homingId ? target.object_class || null : null }
  } else if (local) {
    pic = { kind: 'live', id: local.id, key: local.key, src: local.crop, crop: local.crop, cls: local.cls, conf: local.conf, at: local.at }
  } else if (target?.has_reference) {
    pic = { kind: 'boat', id: target.id, src: boatUrls.liveReference(target.id), cls: target.object_class || null }
  }
  const [thr, setThr, thrSaving] = useMatchThreshold(ops)
  const { best, matched, parts } = useBestMatch(pic, thr)
  const resetMatch = () => {
    setDismissed((s) => new Set([...s, pic?.kind === 'boat' ? pic.id : null, ops?.target?.id].filter(Boolean)))
    setResetAt(Date.now())
    setHeld(null)
    clearLatestDroneCrop()
  }
  const toggleHold = () => setHeld((h) => (h ? null : localRaw && localRaw.at > resetAt ? localRaw : null))
  if (!reachable) return <NotConnected text="Boat not connected" />
  if (!ops) return <div className="relative z-[1] py-16 text-center text-[15px] text-muted">Connecting to the boat…</div>
  if (ops.missing) return <NotConnected text="Old boat program running — restart it with Start VARUNA Boat" />
  return (
    <div className="relative z-[1] mx-auto flex max-w-[1600px] flex-col gap-3 px-1 pb-8 pt-2 md:px-3">
      <BoatHeader>
        <Pill tone={ops.pixhawk?.connected ? 'ok' : 'bad'}>{ops.pixhawk?.connected ? (ops.pixhawk?.armed ? 'Armed' : 'Boat ready') : 'Boat brain offline'}</Pill>
        <Pill tone={ops.live?.state === 'running' ? 'info' : ''} pulse={ops.live?.state === 'running'}>{ops.live?.state === 'running' ? 'Collecting' : ops.live?.state === 'returning' ? 'Coming home' : 'Stopped'}</Pill>
      </BoatHeader>
      {ageMs > 4000 && ageMs !== Infinity && (
        <div className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-semibold" style={{ background: `${AMBER}14`, border: `1px solid ${AMBER}55`, color: AMBER }}>
          {WARN_ICON} No update from the boat for {Math.round(ageMs / 1000)} s
        </div>
      )}
      <Alerts alerts={ops.alerts} />
      <Hero ops={ops} matched={matched} />
      {/* The main job first: the big buttons. */}
      <Controls ops={ops} />
      <CaptainCard ops={ops} />
      {/* The drone's and the boat's live views, the same size side by side. */}
      <div className="grid gap-3 md:grid-cols-2">
        <DroneLive />
        <LiveCamera ops={ops} thr={thr} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <Health ops={ops} />
          <MatchCard ops={ops} target={target} pic={pic} held={!!held} best={best} parts={parts} thr={thr} onThr={setThr} thrSaving={thrSaving} onReset={resetMatch} onHold={toggleHold} />
        </div>
        <Messages events={ops.events} />
      </div>
      <MoreOptions id="boat" title="More options" hint="map, waste list, scoop, boat brain, alert light and buzzer">
        <div className="flex flex-col gap-3 pt-1">
          <AlertRelay ops={ops} />
          <More ops={ops} reachable={reachable} />
        </div>
      </MoreOptions>
    </div>
  )
}
