import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { api, getApiBase, setApiBase, DEFAULT_API_BASE } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling, useNow } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Btn, StaleBadge, StatusOrb, TiltCard, Field, Spinner } from '../components/ui'
import { num, bool, pick } from '../lib/format'

function ConnectionPanel() {
  const [val, setVal] = useState(getApiBase())
  const [saved] = useState(getApiBase())
  const changed = val.replace(/\/+$/, '') !== saved.replace(/\/+$/, '')
  function apply() {
    setApiBase(val)
    window.location.reload() // re-init polling + websocket against the new host
  }
  return (
    <div>
      <div className="mb-2 text-xs text-muted">
        The app reads live video, telemetry and detections from this backend URL. It's stored in your
        browser, so you can repoint it any time (e.g. when the ngrok URL changes) without a rebuild.
      </div>
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">Backend base URL</label>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="https://<your-ngrok>.ngrok-free.dev  (blank = same origin)"
        className="inp mb-2 w-full px-3 py-2 font-mono text-sm"
        spellCheck={false}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!changed} onClick={apply}>Apply &amp; reconnect</Btn>
        <Btn variant="secondary" onClick={() => setVal(DEFAULT_API_BASE)}>Use default</Btn>
        <Btn variant="ghost" onClick={() => setVal('')}>Same origin</Btn>
      </div>
      <div className="mt-2 text-[11px] text-faint">
        Cross-origin access needs CORS on the backend. AI trash detection runs fully in-browser
        (local ONNX models) — no external API or key involved.
      </div>
    </div>
  )
}

function HealthLight({ label, ok }) {
  const level = ok === true ? 'ok' : ok === false ? 'bad' : 'idle'
  return (
    <div className="glass-soft flex items-center gap-3 px-4 py-3">
      <StatusOrb level={level} size={13} pulse={ok === false} />
      <div>
        <div className="text-sm font-semibold text-ink">{label}</div>
        <div className="text-xs text-muted">{ok === true ? 'Connected' : ok === false ? 'Disconnected' : 'Unknown'}</div>
      </div>
    </div>
  )
}

function Bar({ label, pct, level = 'ok' }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  const c = level === 'bad' ? '#EF4444' : level === 'warn' ? '#F59E0B' : '#22D3EE'
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono tnum text-ink">{num(pct, 0)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-chip2">
        <motion.div className="h-full rounded-full" style={{ background: c }} initial={{ width: 0 }} animate={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

function TuningPanel() {
  const [cfg, setCfg] = useState(null)
  const [draft, setDraft] = useState({})
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    api.getConfig().then((d) => {
      setCfg(d)
      const init = {}
      Object.entries(d || {}).forEach(([k, v]) => {
        init[k] = typeof v === 'object' && v !== null ? v.value : v
      })
      setDraft(init)
    }).catch(() => setCfg({ _error: true }))
  }, [])

  if (!cfg) return <Spinner label="Loading config" />
  if (cfg._error) return <div className="text-sm text-bad">Could not load /api/config.</div>

  const entries = Object.entries(cfg).filter(([k]) => !k.startsWith('_'))

  async function apply() {
    setBusy(true)
    setErrors({})
    try {
      const res = await api.setConfig(draft)
      if (res?.errors && Object.keys(res.errors).length) setErrors(res.errors)
      toast.fromResult(res, 'Applied live')
      if (res?.settings) {
        const next = {}
        Object.entries(res.settings).forEach(([k, v]) => (next[k] = typeof v === 'object' && v ? v.value : v))
        setDraft((d) => ({ ...d, ...next }))
      }
    } catch {
      toast.push({ level: 'bad', title: 'Apply failed' })
    } finally {
      setBusy(false)
    }
  }
  async function persist() {
    try {
      toast.fromResult(await api.saveConfig(), 'Saved to disk')
    } catch {
      toast.push({ level: 'bad', title: 'Save failed' })
    }
  }

  return (
    <div>
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {entries.map(([key, meta]) => {
          const m = typeof meta === 'object' && meta !== null ? meta : {}
          const val = draft[key]
          const min = m.min, max = m.max
          const isNum = m.type === 'float' || m.type === 'int' || typeof (m.value ?? meta) === 'number'
          const numeric = min !== undefined && max !== undefined && isNum
          return (
            <div key={key} className="glass-soft p-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-ink">{key}</span>
                <span className="font-mono tnum text-xs text-accent">{String(val ?? '')}</span>
              </div>
              {m.description && <div className="mb-2 text-[11px] leading-snug text-muted">{m.description}</div>}
              {numeric ? (
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={m.type === 'int' ? 1 : (max - min) / 100}
                  value={Number(val) || 0}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: m.type === 'int' ? parseInt(e.target.value) : parseFloat(e.target.value) }))}
                  className="w-full accent-accent"
                />
              ) : (
                <input
                  value={val ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: isNum ? Number(e.target.value) : e.target.value }))}
                  className="inp w-full px-2 py-1 text-sm font-mono tnum"
                />
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

function LinkPreference() {
  const [mode, setMode] = useState(null)
  const toast = useToast()
  useEffect(() => {
    api.getPrefer().then((d) => setMode(pick(d, ['mode', 'prefer', 'preferred']) || 'auto')).catch(() => setMode('auto'))
  }, [])
  async function set(m) {
    setMode(m)
    try {
      toast.fromResult(await api.setPrefer(m), `Link preference: ${m}`)
    } catch {
      toast.push({ level: 'bad', title: 'Failed to set link preference' })
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      {['auto', 'usb', 'telem2'].map((m) => (
        <button
          key={m}
          onClick={() => set(m)}
          className="touch rounded-xl px-4 text-sm font-semibold"
          style={{
            background: mode === m ? 'linear-gradient(180deg,#4FA9FF,#2E90F5)' : 'rgba(15,23,42,0.05)',
            color: mode === m ? '#FFFFFF' : '#5B6B7C',
            border: mode === m ? 'none' : '1px solid rgba(15,23,42,0.12)',
          }}
        >
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

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

export default function SystemScreen() {
  const now = useNow(1000)
  const { pi, health } = useSystem()
  const cam = usePolling(api.cameraStatus, 6000)
  const ai = usePolling(api.aiStatus, 6000)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const pixhawk = bool(pick(health.data, ['pixhawk_connected', 'pixhawk']))
  const camOk = bool(pick(health.data, ['camera_connected', 'camera']))
  const p = pi.data || {}
  const cpuCores = p.cpu_per_core || p.per_core || p.cpu_cores || (Array.isArray(p.cpu) ? p.cpu : null)
  const ram = pick(p, ['ram_percent', 'memory_percent', 'ram', 'mem'])
  const disk = pick(p, ['disk_percent', 'disk'])
  const temp = pick(p, ['temperature', 'temp', 'cpu_temp'])

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <HealthLight label="Pixhawk (flight controller)" ok={pixhawk} />
        <HealthLight label="Camera" ok={camOk} />
      </div>

      <Section title="Connection" right={<span className="max-w-[220px] truncate font-mono text-[11px] text-accent">{getApiBase() || 'same origin'}</span>}>
        <ConnectionPanel />
      </Section>

      <Section title="Raspberry Pi" right={<StaleBadge lastUpdate={pi.lastUpdate} now={now} connected={!pi.error} />}>
        {pi.loading && !pi.data ? (
          <Spinner label="Reading Pi metrics" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Bar label="RAM" pct={ram} level={Number(ram) > 90 ? 'bad' : Number(ram) > 75 ? 'warn' : 'ok'} />
              <Bar label="Disk" pct={disk} level={Number(disk) > 90 ? 'bad' : 'ok'} />
              {Array.isArray(cpuCores) &&
                cpuCores.map((c, i) => <Bar key={i} label={`CPU core ${i}`} pct={typeof c === 'object' ? c.percent : c} level={Number(typeof c === 'object' ? c.percent : c) > 90 ? 'warn' : 'ok'} />)}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Temp" value={num(temp, 0)} unit="°C" level={Number(temp) >= 80 ? 'warn' : 'ok'} />
              <Field label="Cores" value={Array.isArray(cpuCores) ? cpuCores.length : num(p.cpu_count, 0)} />
            </div>
          </div>
        )}
      </Section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Camera" right={<StatusOrb level={camOk ? 'ok' : 'bad'} size={12} />}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Status" value={pick(cam.data, ['status_text']) || (camOk ? 'ACTIVE' : 'OFFLINE')} mono={false} />
            <Field label="Measured FPS" value={num(pick(cam.data, ['measured_fps']), 1)} />
            <Field label="Resolution" value={pick(cam.data, ['resolution']) || '—'} mono={false} />
            <Field label="Frames" value={num(pick(cam.data, ['frames_captured']), 0)} />
          </div>
          {pick(cam.data, ['last_error']) && <div className="mt-2 text-xs text-warn">{cam.data.last_error}</div>}
        </Section>

        <Section title="AI detection" right={<StatusOrb level={bool(pick(ai.data, ['model_loaded'])) ? 'ok' : 'warn'} size={12} />}>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Enabled" value={bool(pick(ai.data, ['ai_enabled'])) ? 'Yes' : 'No'} mono={false} />
            <Field label="Model" value={bool(pick(ai.data, ['model_loaded'])) ? 'Loaded' : 'No'} mono={false} />
            <Field label="Confidence" value={num(pick(ai.data, ['confidence_threshold']), 2)} />
            <Field label="Live boxes" value={num(pick(ai.data, ['live_boxes', 'people_in_last_frame']), 0)} />
          </div>
        </Section>
      </div>

      <Section title="Live tuning">
        <TuningPanel />
      </Section>

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
