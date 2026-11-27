import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTrashLog } from '../lib/trashLog'

// Live tab, bottom-right: where waste has been detected, newest first. Each
// spot's position comes from the drone's GPS (telemetry) or, when detecting
// on the laptop camera, the laptop's own location.

const SOURCE = {
  drone:  { label: 'Drone GPS',  color: '#32D74B' },
  laptop: { label: 'Laptop GPS', color: '#FF9F0A' },
  sim:    { label: 'Sim GPS',    color: '#F59E0B' },
}
const FRESH_MS = 8000

function coord(v, pos, neg) {
  const n = Number(v)
  return `${Math.abs(n).toFixed(6)}° ${n >= 0 ? pos : neg}`
}

function clock(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
}

export default function WasteLocationsPanel({ show }) {
  const log = useTrashLog()
  // Re-render every 2 s so the "new" highlight fades on its own.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const spots = log.filter((e) => e.located && Number.isFinite(e.lat) && Number.isFinite(e.lng))
  const unlocated = log.length - spots.length
  const now = Date.now()

  return (
    <AnimatePresence>
      {show && (
        <motion.section
          key="waste-gps"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          className="absolute bottom-20 right-3 z-20 flex max-h-[38%] w-[min(320px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl"
          style={{
            background: 'rgba(13,17,26,0.9)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(16px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
          aria-label="Waste detected at these locations"
        >
          <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
            <div className="min-w-0">
              <div className="eyebrow">Waste detected at</div>
              <div className="text-[11px] text-muted">
                {spots.length ? `${spots.length} location${spots.length === 1 ? '' : 's'}` : 'No located waste yet'}
              </div>
            </div>
            <span
              className="rounded-md px-2 py-0.5 font-mono text-[12px] font-bold tnum"
              style={{ background: 'rgba(45,212,191,0.14)', color: 'var(--accent-hex)', border: '1px solid rgba(45,212,191,0.28)' }}
            >
              {spots.length}
            </span>
          </header>

          <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
            {spots.length === 0 && (
              <li className="rounded-lg px-3 py-2.5 text-[11.5px] leading-snug text-muted" style={{ background: 'rgba(255,255,255,0.04)' }}>
                When the AI spots waste, its GPS coordinates appear here, taken from the drone's telemetry or the laptop's location.
              </li>
            )}
            <AnimatePresence initial={false}>
              {spots.map((e, i) => {
                const src = SOURCE[e.posSource] || SOURCE.drone
                const fresh = now - (e.firstSeen || 0) < FRESH_MS
                return (
                  <motion.li
                    key={e.id}
                    layout
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-lg px-2.5 py-2"
                    style={{
                      background: fresh ? 'rgba(45,212,191,0.10)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${fresh ? 'rgba(45,212,191,0.35)' : 'rgba(255,255,255,0.06)'}`,
                      transition: 'background 0.6s, border-color 0.6s',
                    }}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="font-mono text-[10px] font-bold text-faint">#{spots.length - i}</span>
                        <span className="truncate text-[13.5px] font-bold capitalize text-ink">
                          {e.class || 'waste'}{e.count > 1 ? ` ×${e.count}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-faint">{clock(e.firstSeen)}</span>
                    </div>
                    <div className="font-mono text-[15px] font-bold leading-tight tnum text-ink">
                      {coord(e.lat, 'N', 'S')}
                      <br />
                      {coord(e.lng, 'E', 'W')}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: src.color }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: src.color }} />
                      {src.label}
                      {e.accuracy != null && <span className="text-faint">· ±{Math.round(e.accuracy)} m</span>}
                    </div>
                  </motion.li>
                )
              })}
            </AnimatePresence>
            {unlocated > 0 && (
              <li className="px-1 pt-1 text-[10.5px] text-faint">
                {unlocated} more sighting{unlocated === 1 ? '' : 's'} had no GPS fix.
              </li>
            )}
          </ol>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
