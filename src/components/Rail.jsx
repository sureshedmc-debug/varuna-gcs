import { motion } from 'framer-motion'
import { getTheme } from '../lib/theme'

const NAV_ITEMS = [
  {
    id: 'home', label: 'Home', tabId: 'home',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    ),
  },
  {
    id: 'live', label: 'Live', tabId: 'live',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="6" height="6" rx="1"/><line x1="12" y1="9" x2="8.5" y2="5.5"/><line x1="12" y1="9" x2="15.5" y2="5.5"/><line x1="12" y1="15" x2="8.5" y2="18.5"/><line x1="12" y1="15" x2="15.5" y2="18.5"/><circle cx="7.5" cy="4.5" r="1.8"/><circle cx="16.5" cy="4.5" r="1.8"/><circle cx="7.5" cy="19.5" r="1.8"/><circle cx="16.5" cy="19.5" r="1.8"/>
      </svg>
    ),
  },
  {
    id: 'mission', label: 'Missions', tabId: 'mission',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
      </svg>
    ),
  },
  {
    id: 'detections', label: 'Detections', tabId: 'detections',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
      </svg>
    ),
  },
  {
    id: 'replay', label: 'Replay', tabId: 'replay',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12a8 8 0 108-8 8 8 0 00-5.66 2.34"/><path d="M4 4v4.5H8.5"/><polygon points="10 9 16 12 10 15 10 9" fill="currentColor" stroke="none"/>
      </svg>
    ),
  },
  {
    id: 'system', label: 'System', tabId: 'system',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    ),
  },
]

const MOBILE_TABS = [
  { id: 'home',       label: 'Home',       icon: <path d="M4 10l8-6 8 6v9a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1v-9z" fill="currentColor" /> },
  { id: 'live',       label: 'Live',       icon: <path d="M4 6h16v12H4zM9.5 9.5l5 2.5-5 2.5v-5z" fill="currentColor" /> },
  { id: 'mission',    label: 'Missions',   icon: <path d="M12 2l7 4v12l-7 4-7-4V6l7-4zm0 4l-3 2 3 2 3-2-3-2z" fill="currentColor" /> },
  { id: 'detections', label: 'Detections', icon: <path d="M4 5h16v3H4zM4 10h16v3H4zM4 15h10v3H4z" fill="currentColor" /> },
  { id: 'replay',     label: 'Replay',     icon: <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12a8 8 0 108-8 8 8 0 00-5.66 2.34"/><path d="M4 4v4.5H8.5"/><path d="M10 9l6 3-6 3V9z" fill="currentColor" stroke="none"/></g> },
  { id: 'system',     label: 'System',     icon: <path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l1.6-1.2-1-2.4-1.9.5a7 7 0 00-1.1-1.1l.5-1.9-2.4-1-1.2 1.6a7 7 0 00-1.5 0L12 3l-2.4 1 .5 1.9a7 7 0 00-1.1 1.1L7 6.4l-2.4 1L5 9.8a7 7 0 000 1.5L3.4 12.5l1 2.4 1.9-.5a7 7 0 001.1 1.1L7 17.6l2.4 1 1.2-1.6a7 7 0 001.5 0l1.2 1.6 2.4-1-.5-1.9a7 7 0 001.1-1.1l1.9.5 1-2.4L21 12z" fill="currentColor" /> },
]

export function Rail({ active, onChange, onLock }) {
  return (
    <>
      {/* ── Desktop sidebar ── */}
      <nav
        className="hidden md:flex"
        style={{
          position: 'fixed', left: 0, top: 0, zIndex: 40,
          height: '100%', width: 200,
          background: '#ffffff',
          borderRight: '1px solid #f0ecff',
          display: 'flex', flexDirection: 'column',
          boxShadow: '4px 0 20px rgba(109,40,217,0.06)',
        }}
        aria-label="Main navigation"
      >
        {/* Logo */}
        <div style={{ padding: '22px 20px 20px', borderBottom: '1px solid #f0ecff', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect width="36" height="36" rx="9" fill="#f3f0ff"/>
              <path d="M7 20c2.5-3.5 5-5.5 7-5.5s4.5 4.5 7 4.5 4.5-4.5 7-4.5" stroke="#7c3aed" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <path d="M7 24c2.5-3.5 5-5.5 7-5.5s4.5 4.5 7 4.5 4.5-4.5 7-4.5" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.6"/>
            </svg>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#1e1b4b', letterSpacing: '-0.01em', lineHeight: 1.2 }}>VARUNA AI</div>
              <div style={{ fontSize: 9.5, color: '#8b5cf6', lineHeight: 1.3, marginTop: 1, fontWeight: 500 }}>AI for Cleaner Water</div>
            </div>
          </div>
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, padding: '10px 12px', overflowY: 'auto' }}>
          {NAV_ITEMS.map(item => {
            const isActive = active === item.tabId && item.id === active || (item.id === 'home' && active === 'home')
            const highlighted = item.id === 'home' ? active === 'home' : (item.tabId === active && item.id !== 'dashboard' && item.id !== 'map')
            const showActive = item.id === 'home' ? active === 'home'
              : item.id === 'live' ? active === 'live'
              : item.id === 'mission' ? active === 'mission' && item.id === 'mission'
              : item.id === 'map' ? active === 'mission' && item.id === 'map'
              : item.id === 'detections' ? active === 'detections'
              : item.id === 'replay' ? active === 'replay'
              : item.id === 'system' ? active === 'system'
              : false

            return (
              <button
                key={item.id}
                onClick={() => onChange(item.tabId)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 14px',
                  borderRadius: 10,
                  background: showActive ? 'linear-gradient(135deg, #7c3aed, #8b5cf6)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: showActive ? '#ffffff' : '#64748b',
                  fontSize: 13,
                  fontWeight: showActive ? 700 : 500,
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  marginBottom: 2,
                  boxShadow: showActive ? '0 4px 12px rgba(124,58,237,0.3)' : 'none',
                }}
                onMouseEnter={e => {
                  if (!showActive) {
                    e.currentTarget.style.background = '#f5f3ff'
                    e.currentTarget.style.color = '#7c3aed'
                  }
                }}
                onMouseLeave={e => {
                  if (!showActive) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = '#64748b'
                  }
                }}
              >
                <span style={{ flexShrink: 0, display: 'flex', opacity: showActive ? 1 : 0.8 }}>{item.icon}</span>
                {item.label}
              </button>
            )
          })}
        </div>

        {/* Bottom decoration + version */}
        <div style={{ padding: '0 0 0', flexShrink: 0 }}>
          {/* Purple wave decoration */}
          <div style={{ position: 'relative', height: 80, overflow: 'hidden' }}>
            <svg viewBox="0 0 200 80" width="200" height="80" style={{ position: 'absolute', bottom: 0 }}>
              <path d="M0 60 C30 40, 60 70, 100 55 C140 40, 170 65, 200 50 L200 80 L0 80 Z"
                fill="rgba(124,58,237,0.07)"/>
              <path d="M0 70 C40 55, 80 75, 120 65 C160 55, 180 70, 200 60 L200 80 L0 80 Z"
                fill="rgba(124,58,237,0.1)"/>
            </svg>
            <div style={{
              position: 'absolute', bottom: 14, left: 16,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M12 22s-8-4-8-10A8 8 0 0112 4a8 8 0 018 8c0 6-8 10-8 10z" fill="#a78bfa" opacity="0.4"/>
                <path d="M12 18s-5-2.5-5-6.5A5 5 0 0112 6a5 5 0 015 5.5C17 15.5 12 18 12 18z" fill="#7c3aed" opacity="0.6"/>
              </svg>
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#7c3aed', letterSpacing: '0.05em', lineHeight: 1.3 }}>CLEANER WATER</div>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#7c3aed', letterSpacing: '0.05em', lineHeight: 1.3 }}>GREENER</div>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#7c3aed', letterSpacing: '0.05em', lineHeight: 1.3 }}>TOMORROW</div>
              </div>
            </div>
          </div>
          <div style={{ padding: '0 16px 14px', borderTop: '1px solid #f0ecff' }}>
            <div style={{ fontSize: 9, color: '#c4b5fd', marginTop: 8 }}>v1.0.0</div>
            <div style={{ fontSize: 9, color: '#c4b5fd' }}>© 2026 VARUNA AI</div>
          </div>
        </div>
      </nav>

      {/* ── Mobile bottom bar ── */}
      <nav
        className="glass fixed inset-x-2 bottom-2 z-40 flex justify-around p-1.5 shadow-elev md:hidden"
        style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}
      >
        {MOBILE_TABS.map((t) => {
          const on = active === t.id
          return (
            <button key={t.id} onClick={() => onChange(t.id)}
              className="touch relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1.5"
              style={{ color: on ? '#fff' : 'var(--muted)' }}>
              {on && (
                <motion.span layoutId="rail-ind-m" className="absolute inset-0 rounded-xl"
                  style={{ background: 'linear-gradient(135deg, #7c3aed, #a78bfa)' }}
                  transition={{ type: 'spring', stiffness: 420, damping: 30 }} />
              )}
              <svg viewBox="0 0 24 24" width="20" height="20" className="relative z-10">{t.icon}</svg>
              <span className="relative z-10 text-[9px] font-semibold">{t.label}</span>
            </button>
          )
        })}
      </nav>
    </>
  )
}