import { motion } from 'framer-motion'

const ICONS = {
  home: <path d="M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3l9-8z" fill="currentColor" />,
  live: <path d="M4 6h16v12H4zM9 10l5 3-5 3v-6z" fill="currentColor" />,
  mission: <path d="M12 2l7 4v12l-7 4-7-4V6l7-4zm0 4l-3 2 3 2 3-2-3-2z" fill="currentColor" />,
  detections: <path d="M4 5h16v3H4zM4 10h16v3H4zM4 15h10v3H4z" fill="currentColor" />,
  system: (
    <path
      d="M12 8a4 4 0 100 8 4 4 0 000-8zm8 4l2-1-1-3-2 .5a7 7 0 00-1-1L18 5l-3-1-1 2a7 7 0 00-2 0L11 4 8 5l.5 2a7 7 0 00-1 1L5 7.5 4 10.5 6 12l-2 1.5L5 16.5l2-.5a7 7 0 001 1L7.5 19l3 1 1-2h1l1 2 3-1-.5-2a7 7 0 001-1l2 .5 1-3-2-1z"
      fill="currentColor"
    />
  ),
}

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'live', label: 'Live' },
  { id: 'mission', label: 'Mission' },
  { id: 'detections', label: 'Detections' },
  { id: 'system', label: 'System' },
]

export function Nav({ active, onChange }) {
  return (
    <nav
      className="glass fixed inset-x-2 bottom-2 z-30 flex justify-around p-1.5 shadow-elev sm:inset-x-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2 sm:gap-1"
      style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}
    >
      {TABS.map((t) => {
        const on = active === t.id
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="touch relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-3 py-1.5 sm:flex-initial sm:px-4"
            style={{ color: on ? '#03252C' : '#5B6B7C' }}
          >
            {on && (
              <motion.span
                layoutId="navpill"
                className="absolute inset-0 rounded-2xl"
                style={{ background: 'linear-gradient(180deg,#2DD4EE,#06B6D4)' }}
                transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              />
            )}
            <svg viewBox="0 0 24 24" width="21" height="21" className="relative z-10">
              {ICONS[t.id]}
            </svg>
            <span className="relative z-10 text-[10px] font-semibold sm:text-[11px]">{t.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
