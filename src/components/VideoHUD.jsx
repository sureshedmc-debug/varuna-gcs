import { useState } from 'react'
import { api } from '../api/client'
import { num, DASH } from '../lib/format'
import { StatusOrb } from './ui'
import StreamImg from './StreamImg'

// Classic FPV tape gauge — column of tick values centred on the current reading.
function Tape({ label, value, unit, align = 'left', step = 5 }) {
  const v = Number(value)
  const base = Number.isNaN(v) ? 0 : v
  const ticks = [3, 2, 1, 0, -1, -2, -3].map((k) => base + k * step)
  return (
    <div
      className="pointer-events-none flex flex-col gap-0.5 rounded-xl px-3 py-2"
      style={{
        minWidth: 58,
        background: 'rgba(0,0,0,0.58)',
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(8px)',
        alignItems: align === 'left' ? 'flex-start' : 'flex-end',
      }}
    >
      <span className="text-[9px] font-bold tracking-[0.14em] uppercase" style={{ color: 'rgba(255,255,255,0.45)' }}>
        {label}
      </span>
      <div className="flex flex-col items-center gap-0.5">
        {ticks.map((t, i) => {
          const mid = i === 3
          return (
            <span
              key={i}
              className={`font-mono tnum ${mid ? 'text-[18px] font-bold text-white' : 'text-[10px]'}`}
              style={{
                color: mid ? '#fff' : 'rgba(255,255,255,0.22)',
                textShadow: mid ? '0 0 12px rgba(59,158,255,0.9)' : undefined,
              }}
            >
              {mid ? (Number.isNaN(v) ? DASH : num(base, unit === 'm' ? 0 : 1)) : num(Math.max(0, t), 0)}
            </span>
          )
        })}
      </div>
      <span className="text-[9px] font-semibold" style={{ color: 'rgba(255,255,255,0.4)' }}>
        {unit}
      </span>
    </div>
  )
}

// Heading compass strip centred on current bearing.
function CompassStrip({ heading }) {
  const h = Number(heading)
  const base = Number.isNaN(h) ? 0 : Math.round(h)
  const DIRS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
  const ticks = [-30, -20, -10, 0, 10, 20, 30].map((d) => {
    const val = ((base + d) % 360 + 360) % 360
    return { val, label: DIRS[val] || null, offset: d }
  })
  return (
    <div
      className="pointer-events-none flex flex-col items-center gap-1"
    >
      <span className="text-[9px] font-bold tracking-[0.14em] uppercase" style={{ color: 'rgba(255,255,255,0.4)' }}>
        HDG
      </span>
      <div
        className="flex items-center gap-0"
        style={{
          background: 'rgba(0,0,0,0.58)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          padding: '4px 10px',
          backdropFilter: 'blur(8px)',
        }}
      >
        {ticks.map((t, i) => {
          const mid = t.offset === 0
          return (
            <span
              key={i}
              className="font-mono tnum"
              style={{
                fontSize: mid ? 13 : 10,
                fontWeight: mid ? 700 : 400,
                color: mid ? '#fff' : 'rgba(255,255,255,0.28)',
                padding: '0 5px',
                position: 'relative',
              }}
            >
              {t.label || t.val}
              {mid && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: -6,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    background: 'var(--accent-hex)',
                    display: 'block',
                  }}
                />
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// Corner-bracket targeting reticle (improved over the plain crosshair).
function Reticle() {
  const arm = 12
  const gap = 8
  const s = (arm + gap) * 2
  const c = s / 2
  const r = 20
  const strokeW = 2
  const color = 'rgba(255,255,255,0.72)'
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ overflow: 'visible' }}>
        {/* top-left */}
        <path d={`M ${c - gap} ${c - gap - arm} L ${c - gap} ${c - gap} L ${c - gap - arm} ${c - gap}`}
          stroke={color} strokeWidth={strokeW} fill="none" strokeLinecap="round" />
        {/* top-right */}
        <path d={`M ${c + gap + arm} ${c - gap} L ${c + gap} ${c - gap} L ${c + gap} ${c - gap - arm}`}
          stroke={color} strokeWidth={strokeW} fill="none" strokeLinecap="round" />
        {/* bottom-left */}
        <path d={`M ${c - gap - arm} ${c + gap} L ${c - gap} ${c + gap} L ${c - gap} ${c + gap + arm}`}
          stroke={color} strokeWidth={strokeW} fill="none" strokeLinecap="round" />
        {/* bottom-right */}
        <path d={`M ${c + gap} ${c + gap + arm} L ${c + gap} ${c + gap} L ${c + gap + arm} ${c + gap}`}
          stroke={color} strokeWidth={strokeW} fill="none" strokeLinecap="round" />
        {/* center ring */}
        <circle cx={c} cy={c} r={r} stroke="rgba(255,255,255,0.3)" strokeWidth={1} fill="none" />
        {/* center dot */}
        <circle cx={c} cy={c} r={2} fill="rgba(255,255,255,0.65)" />
        {/* crosshair lines */}
        <line x1={c} y1={c - gap + 2} x2={c} y2={c - r + 2} stroke={color} strokeWidth={1} />
        <line x1={c} y1={c + r - 2} x2={c} y2={c + gap - 2} stroke={color} strokeWidth={1} />
        <line x1={c - r + 2} y1={c} x2={c - gap + 2} y2={c} stroke={color} strokeWidth={1} />
        <line x1={c + gap - 2} y1={c} x2={c + r - 2} y2={c} stroke={color} strokeWidth={1} />
      </svg>
    </div>
  )
}

export default function VideoHUD({ speed, altitude, heading, aiOn, fill = false }) {
  const [failed, setFailed] = useState(false)
  return (
    <div
      className={`relative overflow-hidden bg-[#0A0E18] ${fill ? 'h-full w-full rounded-2xl' : 'aspect-video w-full rounded-xl'}`}
    >
      {!failed ? (
        <StreamImg
          src={api.streamUrl()}
          alt="Live drone feed"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3">
          <StatusOrb level="bad" size={14} pulse />
          <div className="text-xs text-muted">Video stream unavailable</div>
          <button
            onClick={() => setFailed(false)}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Reticle */}
      <Reticle />

      {/* Speed tape — left */}
      <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
        <Tape label="SPD" value={speed} unit="m/s" align="left" step={2} />
      </div>

      {/* Altitude tape — right */}
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
        <Tape label="ALT" value={altitude} unit="m" align="right" step={2} />
      </div>

      {/* Heading compass — top-right */}
      <div className="pointer-events-none absolute right-3 top-3">
        <CompassStrip heading={heading} />
      </div>

      {/* AI badge — top-left */}
      <div
        className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1"
        style={{
          background: 'rgba(0,0,0,0.65)',
          border: aiOn ? '1px solid rgba(50,215,75,0.3)' : '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <StatusOrb level={aiOn ? 'ok' : 'idle'} size={8} pulse={aiOn} />
        <span
          className="text-[10px] font-bold tracking-wider"
          style={{ color: aiOn ? '#32D74B' : 'rgba(255,255,255,0.45)' }}
        >
          {aiOn ? 'AI ACTIVE' : 'AI OFF'}
        </span>
      </div>

      {/* LIVE badge — below AI badge on left */}
      <div
        className="absolute left-3 top-10 flex items-center gap-1.5 rounded-full px-2.5 py-1"
        style={{
          background: 'rgba(0,0,0,0.65)',
          border: '1px solid rgba(255,69,58,0.3)',
          marginTop: 4,
        }}
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: 'var(--bad)', boxShadow: '0 0 6px #FF453A', animation: 'orb-pulse 1.6s ease-in-out infinite' }}
        />
        <span className="text-[10px] font-bold tracking-wider" style={{ color: '#FF453A' }}>
          LIVE
        </span>
      </div>
    </div>
  )
}
