import { motion } from 'framer-motion'

// Tiny inline-SVG charts for the stat tiles (bars / line / sparkline), with an
// animated draw-in that echoes the reference's sweeping chart reveals.

export function Bars({ data = [], color = '#34D399', width = 96, height = 34 }) {
  const n = data.length || 1
  const max = Math.max(1, ...data)
  const gap = 2
  const bw = (width - gap * (n - 1)) / n
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * height)
        return (
          <motion.rect
            key={i}
            x={i * (bw + gap)}
            width={bw}
            rx={1}
            fill={i === n - 1 ? '#3B9EFF' : color}
            opacity={i === n - 1 ? 1 : 0.85}
            initial={{ height: 0, y: height }}
            animate={{ height: h, y: height - h }}
            transition={{ delay: i * 0.03, type: 'spring', stiffness: 200, damping: 20 }}
          />
        )
      })}
    </svg>
  )
}

export function Line({ data = [], color = '#3B9EFF', width = 96, height = 34, fill = true }) {
  if (data.length < 2) data = [...data, ...data, 0]
  const max = Math.max(...data)
  const min = Math.min(...data)
  const span = max - min || 1
  const step = width / (data.length - 1)
  const pts = data.map((v, i) => [i * step, height - ((v - min) / span) * (height - 4) - 2])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${d} L${width},${height} L0,${height} Z`
  const gid = `g${color.replace('#', '')}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <motion.path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      />
    </svg>
  )
}

/** Horizontal labelled load bar with an animated fill (payload-status style). */
export function LoadBar({ label, pct, color = '#34D399' }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono tnum text-ink">{v.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-chip2">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}` }}
          initial={{ width: 0 }}
          animate={{ width: `${v}%` }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
      </div>
    </div>
  )
}
