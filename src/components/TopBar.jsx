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
export function TopBar({ onLock, onAssistant, assistantOpen }) {
  const { telemetry, backendReachable } = useSystem()
  const t = telemetry.data || {}
  const s = telemetry.status
  const level = backendReachable === false ? 'bad' : s === 'live' ? 'ok' : s === 'polling' ? 'warn' : 'bad'
  const conn = backendReachable === false ? 'OFFLINE' : s === 'live' ? 'LINK LIVE' : s === 'polling' ? 'RECONNECT' : 'CONNECTING'
  const mode = pick(t, ['flight_mode', 'mode', 'custom_mode']) || DASH
  const armed = bool(pick(t, ['armed', 'is_armed']))

  return (
    <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-line bg-[#0B0E12]/70 px-4 py-2 backdrop-blur-xl md:pl-[92px]" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}>
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
          <button
            onClick={onAssistant}
            title="VARUNA Assist — voice & chat co-pilot"
            className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-[11px] font-bold tracking-wider transition-colors"
            style={{ background: assistantOpen ? 'var(--accent-hex)' : 'rgba(59,158,255,0.15)', color: assistantOpen ? '#fff' : 'var(--accent-hex)' }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13z" fill="currentColor" /></svg>
            <span className="hidden sm:inline">ASK AI</span>
          </button>
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
