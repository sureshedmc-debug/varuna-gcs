import { useEffect, useMemo, useRef, useState } from 'react'
import { boatApi, boatUrls } from '../api/boatClient'
import { useBoat } from '../components/BoatContext'
import { useBoatVision } from '../components/BoatVisionContext'
import { useToast } from '../components/Toast'
import { usePolling } from '../hooks/usePolling'
import { getLatestFrame } from '../lib/boatVision'
import { boxDistance } from '../lib/boatCamera'
import { estimateWeightG, fmtWeight } from '../lib/sizeEstimate'
import { isOk } from '../lib/commands'
import { relTime } from '../lib/format'
import { Chip, HOMING_LABEL, NlBoatOffline, Switch, Tile, WILDLIFE_LABEL } from '../components/BoatLabParts'

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

      // Danger zone
      const hazard = (e.hazards || []).some((h) => h.in_zone)
      const zx1 = X((c.zone_x1 ?? 0.25) * fw), zx2 = X((c.zone_x2 ?? 0.75) * fw), zy1 = Y((c.zone_y1 ?? 0.3) * fh)
      ctx.fillStyle = hazard ? 'rgba(255,69,58,0.16)' : 'rgba(255,159,10,0.05)'
      ctx.strokeStyle = hazard ? RED : 'rgba(255,159,10,0.7)'
      ctx.setLineDash([7 * dpr, 5 * dpr])
      ctx.beginPath(); ctx.rect(zx1, zy1, zx2 - zx1, Y(rampY) - zy1); ctx.fill(); ctx.stroke()
      ctx.setLineDash([])
      label(ctx, hazard ? 'ANIMAL IN ZONE' : 'WILDLIFE ZONE', zx1 + 6 * dpr, zy1 + 11 * dpr, hazard ? RED : AMBER, font * 0.8)

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
      // Animals
      for (const b of e.hazards || []) {
        drawBox(ctx, X(b.x1), Y(b.y1), (b.x2 - b.x1) * k, (b.y2 - b.y1) * k, b.in_zone ? RED : AMBER, 2.5 * dpr,
          `${b.label} ${Math.round((b.score || 0) * 100)}%`, font)
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
  { key: 'wildlife_clear_s', label: 'Zone must stay clear for', unit: 's', min: 2, max: 60, step: 1 },
  { key: 'wildlife_alert_s', label: 'Ask me after waiting', unit: 's', min: 10, max: 600, step: 10 },
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

// ── Screen ───────────────────────────────────────────────────────────────────
export default function BoatVisionScreen({ onNavigate }) {
  const boat = useBoat()
  const bv = useBoatVision()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const [tab, setTab] = useState('live') // live | settings
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const online = bv.online
  const e = bv.engine || {}
  const v = bv.vision
  const cfg = bv.cfg

  const catchPoll = usePolling(() => (online ? boatApi.catchSummary(12) : Promise.resolve(null)), 3000, [online])
  const wildPoll = usePolling(() => (online ? boatApi.wildlife(8) : Promise.resolve(null)), 5000, [online])
  const catchData = catchPoll.data && !catchPoll.data._httpError ? catchPoll.data : null
  const wild = wildPoll.data && !wildPoll.data._httpError ? wildPoll.data : null

  const weightG = useMemo(() => {
    const by = catchData?.today?.by_label || {}
    return Object.entries(by).reduce((a, [label, n]) => a + estimateWeightG(label, n), 0)
  }, [catchData])

  async function run(key, fn, okMsg) {
    setBusy(key)
    try {
      const res = await fn()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || 'Failed' }, okMsg)
      catchPoll.refresh()
      wildPoll.refresh()
    } catch (err) {
      toast.push({ level: 'bad', title: `Command failed: ${err?.message || err}` })
    } finally {
      setBusy(null)
    }
  }

  const homing = v?.homing
  const wl = v?.wildlife
  const hm = HOMING_LABEL[homing?.state] || HOMING_LABEL.idle
  const wlm = WILDLIFE_LABEL[wl?.state] || WILDLIFE_LABEL.clear
  const linkAlive = v?.link?.alive
  const bin = catchData?.bin || v?.catch?.bin
  const binPct = Math.min(100, bin?.pct || 0)
  const statusText = !online ? '' : !bv.cameraUp ? 'The boat camera is not streaming.' : !bv.enabled ? 'Vision AI is switched off.' : e.message
  const byLabel = Object.entries(catchData?.today?.by_label || {}).sort((a, b) => b[1] - a[1])
  const maxLabel = byLabel.length ? byLabel[0][1] : 1

  return (
    <div className="nl relative" style={{ height: 'calc(100vh - 66px)' }}>

      {/* ── Camera view ── */}
      <div className="absolute inset-0 z-0 isolate overflow-hidden rounded-2xl" style={{ background: '#0F1222', border: '1.5px solid #f0ecff' }}>
        <CameraCanvas engine={e} cfg={cfg} vision={v} />
        {(!e.frame || statusText) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="nl-pill flex items-center gap-2.5 px-4 py-3">
              <Chip tone={online && bv.cameraUp ? 'warn' : 'bad'} dot pulse>{online ? 'CAMERA' : 'BOAT'}</Chip>
              <span className="nl-text font-semibold">{!online ? 'Boat not connected.' : statusText || 'Waiting for the boat camera…'}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Title pill ── */}
      <div className="absolute left-3 top-3 z-20 max-w-[calc(100vw-400px)]">
        <div className="nl-pill flex flex-wrap items-center gap-2 px-3 py-2">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#7c3aed" strokeWidth="2.2" style={{ flexShrink: 0 }} aria-hidden="true">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
          </svg>
          <span className="nl-title">Boat Vision</span>
          <Chip tone={online ? 'ok' : 'bad'} dot>{online ? 'BOAT LINK' : 'NO BOAT LINK'}</Chip>
          {online && <Chip tone={bv.cameraUp ? 'ok' : 'bad'} dot>{bv.cameraUp ? `CAMERA · ${e.fps || 0} FPS` : 'NO CAMERA'}</Chip>}
          {online && bv.enabled && (
            <Chip tone={linkAlive ? 'ok' : 'warn'} dot pulse={!linkAlive} title="The boat receives what this app's AI sees">
              {linkAlive ? 'BOAT SEES AI' : 'AI NOT REACHING BOAT'}
            </Chip>
          )}
          {e.sim && <Chip tone="warn" title="In the simulator the boat reports where its drawn items are; the AI models are not used">SIM DETECTIONS</Chip>}
          {v?.operator_paused && <Chip tone="warn" title="An operator command paused the camera automation. Press Start/Resume on the Boat or Collect tab.">AUTOMATION PAUSED</Chip>}
        </div>
      </div>

      {/* ── Side panel ── */}
      <div className="absolute right-3 top-3 z-30 w-[350px] max-w-[calc(100vw-24px)]">
        <div className="nl-panel nl-scroll max-h-[calc(100vh-66px-24px-80px)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="nl-eyebrow">Boat · camera AI</span>
            <div className="nl-seg" role="tablist">
              {[['live', 'Live'], ['settings', 'Settings']].map(([id, l]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>
              ))}
            </div>
          </div>

          {!online ? (
            <NlBoatOffline boat={boat} onNavigate={onNavigate} />
          ) : tab === 'settings' ? (
            <div className="flex flex-col gap-3">
              <div className="nl-card flex flex-col gap-2.5">
                <Switch on={bv.enabled} onChange={bv.setEnabled} label="Run the vision AI in this app" />
                <Switch on={!!cfg?.homing_enabled} disabled={!cfg} label="Last-metre homing"
                  onChange={(on) => bv.updateConfig({ homing_enabled: on })} />
                <Switch on={!!cfg?.wildlife_enabled} disabled={!cfg} label="Wildlife-safe mode"
                  onChange={(on) => bv.updateConfig({ wildlife_enabled: on })} />
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

              {/* Homing */}
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
                  {homing?.state && homing.state !== 'idle'
                    ? 'The boat is steering onto the item with the camera.'
                    : `Takes over within ${cfg?.homing_start_m ?? 8} m of each plastic point during a collection.`}
                </div>
              </div>

              {/* Wildlife */}
              <div className={`nl-card${wl?.state === 'alert' ? ' alert' : ''}`}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="nl-title">Wildlife-safe mode</span>
                  <Chip tone={cfg?.wildlife_enabled === false ? 'off' : wlm.tone} dot pulse={wl?.state && wl.state !== 'clear'}>
                    {cfg?.wildlife_enabled === false ? 'OFF' : wlm.label.toUpperCase()}
                  </Chip>
                </div>
                {wl?.state && wl.state !== 'clear' ? (
                  <>
                    <div className="nl-text">
                      <b className="capitalize">{wl.label}</b> ahead — holding for {Math.round(wl.waiting_s || 0)} s
                      {wl.clear_in_s != null ? `, moving on in ${Math.ceil(wl.clear_in_s)} s` : ''}.
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <button className="nl-btn soft" disabled={!!busy} onClick={() => run('w', () => boatApi.wildlifeAction('wait'), 'Waiting')}>Wait</button>
                      <button className="nl-btn" disabled={!!busy} onClick={() => run('w', () => boatApi.wildlifeAction('resume'), 'Resuming')}>Resume</button>
                      <button className="nl-btn ghost" disabled={!!busy} onClick={() => run('w', () => boatApi.wildlifeAction('skip'), 'Item skipped')}>Skip item</button>
                    </div>
                  </>
                ) : (
                  <div className="nl-text nl-muted">
                    {wl?.pauses_today ? `${wl.pauses_today} pause${wl.pauses_today === 1 ? '' : 's'} today · ${Math.round(wl.paused_s_today || 0)} s waited. ` : 'No animals in the way today. '}
                    Birds, people, dogs and other animals in the zone ahead make the boat wait.
                  </div>
                )}
                {wild?.sightings?.length > 0 && (
                  <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                    {wild.sightings.slice(0, 6).map((s) => (
                      <div key={s.id} className="shrink-0" title={`${s.label} · ${relTime(s.t * 1000)}`}>
                        {s.photo
                          ? <img src={boatUrls.wildlifePhoto(s.id)} alt={s.label} className="h-11 w-16 rounded-lg object-cover" style={{ border: '1.5px solid #f0ecff' }} />
                          : <div className="nl-tile flex h-11 w-16 items-center justify-center text-[10px] font-semibold capitalize">{s.label}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Catch */}
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
                {binPct >= 100 && <div className="mt-1.5 nl-text font-bold" style={{ color: 'var(--nl-bad)' }}>Bin full — bring the boat home to empty it.</div>}
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
        </div>
      </div>

      {/* ── Catch feed (bottom-left) ── */}
      {online && (catchData?.items || []).length > 0 && (
        <div className="absolute bottom-3 left-3 z-20 w-[280px] max-w-[calc(100vw-24px)]">
          <div className="nl-panel p-3">
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
        </div>
      )}

      {/* ── Controls (bottom-center) ── */}
      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div className="nl-pill flex items-center gap-2 px-2.5 py-2" style={{ borderRadius: 40 }}>
          <button onClick={() => bv.setEnabled(!bv.enabled)} disabled={!online} className={`nl-btn ${bv.enabled ? 'on' : 'soft'}`}>
            {bv.enabled ? '● Vision AI on' : '○ Vision AI off'}
          </button>
          <button onClick={() => window.open(boatUrls.snapshot(), '_blank')} disabled={!bv.cameraUp} className="nl-btn soft">📸 Snapshot</button>
          {boat.simulated && (
            <button onClick={() => run('duck', () => boatApi.simDuck(9), 'A duck appeared ahead')} disabled={!!busy} className="nl-btn amber">🦆 Sim: duck ahead</button>
          )}
        </div>
      </div>
    </div>
  )
}
