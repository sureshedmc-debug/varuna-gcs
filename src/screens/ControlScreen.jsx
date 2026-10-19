import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { useToast } from '../components/Toast'
import { StaleBadge, StatusOrb, CommandButton, CommandPanel } from '../components/ui'
import { pick, num, DASH } from '../lib/format'
import { cmd, isOk } from '../lib/commands'
import { useKeyboardFlight } from '../hooks/useKeyboardFlight'

// Control tab: fly the DRONE from the laptop keyboard and switch its flight
// modes, over a plain live view (no AI detection). The boat is driven by its
// game controller on the Boat tab — nothing here touches the boat.

const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const RED = '#FF453A'
const BLUE = '#0A84FF'
const GLASS = { background: 'rgba(13,17,26,0.88)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(16px)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }

const MODES = [
  { mode: 'LOITER', label: 'Loiter', hint: 'Hold position (GPS)' },
  { mode: 'POSHOLD', label: 'PosHold', hint: 'Position hold, softer sticks' },
  { mode: 'ALT_HOLD', label: 'Alt Hold', hint: 'Hold height only — drifts with wind' },
  { mode: 'BRAKE', label: 'Brake', hint: 'Stop right now and hover' },
  { mode: 'AUTO', label: 'Auto', hint: 'Fly the uploaded mission' },
  { mode: 'RTL', label: 'RTL', hint: 'Return home and land' },
  { mode: 'LAND', label: 'Land', hint: 'Land right here' },
]

function readT(d) {
  return {
    mode: pick(d, ['flight_mode', 'mode']),
    armed: pick(d, ['armed']),
    alt: pick(d, ['relative_alt', 'altitude', 'alt']),
    speed: pick(d, ['groundspeed', 'speed']),
    volt: pick(d, ['battery_voltage', 'voltage']),
    pct: pick(d, ['battery_percent', 'battery_remaining']),
    fix: pick(d, ['gps_fix', 'fix_type']),
    sats: pick(d, ['satellites', 'sats']),
    heading: pick(d, ['heading', 'yaw']),
    fc: pick(d, ['fc_connected']),
    kb: d?.keyboard || null,
  }
}

function Metric({ label, value, unit, level }) {
  const color = level === 'bad' ? RED : level === 'warn' ? AMBER : undefined
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-[15px] font-semibold tnum text-ink" style={color ? { color } : undefined}>
        {value ?? DASH}{unit ? <span className="ml-0.5 text-[10px] text-muted">{unit}</span> : null}
      </div>
    </div>
  )
}

function Key({ label, on, wide }) {
  return (
    <span className="flex items-center justify-center rounded-md font-mono text-[11px] font-bold transition-all"
      style={{
        width: wide ? 58 : 28, height: 26,
        background: on ? 'rgba(50,215,75,0.22)' : 'rgba(255,255,255,0.06)',
        border: `1px solid ${on ? 'rgba(50,215,75,0.6)' : 'rgba(255,255,255,0.12)'}`,
        color: on ? GREEN : 'var(--muted)', boxShadow: on ? '0 0 10px rgba(50,215,75,0.35)' : 'none',
      }}>{label}</span>
  )
}

function SpeedSlider({ label, value, min, max, step, unit, onSave }) {
  const [v, setV] = useState(value)
  useEffect(() => { if (value != null) setV(value) }, [value])
  const save = (x) => onSave(Number(x))
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10.5px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono font-semibold tnum text-ink">{v ?? DASH} {unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={v ?? min} className="w-full accent-accent"
        onChange={(e) => setV(Number(e.target.value))}
        onMouseUp={(e) => save(e.target.value)} onTouchEnd={(e) => save(e.target.value)} onKeyUp={(e) => save(e.target.value)} />
    </div>
  )
}

export default function ControlScreen() {
  const { telemetry, simulated } = useSystem()
  const toast = useToast()
  const t = readT(telemetry.data)
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'
  const real = connected && !simulated && t.fc !== false
  // The camera hangs off the Pi, not the Pixhawk: show it whenever the Pi answers.
  const piUp = connected && !simulated
  const flying = !!t.armed && Number(t.alt) > 1
  const kbActive = real && !!t.kb?.active
  const [busy, setBusy] = useState(null)
  const [last, setLast] = useState(null)
  const [videoOk, setVideoOk] = useState(true)

  const kb = useKeyboardFlight({
    enabled: real,
    active: kbActive,
    onAction: (msg, okay) => {
      setLast({ msg, ok: okay, t: Date.now() })
      if (!okay) toast.push({ level: 'warn', title: msg })
    },
  })

  // Leaving the Control tab parks the drone in BRAKE (hovers in place, whatever
  // the transmitter's sticks say), rather than leaving it in keyboard flight
  // with nobody at the keys.
  const activeRef = useRef(kbActive)
  activeRef.current = kbActive
  useEffect(() => () => {
    if (activeRef.current) api.controlRelease().catch(() => {})
  }, [])

  async function run(key, fn, okMsg) {
    setBusy(key)
    try { toast.fromResult(await fn(), okMsg) }
    catch (e) { toast.push({ level: 'bad', title: `Command failed: ${e?.message || e}` }) }
    finally { setBusy(null) }
  }

  function setMode(m) {
    if (simulated) {
      if (m === 'RTL') return run('mode', cmd.rtl, 'Returning home')
      if (m === 'LAND') return run('mode', cmd.land, 'Landing')
      return toast.push({ level: 'warn', title: 'Flight modes need the real drone', msg: 'The simulator only flies the Live tab commands.' })
    }
    return run('mode', () => api.setMode(m), `Mode ${m}`)
  }

  function takeoff() {
    const v = window.prompt('Takeoff altitude (meters)?', '5')
    if (v == null) return
    const alt = Number(v)
    if (Number.isNaN(alt) || alt <= 0) return toast.push({ level: 'warn', title: 'Enter a valid altitude' })
    run('takeoff', () => cmd.takeoff(alt), 'Taking off')
  }

  async function saveKb(key, value) {
    const res = await api.setConfig({ [key]: value }).catch(() => null)
    if (!isOk(res)) return toast.push({ level: 'warn', title: 'Could not save the setting', msg: res?.message || '' })
    api.saveConfig().catch(() => {})   // keep it after the Pi restarts
  }

  const voltN = Number(t.volt)
  const battLevel = Number.isNaN(voltN) ? undefined : voltN >= 11.1 ? 'ok' : voltN >= 10.5 ? 'warn' : 'bad'
  const fixN = Number(t.fix) || 0

  let chip = { text: 'NO DRONE', color: '#98A0AB' }
  if (simulated) chip = { text: 'SIMULATOR', color: '#F59E0B' }
  else if (real && kbActive && !kb.focused) chip = { text: 'PAUSED', color: AMBER }
  else if (real && kbActive) chip = { text: kb.linked ? 'ACTIVE' : 'CONNECTING', color: kb.linked ? GREEN : AMBER }
  else if (real && flying) chip = { text: 'READY — PRESS G', color: BLUE }
  else if (real) chip = { text: 'NOT FLYING', color: '#98A0AB' }

  const h = kb.held
  return (
    <div className="relative" style={{ height: 'calc(100vh - 66px)' }}>

      {/* ── Plain live view (no detection) ── */}
      <div className="absolute inset-0 z-0 overflow-hidden rounded-2xl border border-line" style={{ background: '#05070B' }}>
        {piUp && videoOk ? (
          <img src={api.streamUrl()} alt="Drone camera" className="h-full w-full object-contain"
            onError={() => setVideoOk(false)} onLoad={() => setVideoOk(true)} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <span className="text-3xl">📡</span>
            {simulated ? 'Simulator — no camera. Connect the drone to see its live view.' : piUp ? 'No video from the drone camera.' : 'Drone not connected.'}
            {piUp && !videoOk && <button className="text-[12px] font-semibold text-accent" onClick={() => setVideoOk(true)}>Retry video</button>}
          </div>
        )}
      </div>

      {/* ── Top-left: status pill + flight modes ── */}
      <div className="absolute left-3 top-3 z-20 flex w-[230px] max-w-[calc(100vw-24px)] flex-col gap-2">
        <div className="flex w-max items-center gap-2 whitespace-nowrap rounded-full px-3 py-1.5" style={{ background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(10px)' }}>
          <StatusOrb level={connected ? 'ok' : 'bad'} size={9} pulse={!connected} />
          <span className="text-[13px] font-bold text-ink">CONTROL · VARUNA-01</span>
          <StaleBadge lastUpdate={telemetry.lastUpdate} connected={connected} />
        </div>
        <div className="rounded-2xl p-3" style={GLASS}>
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Flight mode</span>
            <span className="font-mono text-[11px] font-bold" style={{ color: kbActive ? GREEN : 'var(--accent-hex)' }}>{t.mode || DASH}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {MODES.map((m) => {
              const on = t.mode === m.mode
              return (
                <button key={m.mode} type="button" title={m.hint} disabled={!connected || busy === 'mode'}
                  onClick={() => setMode(m.mode)}
                  className="rounded-lg px-2 py-1.5 text-center text-[11.5px] font-bold transition-all active:scale-95 disabled:opacity-40"
                  style={on
                    ? { background: 'rgba(10,132,255,0.2)', border: '1px solid rgba(10,132,255,0.55)', color: '#64B5FF' }
                    : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', color: 'var(--ink)' }}>
                  {m.label}
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-[10px] text-faint">G = keyboard (GUIDED). Any mode ends it.</div>
        </div>
      </div>

      {/* ── Top-right: telemetry ── */}
      <div className="absolute right-3 top-3 z-20 w-[230px]">
        <div className="rounded-2xl p-4" style={GLASS}>
          <div className="mb-3 flex items-center justify-between">
            <span className="eyebrow">Telemetry</span>
            <span className="rounded-md px-2 py-0.5 text-[10px] font-bold"
              style={{ background: t.armed ? 'rgba(255,69,58,0.16)' : 'rgba(50,215,75,0.14)', color: t.armed ? '#FF8A80' : '#7BE495', border: `1px solid ${t.armed ? 'rgba(255,69,58,0.3)' : 'rgba(50,215,75,0.25)'}` }}>
              {t.armed === undefined ? 'UNKNOWN' : t.armed ? '● ARMED' : '○ DISARMED'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Alt" value={num(t.alt, 1)} unit="m" />
            <Metric label="Speed" value={num(t.speed, 1)} unit="m/s" />
            <Metric label="Battery" value={t.pct != null ? num(t.pct, 0) : num(t.volt, 1)} unit={t.pct != null ? '%' : 'V'} level={battLevel} />
            <Metric label="GPS" value={fixN >= 3 ? '3D' : fixN ? `${fixN}D` : 'none'} unit={`· ${num(t.sats, 0)}`} level={fixN >= 3 ? 'ok' : 'bad'} />
            <Metric label="Heading" value={t.heading == null ? DASH : num(t.heading, 0)} unit="°" />
            <Metric label="Keys" value={kbActive ? 'ON' : 'OFF'} level={kbActive ? 'ok' : undefined} />
          </div>
        </div>
      </div>

      {/* ── Bottom-left: keyboard flight ── */}
      <div className="absolute bottom-3 left-3 z-20 w-[300px] max-w-[calc(100vw-24px)]">
        <div className="rounded-2xl p-3.5" style={GLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[13px] font-bold text-ink">⌨ Keyboard flight</span>
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${chip.color}22`, color: chip.color }}>{chip.text}</span>
          </div>

          {kbActive ? (
            <button type="button" onClick={kb.release} className="mb-2.5 w-full rounded-xl py-2 text-[12.5px] font-bold transition-all active:scale-95"
              style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--ink)' }}>
              Release control (Esc) → Brake (hover)
            </button>
          ) : (
            <button type="button" onClick={kb.take} disabled={!real || !flying}
              className="mb-2.5 w-full rounded-xl py-2 text-[12.5px] font-bold transition-all active:scale-95 disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg,#32D74B,#0e8f28)', color: '#fff', border: '1px solid rgba(50,215,75,0.4)', boxShadow: '0 0 16px rgba(50,215,75,0.3)' }}>
              Take keyboard control (G)
            </button>
          )}

          <div className="mb-2 flex items-start justify-between">
            <div className="flex flex-col items-center gap-1">
              <Key label="W" on={h.has('KeyW')} />
              <div className="flex gap-1"><Key label="A" on={h.has('KeyA')} /><Key label="S" on={h.has('KeyS')} /><Key label="D" on={h.has('KeyD')} /></div>
              <span className="text-[9.5px] text-muted">move</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Key label="↑" on={h.has('ArrowUp')} />
              <div className="flex gap-1"><Key label="←" on={h.has('ArrowLeft')} /><Key label="↓" on={h.has('ArrowDown')} /><Key label="→" on={h.has('ArrowRight')} /></div>
              <span className="text-[9.5px] text-muted">height · turn</span>
            </div>
          </div>
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-muted">
            <span><Key label="Shift" wide on={h.has('ShiftLeft') || h.has('ShiftRight')} /> slow</span>
            <span className="flex items-center gap-1"><Key label="Space" wide /> brake</span>
            <span className="flex items-center gap-1"><Key label="Esc" wide /> release</span>
          </div>

          {real && (
            <div className="mb-2 grid grid-cols-2 gap-x-3">
              <SpeedSlider label="Speed" value={t.kb?.speed_mps} min={0.5} max={5} step={0.5} unit="m/s" onSave={(v) => saveKb('kb_speed_mps', v)} />
              <SpeedSlider label="Climb" value={t.kb?.climb_mps} min={0.2} max={2} step={0.1} unit="m/s" onSave={(v) => saveKb('kb_climb_mps', v)} />
            </div>
          )}

          {kbActive && t.kb?.limit && <div className="mb-1 text-[11px]" style={{ color: AMBER }}>Limited: {t.kb.limit}</div>}
          {kbActive && !kb.focused && <div className="mb-1 text-[11px]" style={{ color: AMBER }}>This window is in the background: keys are ignored and the drone hovers. Click here to fly.</div>}
          {last && Date.now() - last.t < 15000 && <div className="mb-1 text-[11px]" style={{ color: last.ok ? GREEN : AMBER }}>{last.msg}</div>}
          <div className="text-[10px] leading-snug text-faint"
            title={`No keys = hover. Never below ${num(t.kb?.min_alt_m ?? 3, 0)} m by keyboard — use LAND. App silent for ${t.kb ? 'a while' : '20 s'} → ${t.kb?.lost_action === 'hover' ? 'hover' : t.kb?.lost_action === 'land' ? 'land' : 'return home'}. Release (Esc) or leaving this tab → Brake (hovers in place, ignoring the transmitter's sticks).`}>
            {simulated
              ? 'Keyboard flight needs the real drone, not the simulator.'
              : `ARM → TAKEOFF → G. No keys = hover · min ${num(t.kb?.min_alt_m ?? 3, 0)} m · leaving → Brake.`}
          </div>
        </div>
      </div>

      {/* ── Bottom-center: flight commands ── */}
      <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <div className="flex items-center rounded-[40px] px-4 py-2.5" style={{ background: 'rgba(10,14,24,0.88)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(16px)' }}>
          <CommandPanel>
            <CommandButton cmd={t.armed ? 'disarm' : 'arm'} disabled={busy === 'arm'}
              onConfirm={() => run('arm', () => cmd.arm(!t.armed), t.armed ? 'Disarmed' : 'Armed')} />
            <CommandButton cmd="takeoff" disabled={busy === 'takeoff'} onConfirm={takeoff} />
            <CommandButton cmd="rth" disabled={busy === 'rtl'} onConfirm={() => run('rtl', cmd.rtl, 'Returning home')} />
            <CommandButton cmd="land" disabled={busy === 'land'} onConfirm={() => run('land', cmd.land, 'Landing')} />
            <CommandButton cmd="stop" disabled={busy === 'stop'} onConfirm={() => run('stop', cmd.emergencyStop, 'Emergency stop')} />
          </CommandPanel>
        </div>
      </div>
    </div>
  )
}
