import { useState } from 'react'
import { motion } from 'framer-motion'
import { getTheme, applyTheme } from '../lib/theme'

const MOON = <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="currentColor" />
const SUN = (
  <g fill="currentColor">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2 2M17.5 17.5l2 2M19.5 4.5l-2 2M6.5 17.5l-2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </g>
)

/** Segmented Dark / Light theme switch (blue vs cyan/sky). */
export function ThemeToggle() {
  const [theme, setThemeState] = useState(getTheme())
  function set(t) {
    setThemeState(t)
    applyTheme(t)
  }
  return (
    <div className="glass flex items-center gap-1 p-1">
      {[
        ['dark', 'Dark', MOON],
        ['light', 'Light', SUN],
      ].map(([id, label, icon]) => (
        <button
          key={id}
          onClick={() => set(id)}
          className="relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold"
          style={{ color: theme === id ? '#fff' : 'var(--muted)' }}
        >
          {theme === id && (
            <motion.span
              layoutId="theme-ind"
              className="absolute inset-0 rounded-lg"
              style={{ background: 'linear-gradient(180deg, var(--accent2), var(--accent-hex))' }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            />
          )}
          <svg viewBox="0 0 24 24" width="13" height="13" className="relative z-10">{icon}</svg>
          <span className="relative z-10">{label}</span>
        </button>
      ))}
    </div>
  )
}
