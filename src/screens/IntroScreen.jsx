import { Suspense, lazy, useState } from 'react'
import { motion } from 'framer-motion'
import { StatusOrb } from '../components/ui'

const IntroScene = lazy(() => import('../components/IntroScene'))

/**
 * Full-screen cinematic intro / activation gate.
 *
 * Plays a REAL video background from /intro-bg.mp4 (drop your own drone-over-
 * river cleanup clip into public/intro-bg.mp4 — no code change needed). If that
 * file is missing/unplayable, it falls back to an original 3D scene so it's
 * never blank.
 * Click anywhere to activate → the app home page.
 */
export default function IntroScreen({ onActivate }) {
  const [leaving, setLeaving] = useState(false)
  const [videoOk, setVideoOk] = useState(true)

  function enter() {
    if (leaving) return
    setLeaving(true)
    setTimeout(onActivate, 650)
  }

  return (
    <motion.div
      onClick={enter}
      className="fixed inset-0 z-[100] cursor-pointer select-none overflow-hidden"
      animate={leaving ? { opacity: 0, scale: 1.08, filter: 'blur(6px)' } : { opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: 'easeInOut' }}
      style={{ background: 'radial-gradient(120% 90% at 50% 0%, #0a1418 0%, #05080a 60%, #04070a 100%)' }}
    >
      {/* Real video background (preferred) */}
      {videoOk ? (
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src="/intro-bg.mp4"
          autoPlay
          muted
          loop
          playsInline
          onError={() => setVideoOk(false)}
        />
      ) : (
        // Fallback: original 3D drone-over-water scene (only if no video file).
        <Suspense fallback={null}>
          <IntroScene />
        </Suspense>
      )}

      {/* cinematic gradients for text legibility over any footage */}
      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="absolute inset-0 bg-black/30" />
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/85 to-transparent" />
      </div>

      {/* HUD frame */}
      <div className="pointer-events-none absolute inset-4 z-20 rounded-2xl border border-white/10 md:inset-8" />

      <div className="absolute left-6 top-6 z-30 flex items-center gap-2 md:left-12 md:top-12">
        <StatusOrb level="ok" size={9} pulse />
        <span className="font-mono text-[11px] tracking-[0.25em] text-mint">SYSTEM ONLINE</span>
      </div>
      <div className="absolute right-6 top-6 z-30 hidden font-mono text-[11px] tracking-[0.2em] text-white/60 md:block md:right-12 md:top-12">
        RIVER PATROL · ENV. MONITORING
      </div>

      <div className="absolute inset-0 z-30 flex flex-col items-center justify-center px-6 text-center">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.9, ease: 'easeOut' }}>
          <div className="mb-3 flex items-center justify-center gap-2 font-mono text-[11px] tracking-[0.4em] text-accent">
            <span className="h-px w-8 bg-accent/60" />
            AUTONOMOUS AERIAL INTELLIGENCE
            <span className="h-px w-8 bg-accent/60" />
          </div>
          <h1 className="text-6xl font-black tracking-tight text-white sm:text-7xl md:text-8xl" style={{ textShadow: '0 0 40px rgba(59,158,255,0.45)' }}>
            VARUNA <span className="text-accent">AI</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm text-white/80 sm:text-base">
            Autonomous drone system for river debris cleanup & environmental monitoring — scanning waterways, detecting waste, acting in real time.
          </p>
        </motion.div>
      </div>

      <div className="absolute inset-x-0 bottom-24 z-30 flex justify-center">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }} className="flex items-center gap-2 rounded-full border border-mint/30 bg-black/50 px-4 py-1.5 backdrop-blur">
          <motion.span className="h-2 w-2 rounded-full bg-mint" animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1.4, repeat: Infinity }} />
          <span className="font-mono text-[11px] tracking-wider text-mint">SCANNING RIVER SURFACE · DEBRIS DETECTION ACTIVE</span>
        </motion.div>
      </div>

      <motion.div className="absolute inset-x-0 bottom-10 z-30 flex flex-col items-center gap-2" animate={{ opacity: [0.55, 1, 0.55] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}>
        <span className="rounded-full bg-white/12 px-5 py-2 text-sm font-semibold tracking-wide text-white backdrop-blur">
          Click anywhere to activate
        </span>
      </motion.div>
    </motion.div>
  )
}
