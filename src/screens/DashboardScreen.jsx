import { lazy, Suspense } from 'react'
import { motion } from 'framer-motion'
import { api } from '../api/client'
import { useSystem } from '../components/SystemContext'
import { usePolling } from '../hooks/usePolling'
import { StatusOrb, StaleBadge, TiltCard } from '../components/ui'
import { pick, bool, num, DASH } from '../lib/format'

// Signature 3D moment — code-split so `three` never blocks first paint.
const DroneScene = lazy(() => import('../components/DroneScene'))

const NAV_CARDS = [
  {
    id: 'live',
    title: 'Live',
    sub: 'Video feed, telemetry & flight control',
    icon: <path d="M4 6h16v12H4zM9 10l5 3-5 3v-6z" fill="currentColor" />,
  },
  {
    id: 'mission',
    title: 'Mission',
    sub: 'Plan & fly waypoint routes',
    icon: <path d="M12 2l7 4v12l-7 4-7-4V6l7-4zm0 4l-3 2 3 2 3-2-3-2z" fill="currentColor" />,
  },
  {
    id: 'detections',
    title: 'Detections',
    sub: 'Debris log & environmental report',
    icon: <path d="M4 5h16v3H4zM4 10h16v3H4zM4 15h10v3H4z" fill="currentColor" />,
  },
  {
    id: 'system',
    title: 'System',
    sub: 'Health, Pi metrics & live tuning',
    icon: (
      <path
        d="M12 8a4 4 0 100 8 4 4 0 000-8zm8 4l2-1-1-3-2 .5a7 7 0 00-1-1L18 5l-3-1-1 2a7 7 0 00-2 0L11 4 8 5l.5 2a7 7 0 00-1 1L5 7.5 4 10.5 6 12l-2 1.5L5 16.5l2-.5a7 7 0 001 1L7.5 19l3 1 1-2h1l1 2 3-1-.5-2a7 7 0 001-1l2 .5 1-3-2-1z"
        fill="currentColor"
      />
    ),
  },
]

function Vital({ label, value, unit, level }) {
  const c = level ? { ok: '#16A34A', warn: '#D97706', bad: '#DC2626' }[level] : '#0F172A'
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      <span className="flex items-center gap-2 font-mono text-xl font-semibold tnum" style={{ color: c }}>
        {level && <StatusOrb level={level} size={10} />}
        {value}
        {unit && <span className="text-xs font-normal text-muted">{unit}</span>}
      </span>
    </div>
  )
}

function NavCard({ card, onNavigate, i }) {
  return (
    <motion.button
      onClick={() => onNavigate(card.id)}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.97 }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + i * 0.05, type: 'spring', stiffness: 260, damping: 24 }}
      className="glass shadow-elev group relative flex items-center gap-4 overflow-hidden p-5 text-left"
    >
      <span
        className="absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.35), transparent 70%)' }}
      />
      <span
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[#03252C]"
        style={{ background: 'linear-gradient(180deg,#2DD4EE,#06B6D4)', boxShadow: '0 8px 20px -8px rgba(6,182,212,0.6)' }}
      >
        <svg viewBox="0 0 24 24" width="24" height="24">
          {card.icon}
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-lg font-bold text-ink">{card.title}</div>
        <div className="text-sm text-muted">{card.sub}</div>
      </div>
      <svg viewBox="0 0 24 24" width="20" height="20" className="shrink-0 text-muted transition-transform group-hover:translate-x-1">
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </motion.button>
  )
}

export default function DashboardScreen({ onNavigate }) {
  const { telemetry, health, backendReachable } = useSystem()
  const det = usePolling(() => api.aiDetections(50), 8000)

  const t = telemetry.data || {}
  const armed = bool(pick(t, ['armed', 'is_armed']))
  const mode = pick(t, ['flight_mode', 'mode', 'custom_mode'])
  const volt = pick(t, ['battery_voltage', 'voltage', 'battery'])
  const sats = pick(t, ['satellites', 'satellites_visible', 'num_sats', 'sats'])
  const alt = pick(t, ['altitude', 'alt', 'relative_alt', 'rel_alt'])
  const connected = telemetry.status === 'live' || telemetry.status === 'polling'

  const voltN = Number(volt)
  const battLevel = Number.isNaN(voltN) ? 'idle' : voltN >= 11.1 ? 'ok' : voltN >= 10.5 ? 'warn' : 'bad'
  const satN = Number(sats)
  const gpsLevel = satN >= 6 ? 'ok' : satN >= 4 ? 'warn' : 'bad'

  const pixhawk = bool(pick(health.data, ['pixhawk_connected', 'pixhawk']))
  const camOk = bool(pick(health.data, ['camera_connected', 'camera']))
  const detCount = det.data?.detections?.length

  return (
    <>
      {/* 3D drone backdrop — glass cards blur it into a frosted, cinematic depth */}
      <Suspense fallback={null}>
        <div className="pointer-events-none fixed inset-0 z-0">
          <DroneScene />
        </div>
      </Suspense>

      <div className="relative z-10 mx-auto mt-36 flex max-w-5xl flex-col gap-4 sm:mt-44">
      {/* Hero: system overview */}
      <TiltCard tilt={false} className="p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-ink">Ground Control</h1>
            <p className="text-sm text-muted">River-cleanup drone · system overview</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-3 py-1 text-xs font-bold"
              style={{
                background: armed ? 'rgba(220,38,38,0.12)' : 'rgba(22,163,74,0.12)',
                color: armed ? '#B91C1C' : '#15803D',
              }}
            >
              {armed === undefined ? 'STATUS UNKNOWN' : armed ? 'ARMED' : 'DISARMED'}
            </span>
            <StaleBadge lastUpdate={telemetry.lastUpdate} connected={connected} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Vital label="Mode" value={mode || DASH} />
          <Vital label="Battery" value={num(volt, 1)} unit="V" level={battLevel} />
          <Vital label="GPS" value={num(sats, 0)} unit="sats" level={gpsLevel} />
          <Vital label="Altitude" value={num(alt, 1)} unit="m" />
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          {[
            { label: 'Link', ok: connected, note: connected ? 'Connected' : 'Down' },
            { label: 'Backend', ok: backendReachable, note: backendReachable === false ? 'Unreachable' : 'Reachable' },
            { label: 'Pixhawk', ok: pixhawk, note: pixhawk ? 'Connected' : 'Off' },
            { label: 'Camera', ok: camOk, note: camOk ? 'Active' : 'Offline' },
          ].map((h) => (
            <span key={h.label} className="glass-soft flex items-center gap-2 px-3 py-1.5 text-sm">
              <StatusOrb level={h.ok === true ? 'ok' : h.ok === false ? 'bad' : 'idle'} size={10} pulse={h.ok === false} />
              <span className="font-semibold text-ink">{h.label}</span>
              <span className="text-muted">{h.note}</span>
            </span>
          ))}
          {detCount != null && (
            <span className="glass-soft flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="font-mono text-base font-bold text-accent tnum">{detCount}</span>
              <span className="text-muted">recent detections</span>
            </span>
          )}
        </div>
      </TiltCard>

      {/* Navigation cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        {NAV_CARDS.map((c, i) => (
          <NavCard key={c.id} card={c} onNavigate={onNavigate} i={i} />
        ))}
      </div>
      </div>
    </>
  )
}
