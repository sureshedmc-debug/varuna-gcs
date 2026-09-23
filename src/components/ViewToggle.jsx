import { motion } from 'framer-motion'

// Shared view-control icons + toggle button used across Map / Live / Detections.
export const EYE = <path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8z" fill="currentColor" />
export const EYE_OFF = <path d="M2 4l18 18-1.5 1.5-3-3A11 11 0 0112 19C7 19 3 14.5 2 12a13 13 0 013.7-4.8L.5 5.5 2 4zm10 4a4 4 0 013.9 4.9l-4.9-4.9A4 4 0 0112 8z" fill="currentColor" />
export const SWAP = <path d="M7 7h9l-2.5-2.5L15 3l5 5-5 5-1.5-1.5L16 9H7V7zm10 10H8l2.5 2.5L9 21l-5-5 5-5 1.5 1.5L8 15h9v2z" fill="currentColor" />

export function ViewToggle({ active, onClick, label, icon, compact = false }) {
  return (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.94 }}
      className={`glass flex items-center gap-2 font-semibold ${compact ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-2 text-xs'}`}
      style={{ color: active ? 'var(--accent-hex)' : 'var(--muted)' }}
      title={label}
    >
      <svg viewBox="0 0 24 24" width={compact ? 14 : 16} height={compact ? 14 : 16}>{icon}</svg>
      {label && <span>{label}</span>}
    </motion.button>
  )
}
