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
import BasicDataPage from './BasicDataPage'
import { ArrowLeft } from './icons'

const EASE = [0.16, 1, 0.3, 1]
const TITLES = { login: 'Login', plan: 'Direct Mission Plan', 'plan-new': 'Direct Mission Plan', data: 'Basic data' }

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

  return createPortal(
    <AnimatePresence>
      {page && (
        <motion.div key="scrim" className="vl-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} />
      )}
      {page && (
        <motion.div
          key={page}
          className="varuna-home vl-layer"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          initial={{ opacity: 0, scale: 0.9, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 1.04, y: -8 }}
          transition={{ type: 'tween', ease: EASE, duration: 0.42 }}
        >
          <div ref={pageRef} tabIndex={-1} className={`vl-page ${page === 'data' ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={TITLES[page]} style={{ outline: 'none' }}>
            <button type="button" className="vl-back" onClick={onClose}><ArrowLeft /> Home</button>
            {page === 'login' && <LoginPage onOpen={onOpen} onClose={onClose} />}
            {page === 'plan' && <DirectMissionPlanPage onOpen={onOpen} onClose={onClose} onNavigate={onNavigate} />}
            {page === 'plan-new' && <DirectMissionPlanPage onOpen={onOpen} onClose={onClose} onNavigate={onNavigate} startWizard />}
            {page === 'data' && <BasicDataPage />}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
