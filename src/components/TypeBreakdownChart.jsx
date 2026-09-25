// Small SVG donut summarising which trash classes have been seen. Lives in
// the Detections tab; updates live as new detections come in. Colors match
// labels.js CANON so the chart, the boxes on the video, and the report
// pie all agree.

const CLASS_COLOR = { 'plastic bottle': '#22D3EE', trash: '#3B9EFF', 'river trash': '#00B8A9' }
const CLASS_LABEL = { 'plastic bottle': 'Plastic bottle', trash: 'Trash', 'river trash': 'River trash' }

function arc(cx, cy, r, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0
  const x0 = cx + r * Math.cos(a0)
  const y0 = cy + r * Math.sin(a0)
  const x1 = cx + r * Math.cos(a1)
  const y1 = cy + r * Math.sin(a1)
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`
}

export default function TypeBreakdownChart({ byClass = {}, size = 120 }) {
  const items = Object.entries(byClass)
    .map(([k, v]) => ({ key: k, value: Number(v) || 0 }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
  const total = items.reduce((a, x) => a + x.value, 0)
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 2
  const rInner = r * 0.62
  let a0 = -Math.PI / 2
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label="Type breakdown">
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={r} fill="rgba(255,255,255,0.06)" />
        ) : (
          items.map((it) => {
            const a1 = a0 + (it.value / total) * Math.PI * 2
            const d = arc(cx, cy, r, a0, a1)
            const color = CLASS_COLOR[it.key] || '#3B9EFF'
            a0 = a1
            return <path key={it.key} d={d} fill={color} />
          })
        )}
        <circle cx={cx} cy={cy} r={rInner} fill="var(--panel, #181c22)" />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" style={{ fill: 'rgb(var(--ink))', font: '700 14px Inter, sans-serif' }}>
          {total}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" dominantBaseline="middle" style={{ fill: 'var(--muted)', font: '500 9px Inter, sans-serif' }}>
          items
        </text>
      </svg>
      <div className="flex flex-col gap-1 text-[11px]">
        {items.length === 0 ? (
          <span className="text-muted">No trash yet.</span>
        ) : (
          items.map((it) => (
            <div key={it.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CLASS_COLOR[it.key] || '#3B9EFF' }} />
              <span className="text-ink">{CLASS_LABEL[it.key] || it.key}</span>
              <span className="font-mono tnum text-muted">
                {it.value} ({total ? Math.round((it.value / total) * 100) : 0}%)
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
