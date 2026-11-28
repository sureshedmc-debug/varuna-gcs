import { useEffect, useState } from 'react'
import { Page, Pill, TabHeader } from '../components/simple/Simple'
import { api, getApiBase, setApiBase, testConnection, DEFAULT_API_BASE } from '../api/client'
import { getBoatBase, setBoatBase, testBoatConnection, BOAT_PROXY_BASE } from '../api/boatClient'
import { useSystem } from '../components/SystemContext'
import { useBoat } from '../components/BoatContext'
import { useToast } from '../components/Toast'
import { Btn, StatusOrb, Spinner } from '../components/ui'
import { bool, pick } from '../lib/format'
import { setAlertSettings, useAlertSettings } from '../lib/alertSettings'
import { getFovSettings, setFovSettings, useFovSettings, metersPerPixel, DEFAULT_AVG_WEIGHT_G } from '../lib/sizeEstimate'
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

// The drone's Raspberry Pi on Tailscale, by its machine name (MagicDNS).
const DRONE_PI_TAILSCALE = 'http://varuna-drone:8000'

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

  async function applyValue(v) {
    if (desktop) {
      setSaving(true)
      const r = await window.varuna.setPiAddress(v)
      setSaving(false)
      if (!r?.ok) return setResult({ ok: false, title: 'Invalid address', detail: r?.error || '' })
      setApiBase('')
    } else { setApiBase(v) }
    window.location.reload()
  }
  const apply = () => applyValue(val)
  // One tap for the two usual setups:
  //  - the drone Pi on Tailscale, by its machine name (MagicDNS)
  //  - the drone backend on this laptop (phone-link / VARUNA Cam), port 8000
  const useTailscalePi = () => applyValue(DRONE_PI_TAILSCALE)
  const useLocal = () => applyValue('http://127.0.0.1:8000')
  async function test() {
    setTesting(true); setResult(null)
    try { setResult(desktop ? await window.varuna.testPiAddress(val) : await testConnection(val)) }
    finally { setTesting(false) }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        {desktop
          ? <>Tap <strong className="text-ink">Drone Pi on Tailscale</strong> for the drone's Pi (Tailscale name <span className="font-mono">varuna-drone</span>), or <strong className="text-ink">Drone on this computer</strong> when the drone backend runs on this laptop (phone camera link). The desktop app forwards to it, so no CORS is needed. Saved on this PC.</>
          : <>Leave <strong className="text-ink">blank</strong> to go through the Vite proxy (recommended), or enter the drone Pi's Tailscale address (<span className="font-mono">{DRONE_PI_TAILSCALE}</span>) to call it directly.</>}
      </p>
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">
        {desktop ? 'Drone address (Tailscale name, IP or this computer)' : 'Backend base URL'}
      </label>
      <input
        value={val} onChange={(e) => setVal(e.target.value)}
        placeholder={desktop ? DRONE_PI_TAILSCALE : `blank = via Vite proxy   ·   or ${DRONE_PI_TAILSCALE}`}
        className="inp mb-3 w-full px-3 py-2 font-mono text-sm"
        spellCheck={false} autoCapitalize="off" autoCorrect="off"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!changed || saving} onClick={apply}>
          {saving ? <Spinner /> : desktop ? 'Save & reconnect' : 'Apply & reconnect'}
        </Btn>
        <Btn variant="secondary" onClick={useTailscalePi} disabled={saving}>Drone Pi on Tailscale</Btn>
        <Btn variant="secondary" onClick={useLocal} disabled={saving}>Drone on this computer</Btn>
        <Btn variant="secondary" onClick={test} disabled={testing}>
          {testing ? <Spinner /> : 'Test connection'}
        </Btn>
        {!desktop && <Btn variant="ghost" onClick={() => setVal(DEFAULT_API_BASE)}>Via proxy</Btn>}
      </div>
      <ConnectionResult result={result} />
      <p className="mt-2 text-[11px] text-faint">
        Plain <span className="font-mono">http://</span> is correct over Tailscale — WireGuard already encrypts the link.
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

// ── Boat connection (the boat's own Pi — same flow as the drone's) ──────────────
function BoatConnectionPanel({ shell }) {
  const desktop = shell.kind === 'desktop'
  const initial = desktop ? shell.config.boatAddress || '' : (getBoatBase() === BOAT_PROXY_BASE ? '' : getBoatBase())
  const [val,     setVal]     = useState(initial)
  const [saved]               = useState(initial)
  const [testing, setTesting] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [result,  setResult]  = useState(null)
  const changed = val.trim().replace(/\/+$/, '') !== saved.replace(/\/+$/, '')

  async function applyValue(v) {
    if (desktop) {
      setSaving(true)
      const r = await window.varuna.setBoatAddress(v)
      setSaving(false)
      if (!r?.ok) return setResult({ ok: false, title: 'Invalid address', detail: r?.error || '' })
      setBoatBase('')
    } else { setBoatBase(v) }
    window.location.reload()
  }
  const apply = () => applyValue(val)
  // One tap for the common setup: the boat backend ("Start VARUNA Boat") runs on
  // this same laptop on port 8001. Both the desktop app (via its own proxy) and
  // the browser (direct — the backend sends CORS) talk straight to loopback, so
  // this bypasses any stale address in settings or .env.local. The laptop's
  // boat program finds the boat phone over Tailscale (varuna-boat) by itself.
  const useLocal = () => applyValue('http://127.0.0.1:8001')
  async function test() {
    setTesting(true); setResult(null)
    try { setResult(desktop ? await window.varuna.testBoatAddress(val) : await testBoatConnection(val)) }
    finally { setTesting(false) }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        {desktop
          ? <>Tap <strong className="text-ink">Boat on this computer</strong> (the normal setup): "Start VARUNA Boat" runs on this laptop on 127.0.0.1:8001 and reaches the boat phone over Tailscale (<span className="font-mono">varuna-boat</span>) by itself. For a boat program on another computer, enter its Tailscale/LAN address. Saved on this PC.</>
          : <>Tap <strong className="text-ink">Boat on this computer</strong> to talk straight to 127.0.0.1:8001, leave <strong className="text-ink">blank</strong> for the Vite proxy, or enter a Tailscale/LAN address.</>}
      </p>
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">
        {desktop ? 'Boat program address' : 'Boat base URL'}
      </label>
      <input
        value={val} onChange={(e) => setVal(e.target.value)}
        placeholder={desktop ? 'http://127.0.0.1:8001' : 'blank = via Vite proxy   ·   or http://127.0.0.1:8001'}
        className="inp mb-3 w-full px-3 py-2 font-mono text-sm"
        spellCheck={false} autoCapitalize="off" autoCorrect="off"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!changed || saving} onClick={apply}>
          {saving ? <Spinner /> : desktop ? 'Save & reconnect' : 'Apply & reconnect'}
        </Btn>
        <Btn variant="secondary" onClick={useLocal} disabled={saving}>Boat on this computer</Btn>
        <Btn variant="secondary" onClick={test} disabled={testing}>
          {testing ? <Spinner /> : 'Test connection'}
        </Btn>
        {!desktop && <Btn variant="ghost" onClick={() => setVal('')}>Via proxy</Btn>}
      </div>
      <ConnectionResult result={result} />
      <p className="mt-2 text-[11px] text-faint">
        The address must answer as the VARUNA boat backend (boat-pi) — boat commands stay locked otherwise, so they can never reach the drone.
        No boat yet? Run the simulator on this laptop: <span className="font-mono">cd boat-pi &amp;&amp; python main.py --sim --port 8001</span>{desktop ? ' and tap Boat on this computer' : ''}.
      </p>
    </div>
  )
}

function BoatConnectionSection() {
  const shell = useShell()
  const boat = useBoat()
  if (shell.kind === 'loading') return <Section title="Boat connection"><Spinner label="Reading connection settings" /></Section>
  const addr = shell.kind === 'desktop' ? shell.config.boatAddress || 'Boat address not set' : getBoatBase() === BOAT_PROXY_BASE ? 'via Vite proxy' : getBoatBase()
  const level = boat.reachable === true ? 'ok' : boat.reachable === false ? 'bad' : 'idle'
  return (
    <Section title="Boat connection" right={
      <span className="flex items-center gap-2">
        <span className="max-w-[200px] truncate font-mono text-[11px] text-accent">{addr}</span>
        <StatusOrb level={level} size={10} />
      </span>
    }>
      <BoatConnectionPanel shell={shell} />
    </Section>
  )
}

// ── Health light (redesigned with icon slot) ───────────────────────────────────
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
              ) : Array.isArray(m.options) ? (
                <select value={val ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className="inp w-full px-2 py-1 font-mono text-sm">
                  {m.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
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
// Horizontal field of view of common drone cameras (at 16:9 video).
const CAMERA_PRESETS = [
  { label: 'Pi Camera v2', fov: 62 },
  { label: 'Pi Camera 3', fov: 66 },
  { label: 'Pi Camera 3 Wide', fov: 102 },
  { label: 'USB webcam', fov: 60 },
]
// Which way the top of the straight-down picture faces (geoProject.js rotationDeg).
const CAMERA_ROTATIONS = [
  { deg: 0, label: 'Front (usual)' },
  { deg: 90, label: 'Right side' },
  { deg: 180, label: 'Back' },
  { deg: 270, label: 'Left side' },
]
function FovPanel() {
  const s = useFovSettings()
  const cardStyle = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 12 }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div style={cardStyle} className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-ink">Camera field of view</div>
        <div className="text-[11px] text-muted">Turns a detection's size in pixels into a real size (&quot;≈30 cm&quot;) from the drone&apos;s altitude. Assumes the camera points straight down.</div>
        <div className="flex flex-wrap gap-1">
          {CAMERA_PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => setFovSettings({ fovHorizontalDeg: p.fov })}
              className="rounded-lg px-2 py-1 text-[10.5px] font-semibold transition-all"
              style={s.fovHorizontalDeg === p.fov
                ? { background: 'rgba(59,158,255,0.18)', color: 'var(--accent-hex, #3B9EFF)', border: '1px solid rgba(59,158,255,0.4)' }
                : { background: 'rgba(255,255,255,0.05)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {p.label} · {p.fov}°
            </button>
          ))}
        </div>
        <label className="text-[11px] text-muted">Horizontal field of view ({s.fovHorizontalDeg}°)</label>
        <input type="range" min={30} max={120} step={1} value={s.fovHorizontalDeg}
          onChange={(e) => setFovSettings({ fovHorizontalDeg: Number(e.target.value) })} className="w-full accent-accent" />
        <div className="text-[11px] text-muted">
          At 20 m the 1280×720 picture covers ≈{(1280 * metersPerPixel({ frameW: 1280, altitudeM: 20, fovHDeg: s.fovHorizontalDeg })).toFixed(1)} m
          × {(720 * metersPerPixel({ frameW: 1280, altitudeM: 20, fovHDeg: s.fovHorizontalDeg })).toFixed(1)} m — one pixel ≈ {(100 * metersPerPixel({ frameW: 1280, altitudeM: 20, fovHDeg: s.fovHorizontalDeg })).toFixed(1)} cm.
        </div>
        <div className="mt-1 text-xs font-semibold text-ink">Camera mounting</div>
        <div className="text-[11px] text-muted">Each item is placed on the map where it is in the picture (not under the drone), so the boat drives to the item itself. For that the app needs to know which way the camera faces.</div>
        <label className="text-[11px] text-muted">Top of the picture faces the drone&apos;s</label>
        <div className="flex flex-wrap gap-1">
          {CAMERA_ROTATIONS.map((r) => (
            <button key={r.deg} type="button" onClick={() => setFovSettings({ cameraRotationDeg: r.deg })}
              className="rounded-lg px-2 py-1 text-[10.5px] font-semibold transition-all"
              style={s.cameraRotationDeg === r.deg
                ? { background: 'rgba(59,158,255,0.18)', color: 'var(--accent-hex, #3B9EFF)', border: '1px solid rgba(59,158,255,0.4)' }
                : { background: 'rgba(255,255,255,0.05)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {r.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" className="accent-accent" checked={!!s.cameraGimbal}
            onChange={(e) => setFovSettings({ cameraGimbal: e.target.checked })} />
          Camera is on a stabilising gimbal (stays level when the drone tilts)
        </label>
        <div className="text-[11px] text-faint">
          Quick check: fly slowly forward — things on the water should slide toward the bottom of the picture.
          If they slide sideways or upward, change &quot;Top of the picture faces&quot;.
        </div>
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

// ── Section wrapper (the app's titled card) ────────────────────────────────────
function Section({ title, children, right }) {
  return (
    <section className="sx-section">
      <div className="sx-section-head">
        <h2>{title}</h2>
        {right}
      </div>
      <div className="sx-section-body">{children}</div>
    </section>
  )
}

const STATUS_ICON = {
  drone: <><path d="M12 9v6M9 12h6" /><circle cx="5" cy="5" r="2.5" /><circle cx="19" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  boat: <><path d="M3 15l2.5 4h13L21 15H3z" /><path d="M12 4v11M12 5l6 7h-6" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
}

function StatusTile({ label, sub, ok, icon }) {
  const tone = ok === true ? 'ok' : ok === false ? 'bad' : ''
  return (
    <div className="sx-well flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--sx-card)', border: '1px solid var(--sx-line)', color: 'var(--sx-sub)' }}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{STATUS_ICON[icon]}</svg>
      </span>
      <div className="min-w-[150px] flex-1">
        <div className="text-[14px] font-semibold text-ink">{label}</div>
        <div className="truncate text-[12.5px] text-muted">{sub}</div>
      </div>
      <Pill tone={tone}>{ok === true ? 'Connected' : ok === false ? 'Not connected' : 'Checking'}</Pill>
    </div>
  )
}

// The drone Pi's camera_source / source values, as the operator calls them.
const PANES = [
  ['connections', 'Connections'],
  ['alerts', 'Alerts'],
  ['camera', 'Size estimate'],
  ['maps', 'Offline maps'],
  ['tuning', 'Tuning'],
  ['advanced', 'Advanced'],
]

// ── Main screen ───────────────────────────────────────────────────────────────
export default function SystemScreen() {
  const { health } = useSystem()
  const boat = useBoat()
  const [pane, setPaneRaw] = useState(() => {
    try { return localStorage.getItem('varuna.systemPane') || 'connections' } catch { return 'connections' }
  })
  const setPane = (p) => {
    setPaneRaw(p)
    try { localStorage.setItem('varuna.systemPane', p) } catch { /* private mode */ }
  }

  const pixhawk = bool(pick(health.data, ['pixhawk_connected', 'pixhawk']))
  const camOk   = bool(pick(health.data, ['camera_connected', 'camera']))
  const boatBrain = boat.reachable === true ? boat.fcConnected : boat.reachable === false ? false : undefined
  const okCount = [pixhawk, camOk, boat.reachable === true, boatBrain === true].filter(Boolean).length
  const allOk = okCount === 4

  return (
    <Page>
      <TabHeader icon="system" title="System"
        hint="What is connected, and the settings for the drone, the boat and the app.">
        <Pill tone={allOk ? 'ok' : okCount >= 2 ? 'warn' : 'bad'}>{allOk ? 'All systems ready' : `${okCount} of 4 connected`}</Pill>
      </TabHeader>

      <Section title="Status" right={!allOk && <span className="text-[12.5px] text-muted">Not connected? Check Connections below.</span>}>
        <div className="grid gap-3 md:grid-cols-2">
          <StatusTile icon="drone"  label="Drone flight controller" sub="The drone's autopilot" ok={pixhawk} />
          <StatusTile icon="camera" label="Drone camera"            sub="Video for the plastic finder" ok={camOk} />
          <StatusTile icon="boat"   label="Boat link"               sub="The laptop's boat program" ok={boat.reachable} />
          <StatusTile icon="chip"   label="Boat controller"         sub="The boat's brain on its phone" ok={boatBrain} />
        </div>
      </Section>

      <div className="flex flex-col gap-3">
        <div className="sx-seg max-w-full self-start overflow-x-auto whitespace-nowrap" role="tablist" aria-label="Settings">
          {PANES.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={pane === k} aria-pressed={pane === k} onClick={() => setPane(k)}>{l}</button>
          ))}
        </div>

        {pane === 'connections' && (
          <div className="grid gap-4">
            <ConnectionSection />
            <BoatConnectionSection />
          </div>
        )}
        {pane === 'alerts' && (
          <Section title="Alerts">
            <p className="mb-3 text-[13px] text-muted">
              Big-dump alerts and report-ready notices by WhatsApp or email. Keys stay in this browser; only the message itself is sent.
            </p>
            <AlertsPanel />
          </Section>
        )}
        {pane === 'camera' && (
          <Section title="Camera view and size estimate">
            <p className="mb-3 text-[13px] text-muted">
              Used to estimate how big each item is. Reports mark these numbers as rough and print the setting chosen here.
            </p>
            <FovPanel />
          </Section>
        )}
        {pane === 'maps' && (
          <Section title="Offline maps">
            <OfflineMapsPanel />
          </Section>
        )}
        {pane === 'tuning' && (
          <Section title="Tuning">
            <TuningPanel />
          </Section>
        )}
        {pane === 'advanced' && (
          <Section title="Advanced">
            <div className="sx-label mb-2">MAVLink link preference (USB / TELEM2)</div>
            <LinkPreference />
            <p className="mt-2 text-[12.5px] text-muted">Which physical link the drone connection prefers. Leave on AUTO unless troubleshooting.</p>
          </Section>
        )}
      </div>
    </Page>
  )
}
