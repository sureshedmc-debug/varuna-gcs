import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { StatusOrb } from '../components/ui'
import { playSciFiReveal } from '../lib/revealFx'

const TITLE = 'VARUNA'
const ease = [0.16, 1, 0.3, 1]

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// Pin the drone / boat call-outs to their 3D anchors every frame (no React re-render).
function placeTags(f, droneEl, boatEl, countEl) {
  const show = f.rushing ? 0 : f.ai
  if (droneEl) {
    droneEl.style.transform = `translate3d(${f.drone.x.toFixed(1)}px, ${f.drone.y.toFixed(1)}px, 0)`
    droneEl.style.opacity = String(show)
  }
  if (boatEl) {
    boatEl.style.transform = `translate3d(${f.boat.x.toFixed(1)}px, ${f.boat.y.toFixed(1)}px, 0)`
    boatEl.style.opacity = String(f.boat.visible ? show : 0)
  }
  if (countEl) {
    const n = String(f.boat.collected).padStart(2, '0')
    if (countEl.textContent !== n) countEl.textContent = n
  }
}

/** One leader-line call-out. `side` = which way the label extends from its anchor. */
function Tag({ tagRef, side, title, children }) {
  const left = side === 'left'
  return (
    <div ref={tagRef} className="absolute left-0 top-0 opacity-0 will-change-transform" style={{ transition: 'opacity 0.4s' }}>
      <span className="absolute -left-[3px] -top-[3px] h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(103,232,249,0.6)]" />
      <svg className={`absolute bottom-0 ${left ? 'right-0' : 'left-0'}`} width="46" height="34" style={{ overflow: 'visible' }}>
        <polyline
          points={left ? '46,34 22,10 0,10' : '0,34 24,10 46,10'}
          fill="none"
          stroke="rgba(165,243,252,0.55)"
          strokeWidth="1"
        />
      </svg>
      <div className={`absolute bottom-[26px] whitespace-nowrap ${left ? 'right-[52px] text-right' : 'left-[52px]'}`}>
        <div className="font-mono text-[10.5px] font-semibold tracking-[0.26em] text-white/85">{title}</div>
        <div className="mt-0.5 font-mono text-[9.5px] tracking-[0.2em] text-cyan-200/60">{children}</div>
      </div>
    </div>
  )
}

/**
 * Cinematic activation gate: a quadcopter powers on in the dark and hovers.
 * Click / Enter / Space → it rushes the camera, the headlights white out the
 * frame, and the app is revealed underneath.
 */
export default function IntroScreen({ onActivate }) {
  const mountRef = useRef(null)
  const droneTagRef = useRef(null)
  const boatTagRef = useRef(null)
  const countRef = useRef(null)
  const apiRef = useRef(null)
  const activateRef = useRef(onActivate)
  activateRef.current = onActivate
  const [reduce] = useState(prefersReducedMotion)
  const [phase, setPhase] = useState('idle') // idle | rush | leaving
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    let cancelled = false
    let api = null
    import('../lib/droneIntro')
      .then(({ createDroneIntro }) => {
        if (cancelled || !mountRef.current) return
        api = createDroneIntro(mountRef.current, {
          reducedMotion: reduce,
          onFrame: (f) => placeTags(f, droneTagRef.current, boatTagRef.current, countRef.current),
          onReveal: () => {
            if (cancelled) return
            if (reduce || !api?.supported) {
              setPhase('leaving')
              setTimeout(() => activateRef.current(), 380)
              return
            }
            playSciFiReveal()
            activateRef.current()
          },
        })
        apiRef.current = api
        if (import.meta.env.DEV) window.__varunaIntro = api // dev-only hook for stepping/capturing frames
        if (!api.supported) setFallback(true)
      })
      .catch(() => {
        if (!cancelled) setFallback(true)
      })
    return () => {
      cancelled = true
      api?.dispose()
      apiRef.current = null
    }
  }, [reduce])

  function launch() {
    if (phase !== 'idle') return
    setPhase('rush')
    if (apiRef.current) {
      apiRef.current.go()
    } else {
      setPhase('leaving')
      setTimeout(() => activateRef.current(), 380)
    }
  }

  const showUi = phase === 'idle'

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label="Launch VARUNA AI"
      onClick={launch}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          launch()
        }
      }}
      className="fixed inset-0 z-[100] cursor-pointer select-none overflow-hidden bg-black outline-none"
      animate={{ opacity: phase === 'leaving' ? 0 : 1 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      style={fallback ? { background: 'radial-gradient(120% 90% at 50% 0%, #0a1418 0%, #05080a 60%, #04070a 100%)' } : undefined}
    >
      <div ref={mountRef} className="absolute inset-0" />

      <AnimatePresence>
        {showUi && (
          <motion.div
            key="hud"
            className="pointer-events-none absolute inset-0"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.03, filter: 'blur(6px)', transition: { duration: 0.22, ease: 'easeIn' } }}
          >
            {/* legibility gradients */}
            <div className="absolute inset-x-0 bottom-0 h-[36%] bg-gradient-to-t from-black/85 via-black/40 to-transparent" />
            <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/60 to-transparent" />

            {/* the ecosystem, called out in the scene */}
            <div className="hidden md:block">
              <Tag tagRef={droneTagRef} side="left" title="VARUNA · AERIAL SCOUT">
                SCANNING · TAGGING PLASTIC
              </Tag>
              <Tag tagRef={boatTagRef} side="right" title="NIRMAL DHARA JALYAN · COLLECTOR">
                <span ref={countRef}>00</span> PIECES COLLECTED
              </Tag>
            </div>

            {/* HUD corner brackets */}
            {[
              'left-4 top-4 border-l border-t md:left-8 md:top-8',
              'right-4 top-4 border-r border-t md:right-8 md:top-8',
              'bottom-4 left-4 border-b border-l md:bottom-8 md:left-8',
              'bottom-4 right-4 border-b border-r md:bottom-8 md:right-8',
            ].map((c, i) => (
              <motion.span
                key={c}
                className={`absolute h-6 w-6 border-white/25 md:h-9 md:w-9 ${c}`}
                initial={{ opacity: 0, scale: 1.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 1.1 + i * 0.06, duration: 0.7, ease }}
              />
            ))}

            <motion.div
              className="absolute left-7 top-7 flex items-center gap-2 md:left-14 md:top-14"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1.25, duration: 0.6, ease }}
            >
              <StatusOrb level="ok" size={8} pulse />
              <span className="font-mono text-[10.5px] tracking-[0.28em] text-white/75">SYSTEMS ONLINE</span>
            </motion.div>
            <motion.div
              className="absolute right-7 top-7 hidden font-mono text-[10.5px] tracking-[0.24em] text-white/45 md:right-14 md:top-14 md:block"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1.35, duration: 0.6, ease }}
            >
              RIVER PATROL · ENV. MONITORING
            </motion.div>

            <div className="absolute inset-x-0 bottom-16 flex flex-col items-center px-6 text-center md:bottom-20">
              <motion.div
                className="mb-3 flex items-center gap-3 font-mono text-[10.5px] tracking-[0.42em] text-white/60"
                initial={{ opacity: 0, letterSpacing: '0.7em' }}
                animate={{ opacity: 1, letterSpacing: '0.42em' }}
                transition={{ delay: 1.7, duration: 1.1, ease }}
              >
                <span className="h-px w-8 bg-white/30" />
                AUTONOMOUS AERIAL INTELLIGENCE
                <span className="h-px w-8 bg-white/30" />
              </motion.div>

              <h1 className="flex items-baseline gap-[0.18em] text-5xl font-black tracking-tight text-white sm:text-6xl md:text-7xl" aria-label="VARUNA AI">
                <span className="flex">
                  {TITLE.split('').map((ch, i) => (
                    <motion.span
                      key={i}
                      aria-hidden
                      initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      transition={{ delay: 1.85 + i * 0.055, duration: 0.8, ease }}
                    >
                      {ch}
                    </motion.span>
                  ))}
                </span>
                <motion.span
                  aria-hidden
                  className="bg-gradient-to-r from-cyan-300 to-violet-400 bg-clip-text text-transparent"
                  initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ delay: 2.25, duration: 0.8, ease }}
                >
                  AI
                </motion.span>
              </h1>

              {/* The collection boat that works with the drone. */}
              <motion.div
                className="mt-3 flex items-baseline gap-3"
                initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ delay: 2.4, duration: 0.8, ease }}
              >
                <span className="font-mono text-[10.5px] tracking-[0.42em] text-white/50">BOAT</span>
                <span className="text-xl font-bold tracking-[0.3em] text-white/90 sm:text-2xl">NIRMAL DHARA JALYAN</span>
              </motion.div>

              <motion.button
                type="button"
                tabIndex={-1}
                className="pointer-events-auto relative mt-7 flex items-center gap-2.5 rounded-full border border-white/15 bg-white/[0.06] px-5 py-2.5 backdrop-blur-md"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 2.6, duration: 0.7, ease }}
                onClick={(e) => {
                  e.stopPropagation()
                  launch()
                }}
              >
                <motion.span
                  className="absolute inset-0 rounded-full border border-cyan-300/40"
                  animate={{ scale: [1, 1.18], opacity: [0.6, 0] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut', delay: 3.2 }}
                />
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_2px_rgba(103,232,249,0.7)]" />
                <span className="font-mono text-[11px] font-semibold tracking-[0.24em] text-white/85">CLICK ANYWHERE TO LAUNCH</span>
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
