import { motion } from 'framer-motion'
import { StatusOrb } from './ui'

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
      {/* center action */}
      <motion.button
        onClick={onArm}
        disabled={busy}
        whileTap={{ scale: 0.9 }}
        whileHover={{ scale: 1.05 }}
        transition={{ type: 'spring', stiffness: 380, damping: 20 }}
        className="relative flex h-[86px] w-[86px] flex-col items-center justify-center rounded-full"
        style={{
          background: armed
            ? 'radial-gradient(circle at 35% 30%, #6BB8FF, #3B9EFF)'
            : `radial-gradient(circle at 35% 30%, ${c}dd, ${c}99)`,
          boxShadow: `0 0 26px ${armed ? '#3B9EFF' : c}aa, inset 0 2px 6px rgba(255,255,255,0.35)`,
          color: '#0A0C0F',
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" className="mb-0.5">
          <path d="M12 2l3.5 7L12 7.6 8.5 9 12 2zm0 6.5c3 2.2 4.5 5 4.5 8 0 2-1.2 4.5-4.5 5.5-3.3-1-4.5-3.5-4.5-5.5 0-3 1.5-5.8 4.5-8z" fill="currentColor" />
        </svg>
        <span className="text-[10px] font-bold tracking-wide">{busy ? '…' : armed ? 'ARMED' : 'ARM'}</span>
      </motion.button>
      {/* label chip */}
      <div className="absolute -bottom-1 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 backdrop-blur">
        <StatusOrb level={armed ? 'warn' : 'ok'} size={7} pulse={armed} />
        <span className="text-[10px] font-semibold tracking-wider text-ink">{label}</span>
      </div>
    </div>
  )
}
