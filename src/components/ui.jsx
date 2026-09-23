import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useRef } from 'react'
import { relTime } from '../lib/format'

// --- Status semantics: green=ok, amber=warn, red=bad. Used NOWHERE else. ---
// Tuned to -600 hues so they stay legible on a light canvas (field-safety).
export const STATUS = {
  ok: { color: '#32D74B', label: 'OK' },
  warn: { color: '#FF9F0A', label: 'WARN' },
  bad: { color: '#FF453A', label: 'FAULT' },
  idle: { color: '#98A0AB', label: '—' },
}

/** A status orb with believable volume + soft glow (not a flat circle). */
export function StatusOrb({ level = 'idle', size = 14, pulse = false }) {
  const c = (STATUS[level] || STATUS.idle).color
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {pulse && (
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ background: c }}
          animate={{ opacity: [0.45, 0], scale: [1, 2.2] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <span
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at 32% 28%, #ffffffcc, ${c} 60%, ${c})`,
          boxShadow: `0 0 10px ${c}66, inset 0 0 4px ${c}`,
        }}
      />
    </span>
  )
}

/** Glass card with an optional few-degree cursor tilt (preserve-3d). */
export function TiltCard({ children, className = '', tilt = true, ...rest }) {
  const ref = useRef(null)
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [6, -6]), { stiffness: 200, damping: 20 })
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-6, 6]), { stiffness: 200, damping: 20 })

  function onMove(e) {
    if (!tilt || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    mx.set((e.clientX - r.left) / r.width - 0.5)
    my.set((e.clientY - r.top) / r.height - 0.5)
  }
  function reset() {
    mx.set(0)
    my.set(0)
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={reset}
      style={{ rotateX: tilt ? rx : 0, rotateY: tilt ? ry : 0, transformPerspective: 900 }}
      className={`glass shadow-elev ${className}`}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

/** Primary/secondary/danger button with press depth + glow. Big touch target. */
export function Btn({ children, variant = 'primary', className = '', disabled, ...rest }) {
  const base =
    'touch relative inline-flex items-center justify-center gap-2 rounded-2xl px-5 font-semibold tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none'
  const textColor = {
    primary: 'text-white',
    danger: 'text-white',
    secondary: 'text-ink',
    ghost: 'text-ink',
  }
  const bg = {
    primary: {
      background: 'linear-gradient(180deg, var(--accent2), var(--accent-hex))',
      boxShadow: '0 8px 24px -6px rgb(var(--accent) / 0.5)',
    },
    danger: {
      background: 'linear-gradient(180deg,#FF6A61,#FF453A)',
      boxShadow: '0 8px 24px -6px rgba(255,69,58,0.45)',
    },
    secondary: { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' },
    ghost: { background: 'transparent', border: '1px solid rgba(255,255,255,0.14)' },
  }
  return (
    <motion.button
      whileTap={disabled ? {} : { scale: 0.96 }}
      whileHover={disabled ? {} : { scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      disabled={disabled}
      style={bg[variant]}
      className={`${base} ${textColor[variant]} ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  )
}

/** "last updated / stale / disconnected" badge for every live value block. */
export function StaleBadge({ lastUpdate, now, staleAfter = 6000, connected = true }) {
  const age = now - lastUpdate
  let level = 'ok'
  let text = relTime(lastUpdate, now)
  if (!connected || !lastUpdate) {
    level = 'bad'
    text = 'disconnected'
  } else if (age > staleAfter) {
    level = 'warn'
    text = `stale · ${relTime(lastUpdate, now)}`
  }
  const c = STATUS[level].color
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tnum"
      style={{ background: `${c}16`, color: c, border: `1px solid ${c}40` }}
    >
      <StatusOrb level={level} size={7} />
      {text}
    </span>
  )
}

export function Field({ label, value, unit, level, mono = true }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      <span
        className={`text-2xl font-semibold ${mono ? 'font-mono tnum' : ''}`}
        style={level ? { color: STATUS[level]?.color } : { color: '#EDEFF2' }}
      >
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted">{unit}</span>}
      </span>
    </div>
  )
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center gap-3 text-muted">
      <motion.span
        className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      />
      <span className="text-sm">{label}…</span>
    </div>
  )
}
