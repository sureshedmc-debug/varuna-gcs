// The page opened from the Home launchpad. It comes forward while Home steps
// back behind it (MissionControlScreen scales/fades Home itself). Portalled to
// <body> because the tab container is transformed, which would otherwise pin a
// fixed layer to it instead of the window.
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import './launch.css'
import LoginPage from './LoginPage'
import DirectMissionPlanPage from './DirectMissionPlanPage'
import { ArrowLeft } from './icons'

const EASE = [0.16, 1, 0.3, 1]
const TITLES = { login: 'Login', register: 'Create an account', plan: 'Direct Mission Plan', 'plan-new': 'Direct Mission Plan' }

export default function LaunchPages({ page, onOpen, onClose, onNavigate }) {
  const pageRef = useRef(null)
  const returnFocus = useRef(null)
  // Keyboard users land in the page, and back on the Home button they used.
  useEffect(() => {
    if (!page) return
    if (!returnFocus.current) returnFocus.current = document.activeElement
    const t = setTimeout(() => pageRef.current?.focus({ preventScroll: true }), 50)
    return () => clearTimeout(t)
  }, [page])
  useEffect(() => {
    if (page || !returnFocus.current) return
    const el = returnFocus.current
    returnFocus.current = null
    setTimeout(() => el?.focus?.({ preventScroll: true }), 0)
  }, [page])

  useEffect(() => {
    if (!page) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, onClose])

  // Direct Mission Plan and Login take the whole screen.
  const full = ['plan', 'plan-new', 'login', 'register'].includes(page)

  return createPortal(
    <AnimatePresence>
      {page && !full && (
        <motion.div key="scrim" className="vl-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} />
      )}
      {page && (
        <motion.div
          key={page}
          className={`varuna-home vl-layer${full ? ' full' : ''}`}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          initial={full ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 24 }}
          animate={full ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={full ? { opacity: 0 } : { opacity: 0, scale: 1.04, y: -8 }}
          transition={{ type: 'tween', ease: EASE, duration: full ? 0.3 : 0.42 }}
        >
          <div ref={pageRef} tabIndex={-1} className={`vl-page${full ? ' full' : ''}`} role="dialog" aria-modal="true" aria-label={TITLES[page]} style={{ outline: 'none' }}>
            <button type="button" className="vl-back" onClick={onClose}><ArrowLeft /> Home</button>
            {page === 'login' && <LoginPage onOpen={onOpen} onClose={onClose} />}
            {page === 'register' && <LoginPage onOpen={onOpen} onClose={onClose} startRegister />}
            {page === 'plan' && <DirectMissionPlanPage onOpen={onOpen} onClose={onClose} onNavigate={onNavigate} />}
            {page === 'plan-new' && <DirectMissionPlanPage onOpen={onOpen} onClose={onClose} onNavigate={onNavigate} startWizard />}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
