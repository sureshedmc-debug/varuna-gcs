import { motion } from 'framer-motion'

const ICONS = {
  home: <path d="M4 10l8-6 8 6v9a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1v-9z" fill="currentColor" />,
  live: <path d="M4 6h16v12H4zM9.5 9.5l5 2.5-5 2.5v-5z" fill="currentColor" />,
  mission: <path d="M12 2l7 4v12l-7 4-7-4V6l7-4zm0 4l-3 2 3 2 3-2-3-2z" fill="currentColor" />,
  detections: <path d="M4 5h16v3H4zM4 10h16v3H4zM4 15h10v3H4z" fill="currentColor" />,
  system: <path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l1.6-1.2-1-2.4-1.9.5a7 7 0 00-1.1-1.1l.5-1.9-2.4-1-1.2 1.6a7 7 0 00-1.5 0L12 3l-2.4 1 .5 1.9a7 7 0 00-1.1 1.1L7 6.4l-2.4 1L5 9.8a7 7 0 000 1.5L3.4 12.5l1 2.4 1.9-.5a7 7 0 001.1 1.1L7 17.6l2.4 1 1.2-1.6a7 7 0 001.5 0l1.2 1.6 2.4-1-.5-1.9a7 7 0 001.1-1.1l1.9.5 1-2.4L21 12z" fill="currentColor" />,
}

const TABS = [
  { id: 'home', label: 'Map' },
  { id: 'live', label: 'Live' },
  { id: 'mission', label: 'Missions' },
  { id: 'detections', label: 'Detections' },
  { id: 'system', label: 'System' },
]

const LOCK = <path d="M6 10V8a6 6 0 1112 0v2h1a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1h1zm2 0h8V8a4 4 0 10-8 0v2zm4 4a1.5 1.5 0 00-1 2.6V19h2v-2.4A1.5 1.5 0 0012 14z" fill="currentColor" />

export function Rail({ active, onChange, onLock }) {
  return (
    <>
      {/* Desktop / tablet: vertical icon rail */}
      <nav className="fixed left-0 top-0 z-40 hidden h-full w-[76px] flex-col items-center gap-1 border-r border-line bg-[#0B0E12]/80 py-3 backdrop-blur-xl md:flex">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M12 2l3 6 6 .8-4.5 4.2L18 20l-6-3.4L6 20l1.5-7L3 8.8 9 8l3-6z" fill="currentColor" />
          </svg>
        </div>
        {TABS.map((t) => {
          const on = active === t.id
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              className="relative flex w-full flex-col items-center gap-1 py-2.5"
              style={{ color: on ? 'var(--accent-hex)' : 'var(--muted)' }}
            >
              {on && (
                <motion.span layoutId="rail-ind" className="absolute left-0 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-r bg-accent" transition={{ type: 'spring', stiffness: 400, damping: 30 }} />
              )}
              <svg viewBox="0 0 24 24" width="22" height="22">{ICONS[t.id]}</svg>
              <span className="text-[9px] font-semibold tracking-wide">{t.label}</span>
            </button>
          )
        })}
        <button
          onClick={onLock}
          title="Lock app"
          className="mt-auto flex w-full flex-col items-center gap-1 py-2.5 text-muted transition-colors hover:text-bad"
        >
          <svg viewBox="0 0 24 24" width="22" height="22">{LOCK}</svg>
          <span className="text-[9px] font-semibold tracking-wide">Lock</span>
        </button>
      </nav>

      {/* Mobile: bottom bar */}
      <nav
        className="glass fixed inset-x-2 bottom-2 z-40 flex justify-around p-1.5 shadow-elev md:hidden"
        style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}
      >
        {TABS.map((t) => {
          const on = active === t.id
          return (
            <button key={t.id} onClick={() => onChange(t.id)} className="touch relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1.5" style={{ color: on ? '#fff' : 'var(--muted)' }}>
              {on && <motion.span layoutId="rail-ind-m" className="absolute inset-0 rounded-xl" style={{ background: 'linear-gradient(180deg, var(--accent2), var(--accent-hex))' }} transition={{ type: 'spring', stiffness: 420, damping: 30 }} />}
              <svg viewBox="0 0 24 24" width="20" height="20" className="relative z-10">{ICONS[t.id]}</svg>
              <span className="relative z-10 text-[9px] font-semibold">{t.label}</span>
            </button>
          )
        })}
      </nav>
    </>
  )
}
