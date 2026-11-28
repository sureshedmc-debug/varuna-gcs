import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { boatApi, boatUrls } from '../api/boatClient'
import { useBoat } from '../components/BoatContext'
import { useBoatVision } from '../components/BoatVisionContext'
import { useToast } from '../components/Toast'
import { usePolling, useNow } from '../hooks/usePolling'
import { getLatestFrame, getVisionState, subscribeVision } from '../lib/boatVision'
import { boxDistance } from '../lib/boatCamera'
import { estimateWeightG, fmtWeight } from '../lib/sizeEstimate'
import { isOk } from '../lib/commands'
import { relTime } from '../lib/format'
import { Chip, HOMING_LABEL, NlBoatOffline, Switch, Tile } from '../components/BoatLabParts'
import VarunaBot from '../components/bot/VarunaBot'
import { LevelIcon, kindLabel } from '../components/bot/botUi'
import { assistantSays, botLevel, setDemo, setMuted, summonAssistant, useBotState } from '../lib/assistant/botStore'
import { getBoatSnapshot, runBoatCommand } from '../lib/assistant/boatCommands'
import './boatVision.css'

// Boat Vision: the boat's live camera with the VARUNA Assistant beside it.
// The AI captain drives; the robot is the messenger: it tells you what the
// boat sees and does (pop-ups in the list + voice) and takes your commands
// (mic, typed, or the three quick buttons). Stop is always one tap.
// Everything the old tab had is still here, under "Advanced".

// Overlay colours on the camera picture (drawn on video, so fixed, not themed).
const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const RED = '#FF453A'
const CYAN = '#5AC8FA'

// ── Camera view: the latest frame with what the AI sees drawn on top ──────────
function CameraCanvas({ engine, cfg, vision }) {
  const ref = useRef(null)
  const stateRef = useRef({ engine, cfg, vision })
  stateRef.current = { engine, cfg, vision }

  useEffect(() => {
    let raf
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const cv = ref.current
      if (!cv) return
      const r = cv.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(2, Math.round(r.height * dpr))
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H }
      const ctx = cv.getContext('2d')
      ctx.clearRect(0, 0, W, H)
      const bmp = getLatestFrame()
      const { engine: e, cfg: c, vision: v } = stateRef.current
      if (!bmp || !e?.frame || !c) return
      const fw = e.frame.w, fh = e.frame.h
      const k = Math.min(W / fw, H / fh)
      const dw = fw * k, dh = fh * k, ox = (W - dw) / 2, oy = (H - dh) / 2
      ctx.drawImage(bmp, ox, oy, dw, dh)
      const X = (x) => ox + x * k
      const Y = (y) => oy + y * k
      const font = Math.max(11, Math.round(12 * dpr))
      ctx.font = `600 ${font}px Inter, system-ui, sans-serif`
      ctx.textBaseline = 'middle'

      // Ramp band and counting line
      const rampY = (c.ramp_top ?? 0.78) * fh
      const lineY = rampY + (c.count_line ?? 0.55) * (fh - rampY)
      ctx.setLineDash([6 * dpr, 5 * dpr])
      ctx.lineWidth = 1.5 * dpr
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.beginPath(); ctx.moveTo(X(0), Y(rampY)); ctx.lineTo(X(fw), Y(rampY)); ctx.stroke()
      ctx.strokeStyle = CYAN
      ctx.beginPath(); ctx.moveTo(X(fw * 0.12), Y(lineY)); ctx.lineTo(X(fw * 0.88), Y(lineY)); ctx.stroke()
      ctx.setLineDash([])
      label(ctx, 'COUNTING LINE', X(fw * 0.12), Y(lineY) - 10 * dpr, CYAN, font * 0.8)

      // Ramp motion (catch counter)
      for (const t of e.tracks || []) {
        ctx.strokeStyle = t.counted ? GREEN : CYAN
        ctx.lineWidth = 2 * dpr
        ctx.strokeRect(X(t.x * fw), Y(rampY + t.y * (fh - rampY)), t.w * fw * k, t.h * (fh - rampY) * k)
      }

      // Plastic targets
      const homing = v?.homing?.state && v.homing.state !== 'idle'
      for (const b of e.targets || []) {
        const d = boxDistance(c, b, fw, fh)
        drawBox(ctx, X(b.x1), Y(b.y1), (b.x2 - b.x1) * k, (b.y2 - b.y1) * k, GREEN, homing ? 3 * dpr : 2 * dpr,
          `${b.label} ${Math.round((b.score || 0) * 100)}%${d != null ? ` · ${d.toFixed(1)} m` : ''}`, font)
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={ref} className="h-full w-full" />
}

function label(ctx, text, x, y, color, size) {
  ctx.save()
  ctx.font = `700 ${Math.round(size)}px Inter, system-ui, sans-serif`
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

function drawBox(ctx, x, y, w, h, color, lw, text, font) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.stroke()
  ctx.font = `600 ${font}px Inter, system-ui, sans-serif`
  const tw = ctx.measureText(text).width
  const ph = font + 8
  const py = Math.max(2, y - ph - 4)
  ctx.fillStyle = 'rgba(8,14,26,0.85)'
  ctx.beginPath(); ctx.roundRect(x, py, tw + 16, ph, ph / 2); ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.fillText(text, x + 8, py + ph / 2)
  ctx.restore()
}

// ── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS = [
  { key: 'homing_start_m', label: 'Homing starts within', unit: 'm', min: 3, max: 20, step: 0.5 },
  { key: 'homing_speed_mps', label: 'Homing speed', unit: 'm/s', min: 0.2, max: 1.5, step: 0.1 },
  { key: 'homing_search_s', label: 'Give up searching after', unit: 's', min: 5, max: 120, step: 5 },
  { key: 'bin_capacity_items', label: 'Bin holds about', unit: 'items', min: 5, max: 2000, step: 5 },
  { key: 'motion_sensitivity', label: 'Ramp motion sensitivity', unit: '', min: 0.05, max: 1, step: 0.05 },
  { key: 'camera_height_m', label: 'Camera height above water', unit: 'm', min: 0.1, max: 3, step: 0.05 },
  { key: 'camera_tilt_deg', label: 'Camera tilt below horizon', unit: '°', min: 5, max: 85, step: 1 },
  { key: 'camera_hfov_deg', label: 'Camera field of view', unit: '°', min: 30, max: 130, step: 1 },
]

function SettingsPanel({ cfg, updateConfig, toast }) {
  const [draft, setDraft] = useState({})
  const [busy, setBusy] = useState(false)
  const val = (k) => (draft[k] ?? cfg?.[k])
  const dirty = Object.keys(draft).length > 0
  async function save() {
    setBusy(true)
    try {
      const res = await updateConfig(draft)
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || 'Not saved' }, 'Vision settings saved on the boat')
      if (isOk(res)) setDraft({})
    } catch (e) {
      toast.push({ level: 'bad', title: `Not saved: ${e?.message || e}` })
    } finally {
      setBusy(false)
    }
  }
  if (!cfg) return <div className="nl-text nl-muted">Settings load once the boat answers.</div>
  return (
    <div className="nl-card flex flex-col gap-2.5">
      <label className="flex items-center justify-between gap-2 nl-text" htmlFor="vision-lost">
        <span>If the camera link drops</span>
        <select id="vision-lost" value={val('on_vision_lost')} onChange={(e) => setDraft({ ...draft, on_vision_lost: e.target.value })} className="nl-select">
          <option value="slow">Slow down</option>
          <option value="hold">Hold position</option>
          <option value="continue">Carry on (GPS only)</option>
        </select>
      </label>
      {SETTINGS.map((s) => (
        <label key={s.key} className="flex flex-col gap-1" htmlFor={`vs-${s.key}`}>
          <span className="flex justify-between nl-text">
            <span>{s.label}</span>
            <span className="nl-num font-bold">{Number(val(s.key)).toFixed(s.step < 1 ? (s.step < 0.1 ? 2 : 1) : 0)} {s.unit}</span>
          </span>
          <input id={`vs-${s.key}`} type="range" min={s.min} max={s.max} step={s.step} value={val(s.key) ?? s.min}
            onChange={(e) => setDraft({ ...draft, [s.key]: Number(e.target.value) })} className="nl-range" />
        </label>
      ))}
      <div className="flex gap-2">
        <button className="nl-btn flex-1" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save on the boat'}</button>
        <button className="nl-btn ghost" disabled={!dirty || busy} onClick={() => setDraft({})}>Undo</button>
      </div>
    </div>
  )
}

// The vision engine's full, live state (boxes, fps, counts) - this screen only.
function useVisionEngine() {
  const [e, setE] = useState(getVisionState)
  useEffect(() => subscribeVision(setE), [])
  return e
}

// ── Demo feed: a pretend boat camera for demo mode ───────────────────────────
function DemoFeed() {
  const ref = useRef(null)
  useEffect(() => {
    let raf
    const t0 = performance.now()
    const draw = (now) => {
      raf = requestAnimationFrame(draw)
      const cv = ref.current
      if (!cv) return
      const r = cv.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(2, Math.round(r.height * dpr))
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H }
      const ctx = cv.getContext('2d')
      const t = (now - t0) / 1000
      const hz = H * 0.36
      // sky + far bank
      let g = ctx.createLinearGradient(0, 0, 0, hz)
      g.addColorStop(0, '#b9dcf0'); g.addColorStop(1, '#e8f3f8')
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz)
      ctx.fillStyle = '#6f9a72'
      ctx.beginPath(); ctx.moveTo(0, hz)
      for (let x = 0; x <= W; x += W / 24) ctx.lineTo(x, hz - (10 + 14 * Math.sin(x / W * 9 + 1) + 8 * Math.sin(x / W * 23)) * dpr)
      ctx.lineTo(W, hz); ctx.fill()
      // water
      g = ctx.createLinearGradient(0, hz, 0, H)
      g.addColorStop(0, '#5f8fa3'); g.addColorStop(1, '#2d5466')
      ctx.fillStyle = g; ctx.fillRect(0, hz, W, H - hz)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1.2 * dpr
      for (let i = 0; i < 26; i++) {
        const y = hz + Math.pow((i + ((t * 0.35) % 1)) / 26, 1.7) * (H - hz)
        const amp = 2 + (y - hz) / (H - hz) * 6
        ctx.beginPath()
        for (let x = 0; x <= W; x += 12 * dpr) ctx.lineTo(x, y + Math.sin(x / (40 * dpr) + t * 1.6 + i) * amp * dpr * 0.5)
        ctx.stroke()
      }
      // the plastic the demo captain is heading for
      const d = getBoatSnapshot().demo
      if (d?.dist != null) {
        const k = Math.max(0.12, Math.min(1, 3 / d.dist))
        const cx = W * (0.5 + Math.sin(t * 0.5) * 0.06), cy = hz + (H - hz) * (0.12 + 0.55 * k)
        const bw = 34 * dpr * (0.6 + k * 2.2), bh = bw * 0.42
        ctx.save(); ctx.translate(cx, cy + Math.sin(t * 2) * 2 * dpr); ctx.rotate(-0.25)
        ctx.fillStyle = 'rgba(230,245,255,0.92)'; ctx.beginPath(); ctx.roundRect(-bw / 2, -bh / 2, bw, bh, bh / 2); ctx.fill()
        ctx.fillStyle = '#3b82f6'; ctx.fillRect(bw / 2 - bh * 0.2, -bh * 0.22, bh * 0.45, bh * 0.44)
        ctx.restore()
        const font = Math.max(11, Math.round(12 * dpr))
        drawBox(ctx, cx - bw * 0.75, cy - bh * 1.4, bw * 1.5, bh * 2.8, GREEN, 2.5 * dpr, `plastic bottle · ${d.dist} m`, font)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} className="h-full w-full" />
}

// ── small pieces ─────────────────────────────────────────────────────────────
function Stat({ label, value, tone }) {
  return (
    <div className={`bv2-stat ${tone || ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

function timeAgo(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 5 ? 'now' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

function Feed({ feed }) {
  const now = useNow(5000)
  if (!feed.length) {
    return (
      <div className="bv2-empty">
        <b>No messages yet</b>
        <span>When the boat finds plastic, catches it, or needs you, I’ll tell you here and out loud.</span>
      </div>
    )
  }
  return (
    <ol className="bv2-feed" aria-live="polite">
      <AnimatePresence initial={false}>
        {feed.slice(0, 40).map((m) => (
          <motion.li key={m.id} layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`bv2-msg lv-${m.level}`}>
            <span className="bv2-msg-ic"><LevelIcon level={m.level} size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="bv2-msg-who">{kindLabel(m.kind)}<span>{timeAgo(m.t, now)}</span></div>
              <div className="bv2-msg-txt">{m.text}</div>
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  )
}

const MOOD_WORD = { idle: 'Watching the boat', sleep: 'Watching the boat', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', happy: 'Got it!', alert: 'Attention!', error: 'Needs attention' }

// ── the old tools, kept whole behind "Advanced" ───────────────────────────────
function AdvancedTools({ onNavigate, onClose }) {
  const boat = useBoat()
  const bv = useBoatVision()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const [tab, setTab] = useState('live') // live | settings
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const online = bv.online
  const e = useVisionEngine() || {}
  const v = bv.vision
  const cfg = bv.cfg

  const catchPoll = usePolling(() => (online ? boatApi.catchSummary(12) : Promise.resolve(null)), 3000, [online])
  const catchData = catchPoll.data && !catchPoll.data._httpError ? catchPoll.data : null
  const weightG = useMemo(() => {
    const by = catchData?.today?.by_label || {}
    return Object.entries(by).reduce((a, [lbl, n]) => a + estimateWeightG(lbl, n), 0)
  }, [catchData])

  async function run(key, fn, okMsg) {
    setBusy(key)
    try {
      const res = await fn()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || 'Failed' }, okMsg)
      catchPoll.refresh()
    } catch (err) {
      toast.push({ level: 'bad', title: `Command failed: ${err?.message || err}` })
    } finally {
      setBusy(null)
    }
  }

  const homing = v?.homing
  const hm = HOMING_LABEL[homing?.state] || HOMING_LABEL.idle
  const linkAlive = v?.link?.alive
  const bin = catchData?.bin || v?.catch?.bin
  const binPct = Math.min(100, bin?.pct || 0)
  const byLabel = Object.entries(catchData?.today?.by_label || {}).sort((a, b) => b[1] - a[1])
  const maxLabel = byLabel.length ? byLabel[0][1] : 1

  return (
    <motion.aside className="bv2-drawer nl" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      role="dialog" aria-label="Advanced boat vision tools">
      <div className="bv2-drawer-head">
        <div>
          <b>Advanced tools</b>
          <span>Camera AI numbers, homing, catch log, tests and settings.</span>
        </div>
        <button type="button" className="vb-iconbtn" onClick={onClose} aria-label="Close advanced tools">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <div className="bv2-drawer-body">
        {!online ? (
          <NlBoatOffline boat={boat} onNavigate={onNavigate} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Chip tone={bv.cameraUp ? 'ok' : 'bad'} dot>{bv.cameraUp ? `CAMERA · ${e.frame?.h ? `${e.frame.h}p · ` : ''}${e.fps || 0} FPS` : 'NO CAMERA'}</Chip>
              {bv.enabled && <Chip tone={linkAlive ? 'ok' : 'warn'} dot pulse={!linkAlive}>{linkAlive ? 'BOAT SEES AI' : 'AI NOT REACHING BOAT'}</Chip>}
              {e.sim && <Chip tone="warn" title="In the simulator the boat reports where its drawn items are; the AI models are not used">SIM DETECTIONS</Chip>}
              {v?.operator_paused && <Chip tone="warn">AUTOMATION PAUSED</Chip>}
            </div>
            <div className="nl-seg mb-3" role="tablist">
              {[['live', 'Live numbers'], ['settings', 'Settings']].map(([id, l]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>
              ))}
            </div>
            {tab === 'settings' ? (
              <div className="flex flex-col gap-3">
                <div className="nl-card flex flex-col gap-2.5">
                  <Switch on={bv.enabled} onChange={bv.setEnabled} label="Run the vision AI in this app" />
                  <Switch on={!!cfg?.homing_enabled} disabled={!cfg} label="Last-metre homing" onChange={(on) => bv.updateConfig({ homing_enabled: on })} />
                </div>
                <SettingsPanel cfg={cfg} updateConfig={bv.updateConfig} toast={toast} />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-2">
                  <Tile label="Camera" value={e.fps || 0} unit="fps" />
                  <Tile label="AI time" value={e.aiMs ?? '—'} unit={e.aiMs != null ? 'ms' : ''} />
                  <Tile label="Sent" value={e.observed || 0} unit="obs" tone={linkAlive ? 'ok' : undefined} />
                </div>
                <div className={`nl-card${homing?.state && homing.state !== 'idle' ? ' live' : ''}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="nl-title">Last-metre homing</span>
                    <Chip tone={cfg?.homing_enabled === false ? 'off' : hm.tone} dot={homing?.state !== 'idle'}>{cfg?.homing_enabled === false ? 'OFF' : hm.label.toUpperCase()}</Chip>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Tile label="Item" value={homing?.item ?? '—'} />
                    <Tile label="Distance" value={homing?.distance_m ?? '—'} unit={homing?.distance_m != null ? 'm' : ''} />
                    <Tile label="Collected" value={`${homing?.collected ?? 0}/${homing?.attempts ?? 0}`} tone="ok" />
                  </div>
                  <div className="mt-2 nl-text nl-muted">
                    {homing?.state && homing.state !== 'idle' ? 'The boat is steering onto the item with the camera.' : `Takes over within ${cfg?.homing_start_m ?? 8} m of each plastic point during a collection.`}
                  </div>
                </div>
                <div className="nl-card">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="nl-title">Catch today</span>
                    <span className="nl-num text-[11px] font-bold nl-muted">{fmtWeight(weightG)}</span>
                  </div>
                  <div className="mb-2 flex items-baseline gap-1.5">
                    <span className="nl-big">{catchData?.today?.total ?? 0}</span>
                    <span className="nl-text nl-muted">items counted</span>
                  </div>
                  {byLabel.map(([lbl, n]) => (
                    <div key={lbl} className="mb-1.5 flex items-center gap-2 nl-text">
                      <span className="w-28 truncate capitalize">{lbl}</span>
                      <div className="nl-track flex-1"><div className="nl-fill" style={{ width: `${(n / maxLabel) * 100}%` }} /></div>
                      <span className="nl-num w-6 text-right font-bold">{n}</span>
                    </div>
                  ))}
                  <div className="mt-2 flex items-center justify-between nl-text">
                    <span className="nl-label">Bin</span>
                    <span className="nl-num font-bold" style={{ color: binPct >= 100 ? 'var(--nl-bad)' : binPct >= 90 ? 'var(--nl-warn)' : undefined }}>
                      {bin?.count ?? 0} / {bin?.capacity ?? '—'} · {binPct}%
                    </span>
                  </div>
                  <div className="nl-track mt-1" style={{ height: 8 }}>
                    <div className={`nl-fill ${binPct >= 100 ? 'bad' : binPct >= 90 ? 'warn' : 'ok'}`} style={{ width: `${binPct}%` }} />
                  </div>
                  <div className="mt-2.5">
                    {confirmEmpty ? (
                      <div className="flex items-center gap-2 nl-text">
                        <span className="flex-1">Bin emptied on shore?</span>
                        <button className="nl-btn" disabled={!!busy} onClick={() => { setConfirmEmpty(false); run('empty', boatApi.emptyBin, 'Bin count reset') }}>Yes, reset</button>
                        <button className="nl-btn ghost" onClick={() => setConfirmEmpty(false)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="nl-btn soft w-full" disabled={!bin?.count} onClick={() => setConfirmEmpty(true)}>I emptied the bin</button>
                    )}
                  </div>
                </div>
                {(catchData?.items || []).length > 0 && (
                  <div className="nl-card">
                    <div className="mb-2 nl-eyebrow">Just collected</div>
                    <div className="flex flex-col gap-1.5">
                      {catchData.items.slice(0, 4).map((it) => (
                        <div key={it.id} className="nl-row">
                          {it.photo
                            ? <img src={boatUrls.catchPhoto(it.id)} alt="" className="h-8 w-11 shrink-0 rounded-md object-cover" />
                            : <div className="h-8 w-11 shrink-0 rounded-md" style={{ background: '#ede9fe' }} />}
                          <span className="flex-1 truncate text-xs font-semibold capitalize">{it.label}</span>
                          <span className="nl-num shrink-0 text-[10px] nl-faint">{relTime(it.t * 1000)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(v?.events || []).length > 0 && (
                  <div>
                    <div className="mb-1.5 nl-eyebrow">Boat decisions</div>
                    <div className="flex flex-col gap-1">
                      {[...v.events].reverse().map((ev, i) => (
                        <div key={`${ev.t}-${i}`} className="flex gap-2 text-[11px]">
                          <span className="nl-num shrink-0 nl-faint">{relTime(ev.t * 1000)}</span>
                          <span style={{ color: ev.level === 'warn' ? 'var(--nl-warn)' : '#334155' }}>{ev.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 nl-eyebrow">Tests</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button onClick={() => bv.setEnabled(!bv.enabled)} className={`nl-btn ${bv.enabled ? 'on' : 'soft'}`}>{bv.enabled ? '● Vision AI on' : '○ Vision AI off'}</button>
              <button onClick={() => window.open(boatUrls.snapshot(), '_blank')} disabled={!bv.cameraUp} className="nl-btn soft">Snapshot</button>
              <button onClick={() => run('alert', () => boatApi.opsAlert('test'), 'Relay alert rhythm started')} disabled={!!busy} className="nl-btn soft">Test alert (LED + buzzer)</button>
              <button onClick={() => run('alert-stop', () => boatApi.opsAlert('stop'), 'Alert stopped')} disabled={!!busy} className="nl-btn soft">Stop alert</button>
              <button onClick={() => run('motor-test', () => boatApi.opsMotor('test'), 'Motor test started (10-20%)')} disabled={!!busy} className="nl-btn soft">Test motor</button>
              <button onClick={() => run('motor-stop', () => boatApi.opsMotor('stop'), 'Motor stopped')} disabled={!!busy} className="nl-btn soft">Stop motor</button>
              {boat.simulated && <button onClick={() => run('duck', () => boatApi.simDuck(9), 'A duck appeared ahead')} disabled={!!busy} className="nl-btn amber">Sim: duck ahead</button>}
            </div>
          </>
        )}
      </div>
    </motion.aside>
  )
}

// ── Screen ───────────────────────────────────────────────────────────────────
export default function BoatVisionScreen({ onNavigate }) {
  const boat = useBoat()
  const bv = useBoatVision()
  const e = useVisionEngine() || {}
  const mood = useBotState((s) => s.mood)
  const caption = useBotState((s) => s.caption)
  const heard = useBotState((s) => s.heard)
  const gest = useBotState((s) => s.gesture)
  const feed = useBotState((s) => s.feed)
  const muted = useBotState((s) => s.muted)
  const demo = useBotState((s) => s.demo)
  const awake = useBotState((s) => s.awake)
  const [adv, setAdv] = useState(false)
  const [busy, setBusy] = useState(null)
  const [typed, setTyped] = useState('')
  useNow(1000) // refresh the demo numbers

  const online = bv.online
  const t = boat.telemetry.data
  const d = getBoatSnapshot().demo
  const showDemoFeed = demo && !(online && e.frame)
  const live = t?.live?.state
  const bin = t?.vision?.catch?.bin

  const linkPill = demo && !online ? ['Demo', 'info'] : online ? [boat.simulated ? 'Simulator' : 'Live', 'ok'] : boat.reachable === undefined ? ['Connecting…', ''] : ['Boat offline', 'bad']
  const doing = d ? d.doing : !online ? 'Not connected' : live === 'running' ? 'Collecting plastic' : live === 'returning' ? 'Heading home' : live === 'paused' ? 'Paused' : t?.armed ? 'Ready' : 'Waiting'
  const stats = d
    ? [['Bin', `${d.bin}%`, d.bin >= 80 ? 'warn' : ''], ['Collected', d.collected]]
    : online
      ? [['Bin', bin ? `${Math.min(100, Math.round(bin.pct))}%` : '—', bin?.pct >= 80 ? 'warn' : ''], ['Collected', t?.live?.counts?.collected ?? 0]]
      : []

  async function command(id) {
    setBusy(id)
    try {
      const res = await runBoatCommand(id)
      assistantSays(res.text, res.ok ? 'ok' : 'warn')
    } finally {
      setBusy(null)
    }
  }
  function send(ev) {
    ev.preventDefault()
    const q = typed.trim()
    if (!q) return
    setTyped('')
    summonAssistant(q)
  }

  const latest = feed[0]
  const recent = latest && Date.now() - latest.t < 15000 ? latest.text : ''
  const say = (awake || mood === 'speaking' ? caption : recent || caption) || (mood === 'listening' ? 'Go ahead, I’m listening.' : online || demo ? 'I’ll tell you everything the boat does.' : 'The boat isn’t connected yet.')

  return (
    <div className="bv2">
      {/* ── live feed ── */}
      <section className="bv2-video" aria-label="Live boat camera">
        {showDemoFeed ? <DemoFeed /> : <CameraCanvas engine={e} cfg={bv.cfg} vision={bv.vision} />}
        {!showDemoFeed && !e.frame && (
          <div className="bv2-video-msg">
            {online ? (
              <div className="bv2-card-msg">
                <b>{!bv.cameraUp ? 'The boat camera is not streaming' : !bv.enabled ? 'Vision AI is switched off' : 'Waiting for the boat camera…'}</b>
                <span>{!bv.cameraUp ? 'Check the phone on the boat is on and its camera app is open.' : !bv.enabled ? 'Turn it on in Advanced → Settings.' : 'The picture appears here in a moment.'}</span>
              </div>
            ) : (
              <div className="bv2-card-msg">
                <b>{boat.reachable === undefined ? 'Looking for the boat…' : 'The boat is not connected'}</b>
                <span>Switch the boat on and make sure it is online, or try the assistant with a pretend run.</span>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <button type="button" className="sx-btn" onClick={() => setDemo(true)}>Try the demo</button>
                  <button type="button" className="sx-btn ghost" onClick={() => onNavigate?.('system')}>Connection settings</button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="bv2-top">
          <div className="bv2-title">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>
            <b>Boat Vision</b>
            <span className={`sx-pill ${linkPill[1]}`}><i />{linkPill[0]}</span>
          </div>
          {stats.length > 0 && (
            <div className="bv2-stats">
              <div className="bv2-doing"><span>Now</span><b>{doing}</b></div>
              {stats.map(([l, v, tone]) => <Stat key={l} label={l} value={v} tone={tone} />)}
            </div>
          )}
        </div>
        {demo && (
          <button type="button" className="bv2-demo-tag" onClick={() => setDemo(false)} title="Turn demo mode off">Demo run · tap to stop</button>
        )}
      </section>

      {/* ── the assistant ── */}
      <section className="bv2-side" aria-label="VARUNA Assistant">
        <div className="bv2-bot">
          <VarunaBot state={mood} gesture={gest} levelRef={botLevel} className="bv2-bot-3d" onClick={() => summonAssistant()} title="Tap to talk to VARUNA" />
          <div className="bv2-bot-txt">
            <div className="bv2-bot-name">VARUNA <span className={`sx-pill ${mood === 'alert' ? 'bad' : mood === 'listening' ? 'info pulse' : mood === 'speaking' || mood === 'happy' ? 'ok' : ''}`}><i />{MOOD_WORD[mood] || 'Ready'}</span></div>
            <AnimatePresence mode="wait">
              <motion.p key={say} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{say}</motion.p>
            </AnimatePresence>
            {awake && heard && <small>You said: “{heard}”</small>}
          </div>
        </div>
        <div className="bv2-feed-head">
          <b>Messages from the boat</b>
          <button type="button" className={`vb-iconbtn ${muted ? '' : 'on'}`} onClick={() => setMuted(!muted)} title={muted ? 'Muted: tap to hear messages' : 'Spoken out loud: tap to mute'} aria-pressed={!muted}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z" />{muted ? <path d="M22 9l-6 6M16 9l6 6" /> : <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" />}</svg>
          </button>
        </div>
        <Feed feed={feed} />
      </section>

      {/* ── controls ── */}
      <section className="bv2-controls" aria-label="Boat controls">
        <button type="button" className="bv2-stop" onClick={() => command('stop')} disabled={busy === 'stop'} title="Stop the boat now">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" /></svg>
          Stop
        </button>
        <button type="button" className={`bv2-mic ${mood === 'listening' ? 'live' : ''}`} onClick={() => summonAssistant()} aria-label="Talk to VARUNA" title="Talk to VARUNA (Alt+V)">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>
        </button>
        <div className="bv2-quick">
          <button type="button" className="sx-btn" disabled={!!busy} onClick={() => command('collect')}>Go collect</button>
          <button type="button" className="sx-btn ghost" disabled={!!busy} onClick={() => command('home')}>Come home</button>
          <button type="button" className="sx-btn ghost" disabled={!!busy} onClick={() => command('status')}>Status</button>
        </div>
        <form className="bv2-type" onSubmit={send}>
          <input value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder="Type a command, e.g. lower the ramp" aria-label="Type a command for VARUNA" />
        </form>
        <button type="button" className="sx-btn ghost bv2-adv-btn" onClick={() => setAdv(true)} aria-label="Advanced tools" title="Advanced tools">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
          <span>Advanced</span>
        </button>
      </section>

      <AnimatePresence>
        {adv && (
          <>
            <motion.div key="scrim" className="bv2-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setAdv(false)} />
            <AdvancedTools key="drawer" onNavigate={onNavigate} onClose={() => setAdv(false)} />
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
