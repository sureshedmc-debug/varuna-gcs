import { useSystem } from './SystemContext'
import { StatusOrb } from './ui'
import { pick, bool, DASH } from '../lib/format'

function Stat({ label, value }) {
  return (
    <div className="hidden flex-col leading-tight lg:flex">
      <span className="text-[9px] tracking-wider text-faint">{label}</span>
      <span className="font-mono text-sm font-semibold tnum text-ink">{value}</span>
    </div>
  )
}

/** Top mission status bar spanning the app (matches the reference top strip). */
export function TopBar({ onLock, onAssistant, wakeState, onToggleWake }) {
  const { telemetry, backendReachable } = useSystem()
  const t = telemetry.data || {}
  const s = telemetry.status
  const level = backendReachable === false ? 'bad' : s === 'live' ? 'ok' : s === 'polling' ? 'warn' : 'bad'
  const conn = backendReachable === false ? 'OFFLINE' : s === 'live' ? 'LINK LIVE' : s === 'polling' ? 'RECONNECT' : 'CONNECTING'
  const mode = pick(t, ['flight_mode', 'mode', 'custom_mode']) || DASH
  const armed = bool(pick(t, ['armed', 'is_armed']))

  return (
    <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-line bg-[#0B0E12]/80 px-4 py-2 md:pl-[92px]" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}>
      <div className="flex items-center gap-2">
        <span className="text-base font-bold tracking-[0.22em] text-ink">VARUNA</span>
        <span className="text-base font-bold tracking-[0.22em] text-accent">AI</span>
        <span className="ml-2 hidden rounded-md bg-chip px-2 py-0.5 text-[10px] font-semibold tracking-wider text-muted sm:inline">
          GROUND CONTROL
        </span>
      </div>

      <div className="flex items-center gap-5">
        <Stat label="AIRCRAFT" value="VARUNA-01" />
        <Stat label="MODE" value={mode} />
        <Stat label="STATE" value={armed === undefined ? DASH : armed ? 'ARMED' : 'DISARMED'} />
        <div className="flex items-center gap-2 rounded-lg bg-chip px-3 py-1.5">
          <StatusOrb level={level} size={9} pulse={s === 'polling' || s === 'connecting'} />
          <span className="text-[11px] font-semibold tracking-wider text-ink">{conn}</span>
        </div>
        {onAssistant && (
          <div className="flex items-center overflow-hidden rounded-lg" style={{ background: 'rgba(59,158,255,0.15)' }}>
            <button
              onClick={onAssistant}
              title="Wake Varuna (or just say “Hi Varuna”)"
              className="flex h-9 items-center gap-1.5 px-3 text-[11px] font-bold tracking-wider"
              style={{ color: 'var(--accent-hex)' }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13z" fill="currentColor" /></svg>
              <span className="hidden sm:inline">HI VARUNA</span>
            </button>
            {wakeState !== 'unsupported' && (
              <button
                onClick={onToggleWake}
                title={
                  wakeState === 'listening'
                    ? 'Listening for “Hi Varuna” — click to turn the wake word off'
                    : wakeState === 'blocked'
                      ? 'Microphone blocked — allow mic access for the wake word'
                      : 'Wake word off — click to listen for “Hi Varuna”'
                }
                className="flex h-9 w-8 items-center justify-center border-l border-white/10"
                style={{ color: wakeState === 'listening' ? '#32D74B' : wakeState === 'blocked' ? '#FF453A' : 'var(--muted)' }}
              >
                <svg viewBox="0 0 24 24" width="15" height="15">
                  <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-3.1A7 7 0 0019 11h-2z" fill="currentColor" />
                  {wakeState !== 'listening' && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" />}
                </svg>
              </button>
            )}
          </div>
        )}
        <button
          onClick={onLock}
          title="Lock app"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-chip text-muted transition-colors hover:text-bad"
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M6 10V8a6 6 0 1112 0v2h1a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1h1zm2 0h8V8a4 4 0 10-8 0v2z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  )
}
