import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

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

const PANEL_W = 224
const OPEN_DELAY = 70 // ms of edge hover before it slides out (ignores fly-by cursors)
const CLOSE_DELAY = 320 // ms grace after the cursor leaves

const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }

const panelVariants = {
  hidden: { x: -PANEL_W - 24, opacity: 0, scale: 0.96, filter: 'blur(10px)' },
  shown: {
    x: 0,
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: { ...spring, staggerChildren: 0.035, delayChildren: 0.06 },
  },
  exit: {
    x: -PANEL_W - 24,
    opacity: 0,
    scale: 0.97,
    filter: 'blur(8px)',
    transition: { duration: 0.22, ease: [0.4, 0, 1, 1], staggerChildren: 0.015, staggerDirection: -1 },
  },
}
const itemVariants = {
  hidden: { opacity: 0, x: -18, filter: 'blur(4px)' },
  shown: { opacity: 1, x: 0, filter: 'blur(0px)', transition: { type: 'spring', stiffness: 520, damping: 32 } },
  exit: { opacity: 0, x: -10, transition: { duration: 0.12 } },
}
const reducedVariants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
}

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg width="34" height="34" viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="9" fill="#f3f0ff" />
        <path d="M7 20c2.5-3.5 5-5.5 7-5.5s4.5 4.5 7 4.5 4.5-4.5 7-4.5" stroke="#7c3aed" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M7 24c2.5-3.5 5-5.5 7-5.5s4.5 4.5 7 4.5 4.5-4.5 7-4.5" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.6" />
      </svg>
      <div>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#1e1b4b', letterSpacing: '-0.01em', lineHeight: 1.2 }}>VARUNA AI</div>
        <div style={{ fontSize: 9.5, color: '#8b5cf6', lineHeight: 1.3, marginTop: 1, fontWeight: 500 }}>AI for Cleaner Water</div>
      </div>
    </div>
  )
}

function PinIcon({ on }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6z" />
      <line x1="12" y1="15" x2="12" y2="21" />
    </svg>
  )
}

/** The floating navigation panel itself (desktop hover-out + mobile drawer share it). */
function Panel({ active, onPick, pinned, onPin, reduce, mobile, onClose }) {
  const [hover, setHover] = useState(null)
  const v = reduce ? reducedVariants : panelVariants
  const iv = reduce ? reducedVariants : itemVariants
  return (
    <motion.nav
      aria-label="Main navigation"
      variants={v}
      initial="hidden"
      animate="shown"
      exit="exit"
      style={{
        position: 'fixed',
        zIndex: 60,
        left: mobile ? 0 : 10,
        top: mobile ? 0 : 10,
        bottom: mobile ? 0 : 10,
        width: mobile ? 'min(82vw, 280px)' : PANEL_W,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: mobile ? '0 22px 22px 0' : 20,
        background: 'rgba(255,255,255,0.86)',
        backdropFilter: 'blur(18px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
        border: '1px solid rgba(167,139,250,0.28)',
        boxShadow: '0 24px 60px -12px rgba(76,29,149,0.28), 0 8px 20px rgba(109,40,217,0.10), inset 0 1px 0 rgba(255,255,255,0.9)',
        overflow: 'hidden',
        transformOrigin: 'left center',
      }}
    >
      {/* light streak that runs down the edge as the panel lands */}
      {!reduce && (
        <motion.span
          aria-hidden
          initial={{ top: '-30%', opacity: 0 }}
          animate={{ top: '110%', opacity: [0, 1, 1, 0] }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
          style={{
            position: 'absolute', right: 0, width: 2, height: '28%', pointerEvents: 'none',
            background: 'linear-gradient(to bottom, transparent, #a78bfa, #22d3ee, transparent)',
            boxShadow: '0 0 12px 2px rgba(139,92,246,0.55)',
          }}
        />
      )}

      <motion.div variants={iv} style={{ padding: '18px 16px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(167,139,250,0.18)' }}>
        <Logo />
        {mobile ? (
          <button onClick={onClose} aria-label="Close navigation" className="rail-iconbtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        ) : (
          <button
            onClick={onPin}
            aria-pressed={pinned}
            title={pinned ? 'Unpin sidebar (auto-hide)' : 'Pin sidebar open'}
            className="rail-iconbtn"
            style={{ color: pinned ? '#7c3aed' : undefined, transform: pinned ? 'rotate(0deg)' : 'rotate(35deg)' }}
          >
            <PinIcon on={pinned} />
          </button>
        )}
      </motion.div>

      <div style={{ flex: 1, padding: '12px 10px', overflowY: 'auto', position: 'relative' }} onMouseLeave={() => setHover(null)}>
        {NAV_ITEMS.map((item, i) => {
          const on = active === item.tabId
          return (
            <motion.button
              key={item.id}
              variants={iv}
              onClick={() => onPick(item.tabId)}
              onMouseEnter={() => setHover(item.id)}
              onFocus={() => setHover(item.id)}
              whileTap={reduce ? undefined : { scale: 0.97 }}
              aria-current={on ? 'page' : undefined}
              style={{
                position: 'relative',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '10px 14px',
                borderRadius: 12,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: on ? '#ffffff' : hover === item.id ? '#6d28d9' : '#64748b',
                fontSize: 13,
                fontWeight: on ? 700 : 550,
                textAlign: 'left',
                fontFamily: 'Inter, system-ui, sans-serif',
                marginBottom: 3,
                transition: 'color 0.18s ease',
              }}
            >
              {on && (
                <motion.span
                  layoutId="rail-active"
                  transition={spring}
                  style={{
                    position: 'absolute', inset: 0, borderRadius: 12,
                    background: 'linear-gradient(135deg, #7c3aed, #8b5cf6 55%, #a78bfa)',
                    boxShadow: '0 6px 18px -4px rgba(124,58,237,0.55), inset 0 1px 0 rgba(255,255,255,0.25)',
                  }}
                />
              )}
              {hover === item.id && !on && (
                <motion.span
                  layoutId="rail-hover"
                  transition={{ type: 'spring', stiffness: 600, damping: 40 }}
                  style={{ position: 'absolute', inset: 0, borderRadius: 12, background: 'rgba(139,92,246,0.09)', border: '1px solid rgba(139,92,246,0.14)' }}
                />
              )}
              <motion.span
                style={{ position: 'relative', display: 'flex', flexShrink: 0 }}
                animate={reduce ? undefined : hover === item.id ? { scale: 1.15, rotate: i % 2 ? 6 : -6 } : { scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              >
                {item.icon}
              </motion.span>
              <span style={{ position: 'relative' }}>{item.label}</span>
              {on && (
                <motion.span
                  layoutId="rail-dot"
                  transition={spring}
                  style={{ position: 'relative', marginLeft: 'auto', width: 6, height: 6, borderRadius: 3, background: '#fff', boxShadow: '0 0 8px 2px rgba(255,255,255,0.7)' }}
                />
              )}
            </motion.button>
          )
        })}
      </div>

      <motion.div variants={iv} style={{ padding: '10px 16px 14px', borderTop: '1px solid rgba(167,139,250,0.18)', fontSize: 9, color: '#a78bfa', display: 'flex', justifyContent: 'space-between' }}>
        <span>v1.0.0</span>
        <span>{mobile ? 'Tap outside to close' : pinned ? 'Pinned' : 'Auto-hide'}</span>
      </motion.div>
    </motion.nav>
  )
}

/** Desktop: hidden until the cursor reaches the left edge, then it springs out.
 *  Mobile: a drawer opened from the hamburger in the top bar. */
export function Rail({ active, onChange, pinned, onPinnedChange, mobileOpen, onMobileOpenChange }) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const openT = useRef(0)
  const closeT = useRef(0)
  const desktopShown = pinned || open

  const requestOpen = (delay = OPEN_DELAY) => {
    clearTimeout(closeT.current)
    closeT.current = 0
    clearTimeout(openT.current)
    openT.current = setTimeout(() => setOpen(true), delay)
  }
  const requestClose = () => {
    clearTimeout(openT.current)
    clearTimeout(closeT.current)
    closeT.current = setTimeout(() => { closeT.current = 0; setOpen(false) }, CLOSE_DELAY)
  }
  useEffect(() => () => {
    clearTimeout(openT.current)
    clearTimeout(closeT.current)
  }, [])

  // While it's out (and not pinned), keep it open as long as the cursor stays near the
  // left edge; once it moves clearly past the panel, slide it away.
  useEffect(() => {
    if (!open || pinned) return
    const onMove = (e) => {
      if (e.clientX > PANEL_W + 36) {
        if (!closeT.current) closeT.current = setTimeout(() => { closeT.current = 0; setOpen(false) }, CLOSE_DELAY)
      } else if (closeT.current) {
        clearTimeout(closeT.current)
        closeT.current = 0
      }
    }
    const onOut = (e) => { if (!e.relatedTarget) requestClose() } // cursor left the window
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseout', onOut)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseout', onOut)
    }
  }, [open, pinned])

  // Esc closes whichever is open
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      onMobileOpenChange?.(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onMobileOpenChange])

  const activeIdx = Math.max(0, NAV_ITEMS.findIndex((n) => n.tabId === active))

  return (
    <>
      {/* ── Desktop ── */}
      <div className="hidden md:block">
        {/* Edge hint: a slim glowing spine with one dot per tab; the hot zone is wider than it looks */}
        <AnimatePresence>
          {!desktopShown && (
            <motion.button
              key="hint"
              aria-label="Open navigation"
              onMouseEnter={() => requestOpen()}
              onMouseLeave={() => clearTimeout(openT.current)}
              onFocus={() => requestOpen(0)}
              onClick={() => requestOpen(0)}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
              className="rail-edge"
            >
              <span className="rail-spine">
                {NAV_ITEMS.map((n, i) => (
                  <span key={n.id} className={`rail-spine-dot${i === activeIdx ? ' on' : ''}`} />
                ))}
              </span>
            </motion.button>
          )}
        </AnimatePresence>

        <div onFocus={() => !pinned && requestOpen(0)}>
          <AnimatePresence>
            {desktopShown && (
              <Panel
                key="panel"
                active={active}
                onPick={onChange}
                pinned={pinned}
                onPin={() => onPinnedChange(!pinned)}
                reduce={reduce}
              />
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Mobile drawer ── */}
      <div className="md:hidden">
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              key="scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => onMobileOpenChange(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(30,27,75,0.28)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}
            />
          )}
          {mobileOpen && (
            <Panel
              key="drawer"
              mobile
              active={active}
              reduce={reduce}
              onClose={() => onMobileOpenChange(false)}
              onPick={(id) => {
                onChange(id)
                onMobileOpenChange(false)
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
