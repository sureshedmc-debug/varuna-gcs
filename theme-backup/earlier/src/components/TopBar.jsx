import { useState } from 'react'
import { useSystem } from './SystemContext'
import { StatusOrb } from './ui'
import { pick, bool, DASH } from '../lib/format'
import { getTheme, applyTheme, THEMES } from '../lib/theme'
import { useUser, displayName } from '../lib/auth'
import { useOnline } from '../lib/online'

function Stat({ label, value }) {
  return (
    <div className="hidden flex-col leading-tight lg:flex">
      <span className="text-[9px] tracking-wider text-faint">{label}</span>
      <span className="font-mono text-sm font-semibold tnum text-ink">{value}</span>
    </div>
  )
}

// ── Theme toggle — 3-way: dark ↔ green ↔ light ────────────────────────────
const THEME_META = {
  dark:  { icon: '🌑', label: 'Dark',  title: 'Switch to Pastel Green theme'  },
  green: { icon: '🌿', label: 'Green', title: 'Switch to Light theme'          },
  light: { icon: '☀️', label: 'Light', title: 'Switch to Dark theme'           },
}

function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme)

  function cycle() {
    const idx  = THEMES.indexOf(theme)
    const next = THEMES[(idx + 1) % THEMES.length]
    applyTheme(next)
    setTheme(next)
  }

  const meta = THEME_META[theme] || THEME_META.dark

  return (
    <button
      onClick={cycle}
      title={meta.title}
      aria-label={`Current theme: ${meta.label}. Click to switch.`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 10px',
        borderRadius: 8,
        border: '1px solid var(--line)',
        background: 'var(--chip)',
        cursor: 'pointer',
        transition: 'background 0.2s, border-color 0.2s',
        userSelect: 'none',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--chip2)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--chip)'  }}
    >
      {/* Track with 3 dots */}
      <span style={{ display:'flex', alignItems:'center', gap:3 }}>
        {THEMES.map(t => (
          <span
            key={t}
            style={{
              width:  t === theme ? 18 : 6,
              height: 6,
              borderRadius: 3,
              background: t === theme ? 'var(--accent-hex)' : 'var(--line)',
              transition: 'width 0.25s ease, background 0.25s ease',
              flexShrink: 0,
            }}
          />
        ))}
      </span>
      <span style={{ fontSize: 14, lineHeight: 1 }}>{meta.icon}</span>
      <span className="hidden xl:inline" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--accent-hex)' }}>
        {meta.label.toUpperCase()}
      </span>
    </button>
  )
}

/** Top mission status bar spanning the app. */
export function TopBar({ onLock, onMenu, navPinned, onAssistant, wakeState, onToggleWake }) {
  const { telemetry, backendReachable } = useSystem()
  const online = useOnline()
  const t = telemetry.data || {}
  const s = telemetry.status
  const level = backendReachable === false ? 'bad' : s === 'live' ? 'ok' : s === 'polling' ? 'warn' : 'bad'
  const conn  = backendReachable === false ? 'OFFLINE' : s === 'live' ? 'LINK LIVE' : s === 'polling' ? 'RECONNECT' : 'CONNECTING'
  const mode  = pick(t, ['flight_mode', 'mode', 'custom_mode']) || DASH
  const armed = bool(pick(t, ['armed', 'is_armed']))
  // Flight details only earn header space while there's a live link to report on
  const showFlight = s === 'live' && backendReachable !== false
  const user = useUser()

  return (
    <header
      className={`fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-line bg-white/95 backdrop-blur-sm px-4 py-2 transition-[padding] duration-500 ease-[cubic-bezier(.16,1,.3,1)] ${navPinned ? 'md:pl-[252px]' : 'md:pl-[36px]'}`}
      style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}
    >
      <div className="flex items-center gap-2">
        {onMenu && (
          <button
            onClick={onMenu}
            aria-label="Open navigation"
            className="mr-1 flex h-9 w-9 items-center justify-center rounded-lg bg-chip text-muted md:hidden"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M4 7h16M4 12h10M4 17h16" />
            </svg>
          </button>
        )}
        <span className="text-base font-bold tracking-[0.22em] text-ink">VARUNA</span>
        <span className="text-base font-bold tracking-[0.22em] text-accent">AI</span>
      </div>

      <div className="flex items-center gap-3 md:gap-4">
        {showFlight && (
          <>
            <Stat label="MODE"  value={mode} />
            <Stat label="STATE" value={armed === undefined ? DASH : armed ? 'ARMED' : 'DISARMED'} />
          </>
        )}

        {/* Signed-in operator */}
        {user && (
          <span
            className="hidden max-w-[180px] truncate rounded-lg bg-chip px-3 py-1.5 text-[11px] font-semibold text-ink sm:inline"
            title={[user.name, user.email].filter(Boolean).join(' · ')}
          >
            Hi, {displayName(user)}
          </span>
        )}

        {/* Link status pill */}
        <div className="flex items-center gap-2 rounded-lg bg-chip px-3 py-1.5">
          <StatusOrb level={level} size={9} pulse={s === 'polling' || s === 'connecting'} />
          <span className="text-[11px] font-semibold tracking-wider text-ink">{conn}</span>
        </div>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* Hi Varuna button */}
        {onAssistant && (
          <div className="flex items-center overflow-hidden rounded-lg" style={{ background: 'rgba(59,158,255,0.15)' }}>
            <button
              onClick={onAssistant}
              title={online ? 'Wake Varuna (or just say \u201cVaruna\u201d)' : 'No internet: the voice assistant needs it, unless a local model is set in its settings'}
              className="flex h-9 items-center gap-1.5 px-3 text-[11px] font-bold tracking-wider"
              style={{ color: 'var(--accent-hex)', opacity: online ? 1 : 0.5 }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13z" fill="currentColor" /></svg>
              <span className="hidden sm:inline">HI VARUNA</span>
            </button>
            {wakeState !== 'unsupported' && (
              <button
                onClick={onToggleWake}
                title={
                  wakeState === 'listening'
                    ? 'Listening for "Varuna" — click to turn the wake word off'
                    : wakeState === 'needs-key'
                      ? 'Voice wake in the desktop app needs a Groq API key — add one in the assistant settings'
                      : wakeState === 'blocked'
                        ? 'Microphone blocked — allow mic access for the wake word'
                        : 'Wake word off — click to listen for "Varuna"'
                }
                className="flex h-9 w-8 items-center justify-center border-l border-white/10"
                style={{ color: wakeState === 'listening' ? '#32D74B' : wakeState === 'blocked' ? '#FF453A' : wakeState === 'needs-key' ? '#FF9F0A' : 'var(--muted)' }}
              >
                <svg viewBox="0 0 24 24" width="15" height="15">
                  <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-3.1A7 7 0 0019 11h-2z" fill="currentColor" />
                  {wakeState !== 'listening' && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" />}
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Lock */}
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
