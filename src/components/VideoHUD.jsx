import { useState } from 'react'
import { api } from '../api/client'
import { num, DASH } from '../lib/format'
import { StatusOrb } from './ui'

// A vertical "tape" gauge (speed on the left, altitude on the right) drawn as a
// column of tick values centered on the current reading — the classic FPV HUD.
function Tape({ label, value, unit, align = 'left', step = 5 }) {
  const v = Number(value)
  const base = Number.isNaN(v) ? 0 : v
  const ticks = [4, 3, 2, 1, 0, -1, -2, -3, -4].map((k) => base + k * step)
  return (
    <div
      className={`pointer-events-none flex flex-col ${align === 'left' ? 'items-start' : 'items-end'} gap-1 rounded-lg bg-black/35 px-2 py-2 backdrop-blur-sm`}
      style={{ minWidth: 62 }}
    >
      <span className="text-[9px] font-semibold tracking-wider text-white/60">{label}</span>
      <div className="relative flex flex-col items-center gap-1">
        {ticks.map((t, i) => {
          const mid = i === 4
          return (
            <span
              key={i}
              className={`font-mono tnum ${mid ? 'text-white' : 'text-white/35'} ${mid ? 'text-base font-bold' : 'text-[10px]'}`}
              style={mid ? { textShadow: '0 0 8px rgba(59,158,255,0.9)' } : undefined}
            >
              {mid ? (Number.isNaN(v) ? DASH : num(base, unit === 'm' ? 0 : 1)) : num(Math.max(0, t), 0)}
            </span>
          )
        })}
      </div>
      <span className="text-[9px] font-semibold tracking-wider text-white/60">{unit}</span>
    </div>
  )
}

export default function VideoHUD({ speed, altitude, aiOn, fill = false }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`relative overflow-hidden bg-[#0B1220] ${fill ? 'h-full w-full rounded-2xl' : 'aspect-video w-full rounded-xl'}`}>
      {!failed ? (
        <img
          src={api.streamUrl()}
          alt="Live drone feed"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-300">
          <StatusOrb level="bad" size={14} pulse />
          <div className="text-xs">Video stream unavailable</div>
          <button onClick={() => setFailed(false)} className="rounded-lg bg-white/10 px-3 py-1 text-xs text-white">
            Retry
          </button>
        </div>
      )}

      {/* HUD overlays */}
      <div className="absolute left-2 top-1/2 -translate-y-1/2">
        <Tape label="SPD" value={speed} unit="km/h" align="left" step={5} />
      </div>
      <div className="absolute right-2 top-1/2 -translate-y-1/2">
        <Tape label="ALT" value={altitude} unit="m" align="right" step={2} />
      </div>

      {/* center reticle */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative h-10 w-10">
          <div className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-white/70" />
          <div className="absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-white/70" />
          <div className="absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-white/70" />
          <div className="absolute right-0 top-1/2 h-px w-3 -translate-y-1/2 bg-white/70" />
          <div className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40" />
        </div>
      </div>

      {/* AI badge */}
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur">
        <StatusOrb level={aiOn ? 'ok' : 'idle'} size={8} pulse={aiOn} />
        <span className="text-[10px] font-semibold text-white">{aiOn ? 'AI DETECTION' : 'AI OFF'}</span>
      </div>

      {/* REC */}
      <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur">
        <span className="h-2 w-2 rounded-full bg-bad" style={{ boxShadow: '0 0 8px #EF4444' }} />
        <span className="text-[10px] font-semibold tracking-wider text-white">LIVE</span>
      </div>
    </div>
  )
}
