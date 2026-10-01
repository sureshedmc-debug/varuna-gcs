import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { api, getApiBase, setApiBase, testConnection, DEFAULT_API_BASE } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Btn, StaleBadge, StatusOrb, TiltCard, Field, Spinner } from '../components/ui'
import { num, bool, pick } from '../lib/format'
import { setAlertSettings, useAlertSettings } from '../lib/alertSettings'
import { getFovSettings, setFovSettings, useFovSettings, DEFAULT_AVG_WEIGHT_G } from '../lib/sizeEstimate'
import { sendReportReadyEmail } from '../lib/alerts/email'
import { openWhatsApp } from '../lib/alerts/whatsapp'
import { buildAlertText } from '../lib/alerts/format'
import OfflineMapsPanel from '../components/OfflineMapsPanel'

// ── Shell detection (Electron vs browser) — logic unchanged ───────────────────
function useShell() {
  const bridge = typeof window !== 'undefined' ? window.varuna : undefined
  const [desktop, setDesktop] = useState(bridge?.isDesktop ? undefined : null)
  useEffect(() => {
    if (!bridge?.isDesktop) return undefined
    let alive = true
    bridge.getConfig()
      .then((c) => alive && setDesktop(c?.usesBuiltInProxy ? c : null))
      .catch(() => alive && setDesktop(null))
    return () => { alive = false }
  }, [bridge])
  if (desktop === undefined) return { kind: 'loading' }
  return desktop ? { kind: 'desktop', config: desktop } : { kind: 'browser' }
}

// ── Connection result banner ───────────────────────────────────────────────────
function ConnectionResult({ result }) {
  if (!result) return null
  return (
    <div
      className="mt-3 rounded-lg px-3 py-2.5 text-xs"
      style={{
        borderLeft: `3px solid ${result.ok ? '#34D399' : '#EF4444'}`,
        background: result.ok ? 'rgba(52,211,153,0.06)' : 'rgba(239,68,68,0.06)',
      }}
    >
      <div className="font-semibold" style={{ color: result.ok ? '#34D399' : '#EF4444' }}>{result.title}</div>
      <div className="mt-0.5 text-muted">{result.detail}</div>
    </div>
  )
}

// ── Connection panel (logic unchanged, redesigned inputs) ─────────────────────
function ConnectionPanel({ shell }) {
  const desktop = shell.kind === 'desktop'
  const initial = desktop ? shell.config.piAddress || '' : getApiBase()
  const [val,     setVal]     = useState(initial)
  const [saved]               = useState(initial)
  const [testing, setTesting] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [result,  setResult]  = useState(null)
  const changed = val.trim().replace(/\/+$/, '') !== saved.replace(/\/+$/, '')

  async function apply() {
    if (desktop) {
      setSaving(true)
      const r = await window.varuna.setPiAddress(val)
      setSaving(false)
      if (!r?.ok) return setResult({ ok: false, title: 'Invalid address', detail: r?.error || '' })
      setApiBase('')
    } else { setApiBase(val) }
    window.location.reload()
  }
  async function test() {
    setTesting(true); setResult(null)
    try { setResult(desktop ? await window.varuna.testPiAddress(val) : await testConnection(val)) }
    finally { setTesting(false) }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        {desktop
          ? 'Enter the Pi\'s Netbird address — the desktop app forwards to it, so no CORS is needed on the Pi. Saved on this PC.'
          : <>Leave <strong className="text-ink">blank</strong> to go through the Vite proxy (recommended), or enter the Pi's Netbird address to call it directly.</>}
      </p>
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">
        {desktop ? 'Pi address (Netbird)' : 'Backend base URL'}
      </label>
      <input
        value={val} onChange={(e) => setVal(e.target.value)}
        placeholder={desktop ? 'http://varuna-pi.netbird.cloud:8000' : 'blank = via Vite proxy   ·   or http://varuna-pi.netbird.cloud:8000'}
        className="inp mb-3 w-full px-3 py-2 font-mono text-sm"
        spellCheck={false} autoCapitalize="off" autoCorrect="off"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!changed || saving} onClick={apply}>
          {saving ? <Spinner /> : desktop ? 'Save & reconnect' : 'Apply & reconnect'}
        </Btn>
        <Btn variant="secondary" onClick={test} disabled={testing}>
          {testing ? <Spinner /> : 'Test connection'}
        </Btn>
        {!desktop && <Btn variant="ghost" onClick={() => setVal(DEFAULT_API_BASE)}>Via proxy</Btn>}
      </div>
      <ConnectionResult result={result} />
      <p className="mt-2 text-[11px] text-faint">
        Plain <span className="font-mono">http://</span> is correct for Netbird — WireGuard already encrypts the link.
        {desktop ? '' : ' Calling the Pi directly needs CORS on FastAPI.'} AI trash detection runs fully on this device (local ONNX models).
      </p>
    </div>
  )
}

function ConnectionSection() {
  const shell = useShell()
  if (shell.kind === 'loading') return <Section title="Connection"><Spinner label="Reading connection settings" /></Section>
  const label = shell.kind === 'desktop' ? shell.config.piAddress || 'Pi address not set' : getApiBase() || 'via Vite proxy'
  return (
    <Section title="Connection" right={<span className="max-w-[220px] truncate font-mono text-[11px] text-accent">{label}</span>}>
      <ConnectionPanel shell={shell} />
    </Section>
  )
}

// ── Health light (redesigned with icon slot) ───────────────────────────────────
function HealthLight({ label, ok, icon }) {
  const level = ok === true ? 'ok' : ok === false ? 'bad' : 'idle'
  const bg    = ok === true ? 'rgba(50,215,75,0.1)' : ok === false ? 'rgba(255,69,58,0.1)' : 'rgba(255,255,255,0.04)'
  const border = ok === true ? 'rgba(50,215,75,0.2)' : ok === false ? 'rgba(255,69,58,0.2)' : 'rgba(255,255,255,0.07)'
  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-3"
      style={{ background: bg, border: `1px solid ${border}` }}>
      {icon && (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
          style={{ background: 'rgba(255,255,255,0.05)' }}>
          {icon}
        </div>
      )}
      <StatusOrb level={level} size={12} pulse={ok === false} />
      <div>
        <div className="text-sm font-semibold text-ink">{label}</div>
        <div className="text-xs text-muted">
          {ok === true ? 'Connected' : ok === false ? 'Disconnected' : 'Unknown'}
        </div>
      </div>
    </div>
  )
}

// ── Bar metric with animated fill ─────────────────────────────────────────────
function Bar({ label, pct, level = 'ok' }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  const c = level === 'bad' ? '#EF4444' : level === 'warn' ? '#F59E0B' : '#22D3EE'
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono tnum text-ink">{num(pct, 0)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-chip2">
        <motion.div className="h-full rounded-full" style={{ background: c }} initial={{ width: 0 }} animate={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

// ── Tuning panel (logic unchanged, redesigned cards) ──────────────────────────
function TuningPanel() {
  const [cfg,   setCfg]   = useState(null)
  const [draft, setDraft] = useState({})
  const [errors,setErrors]= useState({})
  const [busy,  setBusy]  = useState(false)
  const toast = useToast()

  useEffect(() => {
    api.getConfig().then((d) => {
      setCfg(d)
      const init = {}
      Object.entries(d || {}).forEach(([k, v]) => { init[k] = typeof v === 'object' && v !== null ? v.value : v })
      setDraft(init)
    }).catch(() => setCfg({ _error: true }))
  }, [])

  if (!cfg) return <Spinner label="Loading config" />
  if (cfg._error) return <div className="text-sm text-bad">Could not load /api/config.</div>

  const entries = Object.entries(cfg).filter(([k]) => !k.startsWith('_'))

  async function apply() {
    setBusy(true); setErrors({})
    try {
      const res = await api.setConfig(draft)
      if (res?.errors && Object.keys(res.errors).length) setErrors(res.errors)
      toast.fromResult(res, 'Applied live')
      if (res?.settings) {
        const next = {}
        Object.entries(res.settings).forEach(([k, v]) => (next[k] = typeof v === 'object' && v ? v.value : v))
        setDraft((d) => ({ ...d, ...next }))
      }
    } catch { toast.push({ level: 'bad', title: 'Apply failed' }) }
    finally { setBusy(false) }
  }
  async function persist() {
    try { toast.fromResult(await api.saveConfig(), 'Saved to disk') }
    catch { toast.push({ level: 'bad', title: 'Save failed' }) }
  }

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {entries.map(([key, meta]) => {
          const m       = typeof meta === 'object' && meta !== null ? meta : {}
          const val     = draft[key]
          const min     = m.min, max = m.max
          const isNum   = m.type === 'float' || m.type === 'int' || typeof (m.value ?? meta) === 'number'
          const numeric = min !== undefined && max !== undefined && isNum
          return (
            <div key={key} className="rounded-xl p-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-ink">{key}</span>
                <span className="font-mono tnum text-xs text-accent">{String(val ?? '')}</span>
              </div>
              {m.description && <div className="mb-2 text-[11px] leading-snug text-muted">{m.description}</div>}
              {numeric ? (
                <input type="range" min={min} max={max}
                  step={m.type === 'int' ? 1 : (max - min) / 100}
                  value={Number(val) || 0}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: m.type === 'int' ? parseInt(e.target.value) : parseFloat(e.target.value) }))}
                  className="w-full accent-accent" />
              ) : (
                <input value={val ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: isNum ? Number(e.target.value) : e.target.value }))}
                  className="inp w-full px-2 py-1 font-mono text-sm tnum" />
              )}
              {(min !== undefined || max !== undefined) && (
                <div className="mt-1 flex justify-between font-mono tnum text-[10px] text-muted">
                  <span>{min}</span><span>{max}</span>
                </div>
              )}
              {errors[key] && <div className="mt-1 text-[11px] text-bad">{errors[key]}</div>}
            </div>
          )
        })}
      </div>
      <div className="flex gap-3">
        <Btn disabled={busy} onClick={apply}>{busy ? 'Applying…' : 'Apply live'}</Btn>
        <Btn variant="secondary" onClick={persist}>Save to disk</Btn>
      </div>
    </div>
  )
}

// ── Link preference ────────────────────────────────────────────────────────────
function LinkPreference() {
  const [mode, setMode] = useState(null)
  const toast = useToast()
  useEffect(() => {
    api.getPrefer().then((d) => setMode(pick(d, ['mode', 'prefer', 'preferred']) || 'auto')).catch(() => setMode('auto'))
  }, [])
  async function set(m) {
    setMode(m)
    try { toast.fromResult(await api.setPrefer(m), `Link preference: ${m}`) }
    catch { toast.push({ level: 'bad', title: 'Failed to set link preference' }) }
  }
  return (
    <div className="flex flex-wrap gap-2">
      {['auto', 'usb', 'telem2'].map((m) => (
        <button key={m} onClick={() => set(m)}
          className="touch rounded-xl px-5 text-sm font-semibold transition-all"
          style={mode === m
            ? { background: 'linear-gradient(180deg,#4FA9FF,#2E90F5)', color: '#fff', border: 'none' }
            : { background: 'rgba(255,255,255,0.04)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.08)' }}>
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ── Alerts panel (logic unchanged) ────────────────────────────────────────────
function AlertsPanel() {
  const s = useAlertSettings()
  const [busy, setBusy] = useState('')
  const toast = useToast()
  const upd   = (patch) => setAlertSettings(patch)
  const testText = buildAlertText({ itemCount: s.bigDumpThreshold, cls: 'trash', lat: 17.4239, lng: 78.4738, source: 'stream' })

  function testWhatsApp() {
    if (!s.whatsappNumber) return toast.push({ level: 'warn', title: 'Enter a WhatsApp number first' })
    const ok = openWhatsApp(`TEST — ${testText}`)
    if (!ok) toast.push({ level: 'warn', title: 'Popup blocked — allow pop-ups for VARUNA.' })
  }
  async function testEmail() {
    setBusy('em')
    const r = await sendReportReadyEmail({ filename: 'TEST-report.doc', summary: testText })
    toast.push({ level: r.ok ? 'ok' : 'bad', title: r.ok ? 'Email test sent' : `Email: ${r.error}` })
    setBusy('')
  }

  const cardStyle = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 12 }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div style={cardStyle} className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-ink">📱 WhatsApp</div>
        <div className="text-[11px] text-muted">Opens a prefilled wa.me link — the operator taps Send in WhatsApp. No token needed.</div>
        <input value={s.whatsappNumber} onChange={(e) => upd({ whatsappNumber: e.target.value.replace(/[^0-9+]/g, '') })}
          placeholder="Phone (e.g. 91XXXXXXXXXX)" className="inp px-2 py-1 text-xs font-mono" spellCheck={false} />
        <Btn variant="secondary" onClick={testWhatsApp}>Open WhatsApp with test message</Btn>
      </div>
      <div style={cardStyle} className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-ink">📧 Email (EmailJS)</div>
        <div className="text-[11px] text-muted">Sign up at emailjs.com, create a template expecting: to_email, subject, message, filename, summary, itemCount, cls, lat, lng, mapUrl.</div>
        <input value={s.emailjsServiceId}  onChange={(e) => upd({ emailjsServiceId:  e.target.value })} placeholder="Service ID"  className="inp px-2 py-1 text-xs font-mono" spellCheck={false} />
        <input value={s.emailjsTemplateId} onChange={(e) => upd({ emailjsTemplateId: e.target.value })} placeholder="Template ID" className="inp px-2 py-1 text-xs font-mono" spellCheck={false} />
        <input value={s.emailjsPublicKey}  onChange={(e) => upd({ emailjsPublicKey:  e.target.value })} placeholder="Public key"  className="inp px-2 py-1 text-xs font-mono" spellCheck={false} />
        <input value={s.emailjsToAddress}  onChange={(e) => upd({ emailjsToAddress:  e.target.value })} placeholder="Send alerts to…" className="inp px-2 py-1 text-xs font-mono" spellCheck={false} />
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={s.enableEmailOnReport}   onChange={(e) => upd({ enableEmailOnReport:   e.target.checked })} />
          Email me when a report is downloaded
        </label>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={s.enableEmailOnBigDump} onChange={(e) => upd({ enableEmailOnBigDump: e.target.checked })} />
          Email on a big dump ({s.bigDumpThreshold}+ items)
        </label>
        <Btn variant="secondary" onClick={testEmail} disabled={busy === 'em'}>{busy === 'em' ? 'Sending…' : 'Send test email'}</Btn>
      </div>
      <div style={cardStyle} className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-ink">Big-dump threshold</div>
        <div className="text-[11px] text-muted">Fires an alert when at least this many trash items appear in one frame (1-minute cooldown).</div>
        <input type="range" min={2} max={30} step={1} value={s.bigDumpThreshold}
          onChange={(e) => upd({ bigDumpThreshold: Number(e.target.value) })} className="w-full accent-accent" />
        <div className="text-xs font-mono tnum text-accent">{s.bigDumpThreshold} items</div>
      </div>
    </div>
  )
}

// ── FOV panel (logic unchanged) ───────────────────────────────────────────────
function FovPanel() {
  const s = useFovSettings()
  const cardStyle = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 12 }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div style={cardStyle} className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-ink">Camera field of view</div>
        <div className="text-[11px] text-muted">Converts a detection's pixel size into real-world size using drone altitude. Default is a Pi Camera Module.</div>
        <label className="text-[11px] text-muted">Horizontal ({s.fovHorizontalDeg}°)</label>
        <input type="range" min={30} max={120} step={1} value={s.fovHorizontalDeg}
          onChange={(e) => setFovSettings({ fovHorizontalDeg: Number(e.target.value) })} className="w-full accent-accent" />
        <label className="text-[11px] text-muted">Vertical ({s.fovVerticalDeg}°)</label>
        <input type="range" min={20} max={100} step={1} value={s.fovVerticalDeg}
          onChange={(e) => setFovSettings({ fovVerticalDeg: Number(e.target.value) })} className="w-full accent-accent" />
      </div>
      <div style={cardStyle} className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-ink">Average item weight (grams)</div>
        <div className="text-[11px] text-muted">Per-item weight used to estimate total weight in reports. Adjust to your typical debris.</div>
        {Object.keys(DEFAULT_AVG_WEIGHT_G).map((k) => (
          <label key={k} className="flex items-center gap-2 text-xs">
            <span className="w-32 capitalize text-muted">{k}</span>
            <input type="number" min={1} max={2000} step={1}
              value={s.avgWeightG[k] ?? DEFAULT_AVG_WEIGHT_G[k]}
              onChange={(e) => setFovSettings({ avgWeightG: { ...s.avgWeightG, [k]: Number(e.target.value) } })}
              className="inp w-24 px-2 py-1 font-mono tnum" />
            <span className="text-muted">g each</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Section wrapper ────────────────────────────────────────────────────────────
function Section({ title, children, right }) {
  return (
    <TiltCard tilt={false} className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {right}
      </div>
      {children}
    </TiltCard>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function SystemScreen() {
  const { pi, health } = useSystem()
  const cam = usePolling(api.cameraStatus, 6000)
  const ai  = usePolling(api.aiStatus,     6000)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const pixhawk = bool(pick(health.data, ['pixhawk_connected', 'pixhawk']))
  const camOk   = bool(pick(health.data, ['camera_connected', 'camera']))
  const p       = pi.data || {}
  const cpuCores = p.cpu_per_core || p.per_core || p.cpu_cores || (Array.isArray(p.cpu) ? p.cpu : null)
  const ram  = pick(p, ['ram_percent', 'memory_percent', 'ram', 'mem'])
  const disk = pick(p, ['disk_percent', 'disk'])
  const temp = pick(p, ['temperature', 'temp', 'cpu_temp'])

  return (
    <div className="mx-auto grid max-w-5xl gap-4">

      {/* ── Health lights — 2×2 grid ── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <HealthLight label="Pixhawk (flight controller)" ok={pixhawk} icon="🧭" />
        <HealthLight label="Camera (USB webcam)"         ok={camOk}   icon="📷" />
      </div>

      {/* ── Connection ── */}
      <ConnectionSection />

      {/* ── Raspberry Pi metrics ── */}
      <Section title="Raspberry Pi" right={<StaleBadge lastUpdate={pi.lastUpdate} connected={!pi.error} />}>
        {pi.loading && !pi.data ? (
          <Spinner label="Reading Pi metrics" />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {/* Bars */}
            <div className="flex flex-col gap-3">
              <Bar label="RAM"  pct={ram}  level={Number(ram)  > 90 ? 'bad' : Number(ram)  > 75 ? 'warn' : 'ok'} />
              <Bar label="Disk" pct={disk} level={Number(disk) > 90 ? 'bad' : 'ok'} />
              {/* Per-core CPU bars */}
              {Array.isArray(cpuCores) && (
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">CPU per core</div>
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(cpuCores.length, 4)}, 1fr)` }}>
                    {cpuCores.map((c, i) => {
                      const pct = typeof c === 'object' ? c.percent : c
                      const lvl = Number(pct) > 90 ? 'warn' : 'ok'
                      const col = lvl === 'warn' ? '#F59E0B' : '#22D3EE'
                      return (
                        <div key={i} className="flex flex-col items-center gap-1">
                          <div className="text-[9px] text-faint">C{i}</div>
                          <div className="w-full overflow-hidden rounded-full bg-chip2" style={{ height: 4 }}>
                            <motion.div className="h-full rounded-full" style={{ background: col }}
                              initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, Number(pct) || 0))}%` }} />
                          </div>
                          <div className="font-mono text-[9px] tnum text-muted">{num(pct, 0)}%</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {/* Fallback single bar if no per-core */}
              {!Array.isArray(cpuCores) && p.cpu_count && (
                <Bar label="CPU" pct={pick(p, ['cpu_percent', 'cpu'])} level="ok" />
              )}
            </div>
            {/* Fields */}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Temp"  value={num(temp, 0)} unit="°C" level={Number(temp) >= 80 ? 'warn' : 'ok'} />
              <Field label="Cores" value={Array.isArray(cpuCores) ? cpuCores.length : num(p.cpu_count, 0)} />
            </div>
          </div>
        )}
      </Section>

      {/* ── Camera + AI — side by side ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Camera" right={<StatusOrb level={camOk ? 'ok' : 'bad'} size={12} />}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Status"       value={pick(cam.data, ['status_text']) || (camOk ? 'ACTIVE' : 'OFFLINE')} mono={false} />
            <Field label="Measured FPS" value={num(pick(cam.data, ['measured_fps']), 1)} />
            <Field label="Resolution"   value={pick(cam.data, ['resolution']) || '—'} mono={false} />
            <Field label="Frames"       value={num(pick(cam.data, ['frames_captured']), 0)} />
          </div>
          {pick(cam.data, ['last_error']) && <div className="mt-2 text-xs text-warn">{cam.data.last_error}</div>}
        </Section>

        <Section title="AI detection" right={<StatusOrb level={bool(pick(ai.data, ['model_loaded'])) ? 'ok' : 'warn'} size={12} />}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Enabled"    value={bool(pick(ai.data, ['ai_enabled'])) ? 'Yes' : 'No'} mono={false} />
            <Field label="Model"      value={bool(pick(ai.data, ['model_loaded'])) ? 'Loaded' : 'No'} mono={false} />
            <Field label="Confidence" value={num(pick(ai.data, ['confidence_threshold']), 2)} />
            <Field label="Live boxes" value={num(pick(ai.data, ['live_boxes', 'people_in_last_frame']), 0)} />
          </div>
        </Section>
      </div>

      {/* ── Alerts ── */}
      <Section title="Alerts">
        <p className="mb-3 text-xs text-muted">
          Send big-dump alerts and report-ready notifications through WhatsApp or email. All keys stay in this browser — nothing leaves except the message itself.
        </p>
        <AlertsPanel />
      </Section>

      {/* ── Camera FOV & weight estimates ── */}
      <Section title="Camera FOV & size estimate">
        <p className="mb-3 text-xs text-muted">
          Rough estimate — the report labels these numbers "rough" and prints the FOV assumption you chose here.
        </p>
        <FovPanel />
      </Section>

      {/* ── Offline maps ── */}
      <Section title="Offline maps">
        <OfflineMapsPanel />
      </Section>

      {/* ── Live tuning ── */}
      <Section title="Live tuning">
        <TuningPanel />
      </Section>

      {/* ── Advanced ── */}
      <Section
        title="Advanced"
        right={
          <button onClick={() => setShowAdvanced((s) => !s)} className="text-xs text-accent">
            {showAdvanced ? 'Hide' : 'Show'}
          </button>
        }
      >
        {showAdvanced ? (
          <div>
            <div className="mb-2 text-xs uppercase tracking-wider text-muted">MAVLink link preference (USB / TELEM2)</div>
            <LinkPreference />
            <p className="mt-2 text-[11px] text-muted">Which physical link the vehicle connection prefers. Leave on AUTO unless troubleshooting.</p>
          </div>
        ) : (
          <div className="text-sm text-muted">Physical link preference and low-level settings.</div>
        )}
      </Section>
    </div>
  )
}
