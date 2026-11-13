import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTrashLog } from '../lib/trashLog'

// Live tab, over the video: the newest waste the AI found and WHERE it is, in
// big type so it reads at a glance on a phone. Newest located sighting from the
// trash log (drone GPS, or the laptop's location when detecting on its camera).

const FRESH_MS = 8000
const SOURCE = { drone: 'Drone GPS', laptop: 'Laptop GPS', sim: 'Sim GPS' }

function coord(v, pos, neg) {
  const n = Number(v)
  return `${Math.abs(n).toFixed(6)}° ${n >= 0 ? pos : neg}`
}

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function LatestDetectionBanner() {
  const log = useTrashLog()
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const spots = log.filter((e) => e.located && Number.isFinite(e.lat) && Number.isFinite(e.lng))
  // Most recently SEEN (a spot seen again is merged into its old entry, which
  // keeps its place in the newest-first list).
  const idx = spots.reduce((best, s, i) => ((s.lastSeen || 0) > (spots[best].lastSeen || 0) ? i : best), 0)
  const e = spots[idx]
  if (!e) return null
  const number = spots.length - idx
  const seen = e.lastSeen || e.firstSeen || 0
  const fresh = now - (e.firstSeen || 0) < FRESH_MS

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${e.lat.toFixed(6)}, ${e.lng.toFixed(6)}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked: the numbers are on screen anyway */ }
  }

  return (
    // The outer div centres it; the inner one animates (framer-motion's own
    // transform would otherwise replace the centring translate).
    <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-3">
    <AnimatePresence>
      <motion.section
        key={e.id}
        initial={{ opacity: 0, y: -10, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        className="pointer-events-auto w-full max-w-[440px] rounded-2xl px-4 py-3"
        style={{
          background: 'rgba(8,12,20,0.86)',
          border: `2px solid ${fresh ? '#32D74B' : 'rgba(255,255,255,0.14)'}`,
          boxShadow: fresh ? '0 0 28px rgba(50,215,75,0.45)' : '0 8px 32px rgba(0,0,0,0.55)',
          backdropFilter: 'blur(14px)',
          transition: 'border-color 0.6s, box-shadow 0.6s',
        }}
        aria-live="polite"
        aria-label="Latest waste detection and its GPS position"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${fresh ? 'animate-pulse' : ''}`}
              style={{ background: fresh ? '#32D74B' : '#9ca3af' }}
            />
            <span className="truncate text-[15px] font-extrabold uppercase tracking-wide text-white sm:text-[16px]">
              {e.class || 'Waste'}{e.count > 1 ? ` ×${e.count}` : ''}
            </span>
          </span>
          <span className="shrink-0 text-[12px] font-semibold text-white/70">
            #{number} of {spots.length} · {ago(seen, now)}
          </span>
        </div>

        <button
          type="button"
          onClick={copy}
          className="mt-1.5 block w-full text-left font-mono text-[21px] font-bold leading-[1.2] tracking-tight text-white tnum sm:text-[25px]"
          title="Tap to copy the coordinates"
        >
          {coord(e.lat, 'N', 'S')}
          <br />
          {coord(e.lng, 'E', 'W')}
        </button>

        <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] font-semibold">
          <span className="text-[#7BE495]">
            {SOURCE[e.posSource] || 'Drone GPS'}
            {e.accuracy != null && <span className="text-white/60"> · ±{Math.round(e.accuracy)} m</span>}
          </span>
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={copy}
              className="rounded-lg px-2.5 py-1 text-white active:scale-95"
              style={{ background: 'rgba(255,255,255,0.12)' }}
            >
              {copied ? '✔ Copied' : 'Copy'}
            </button>
            <a
              href={`https://www.google.com/maps?q=${e.lat.toFixed(6)},${e.lng.toFixed(6)}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg px-2.5 py-1 text-white active:scale-95"
              style={{ background: 'rgba(59,158,255,0.75)' }}
            >
              Map ↗
            </a>
          </span>
        </div>
      </motion.section>
    </AnimatePresence>
    </div>
  )
}
