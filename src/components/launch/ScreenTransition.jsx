// Full-screen title transition played when Home opens Login or Direct Mission
// Plan: three colour panels sweep up, the page name fills the whole screen
// letter by letter, the page is swapped in underneath while it is covered,
// then everything lifts away to reveal it. About 1.9 s end to end.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'

const WORDS = {
  login: ['LOGIN'],
  register: ['CREATE', 'ACCOUNT'],
  plan: ['DIRECT', 'MISSION', 'PLAN'],
  'plan-new': ['DIRECT', 'MISSION', 'PLAN'],
}
const LABELS = { login: 'Login', register: 'Create account', plan: 'Direct Mission Plan', 'plan-new': 'Direct Mission Plan' }

const SWEEP = [0.76, 0, 0.24, 1]
const RISE = [0.16, 1, 0.3, 1]
const PANELS = ['#14b8a6', '#6d28d9', '#070b18']

// timings (seconds)
const T_TEXT = 0.42 // letters start rising
const T_COVER = 1.15 // page swapped in underneath
const T_OUT = 1.25 // everything lifts away
const T_DONE = 2.0

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Biggest type that still fits: measured at the current size, then scaled so the longest
// line spans most of the width or the block fills most of the height.
function useFitSize(ref, key) {
  const [size, setSize] = useState(100)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const cur = parseFloat(getComputedStyle(el).fontSize) || 100
      const lines = [...el.children]
      const w = Math.max(...lines.map((l) => l.scrollWidth))
      const h = el.scrollHeight
      const W = window.innerWidth, H = window.innerHeight
      setSize(Math.floor(cur * Math.min((W * 0.86) / w, (H * 0.7) / h)))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return size
}

export default function ScreenTransition({ page, onCover, onDone }) {
  const lines = WORDS[page] || [String(page).toUpperCase()]
  const [phase, setPhase] = useState('in')
  const [count, setCount] = useState(0)
  const wordsRef = useRef(null)
  const size = useFitSize(wordsRef, page)
  const cbs = useRef({ onCover, onDone })
  cbs.current = { onCover, onDone }

  useEffect(() => {
    const t1 = setTimeout(() => cbs.current.onCover?.(), T_COVER * 1000)
    const t2 = setTimeout(() => setPhase('out'), T_OUT * 1000)
    const t3 = setTimeout(() => cbs.current.onDone?.(), T_DONE * 1000)
    // the little loading counter, 000 → 100 while the screen is covered
    let raf, t0
    const tick = (t) => {
      t0 ??= t
      const k = Math.min(1, (t - t0) / (T_OUT * 1000))
      setCount(Math.round(100 * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); cancelAnimationFrame(raf) }
  }, [])

  const out = phase === 'out'
  let letterIndex = 0

  return createPortal(
    <div className="vl-xfade" aria-hidden="true">
      {PANELS.map((c, i) => (
        <motion.div
          key={c}
          className="vl-xfade-panel"
          style={{ background: c }}
          initial={{ clipPath: 'inset(100% 0% 0% 0%)' }}
          animate={{ clipPath: out ? 'inset(0% 0% 100% 0%)' : 'inset(0% 0% 0% 0%)' }}
          transition={{ duration: out ? 0.62 : 0.7, ease: SWEEP, delay: out ? (PANELS.length - 1 - i) * 0.07 : i * 0.09 }}
        />
      ))}

      <motion.div
        className="vl-xfade-stage"
        animate={{ y: out ? '-6vh' : '0vh', opacity: out ? 0 : 1 }}
        transition={{ duration: 0.5, ease: SWEEP }}
      >
        <div className="vl-xfade-top">
          <span>VARUNA AI</span>
          <motion.span
            className="vl-xfade-rule"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: T_COVER, ease: RISE, delay: 0.3 }}
          />
          <span>{LABELS[page] || page}</span>
        </div>

        <h2 ref={wordsRef} className="vl-xfade-words" style={{ fontSize: size }}>
          {lines.map((line, li) => (
            <span key={line + li} className={`vl-xfade-line l${li % 3}`} style={{ alignSelf: lines.length === 1 ? 'center' : li === 0 ? 'flex-start' : li === lines.length - 1 ? 'flex-end' : 'center' }}>
              {[...line].map((ch, ci) => {
                const n = letterIndex++
                return (
                  <span key={n} className="vl-xfade-mask">
                    <motion.span
                      className="vl-xfade-ch"
                      // one gradient across the word, not one per letter
                      style={{ '--n': line.length, '--i': ci }}
                      initial={{ y: '110%', rotate: 8 }}
                      animate={{ y: out ? '-110%' : '0%', rotate: out ? -4 : 0 }}
                      transition={out
                        ? { duration: 0.5, ease: SWEEP, delay: n * 0.012 }
                        : { duration: 0.8, ease: RISE, delay: T_TEXT + n * 0.03 }}
                    >
                      {ch}
                    </motion.span>
                  </span>
                )
              })}
            </span>
          ))}
        </h2>

        <div className="vl-xfade-bottom">
          <span>Autonomous river cleanup</span>
          <span className="vl-xfade-count">{String(count).padStart(3, '0')}</span>
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}
