import { motion } from 'framer-motion'
import { StatusOrb, CommandButton } from './ui'

/**
 * Radial launch/arm control that sits on the map over the aircraft — the
 * signature gesture: concentric rings, a slowly rotating dashed ring, and a
 * center action that arms (press) with genuine press depth. Original artwork.
 */
export function RadialLaunch({ armed, busy, onArm, label = 'LAUNCH SITE', tone = 'mint' }) {
  const c = tone === 'orange' ? '#3B9EFF' : '#34D399'
  return (
    <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>
      {/* outer soft glow */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `radial-gradient(circle, ${c}22, transparent 62%)` }}
      />
      {/* static rings */}
      <div className="absolute inset-3 rounded-full" style={{ border: `1px solid ${c}55` }} />
      <div className="absolute inset-8 rounded-full" style={{ border: `1px solid ${c}33` }} />
      {/* rotating dashed ring */}
      <motion.svg
        className="absolute inset-0"
        viewBox="0 0 180 180"
        animate={{ rotate: 360 }}
        transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
      >
        <circle cx="90" cy="90" r="72" fill="none" stroke={c} strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="3 10" />
      </motion.svg>
      {/* expanding pulse */}
      <motion.div
        className="absolute rounded-full"
        style={{ width: 120, height: 120, border: `1px solid ${c}` }}
        animate={{ scale: [0.8, 1.25], opacity: [0.5, 0] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
      />
      {/* center action — swipe-to-confirm arm/disarm */}
      <div className="relative">
        <CommandButton cmd={armed ? 'disarm' : 'arm'} disabled={busy} onConfirm={onArm} />
      </div>
      {/* label chip */}
      <div className="absolute -bottom-1 flex items-center gap-1.5 rounded-full bg-white/90 backdrop-blur px-2.5 py-1 shadow-lg border border-line">
        <StatusOrb level={armed ? 'warn' : 'ok'} size={7} pulse={armed} />
        <span className="text-[10px] font-semibold tracking-wider text-ink">{label}</span>
      </div>
    </div>
  )
}
