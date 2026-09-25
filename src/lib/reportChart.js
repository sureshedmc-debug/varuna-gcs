// 3D-style (isometric) bar charts rendered on a 2D canvas → PNG data URLs.
//
// Dependency-free and GPU-free so it always renders (unlike WebGL), while still
// giving the "3D graphs" look: each bar is drawn as a box with a shaded top and
// side face. Used to embed charts as images in the generated Word report.

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// Lighten (amt > 0) or darken (amt < 0) a #rgb / #rrggbb color.
function shade(hex, amt) {
  let h = String(hex || '#3B9EFF').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  let r = (n >> 16) & 255
  let g = (n >> 8) & 255
  let b = n & 255
  r = clamp(r + amt, 0, 255)
  g = clamp(g + amt, 0, 255)
  b = clamp(b + amt, 0, 255)
  return `rgb(${r},${g},${b})`
}

function drawIsoBar(ctx, x, baseY, w, barH, depth, color) {
  const dx = depth
  const dy = -depth * 0.6
  const topY = baseY - barH
  // right face (darker)
  ctx.fillStyle = shade(color, -45)
  ctx.beginPath()
  ctx.moveTo(x + w, topY)
  ctx.lineTo(x + w + dx, topY + dy)
  ctx.lineTo(x + w + dx, baseY + dy)
  ctx.lineTo(x + w, baseY)
  ctx.closePath()
  ctx.fill()
  // top face (lighter)
  ctx.fillStyle = shade(color, 40)
  ctx.beginPath()
  ctx.moveTo(x, topY)
  ctx.lineTo(x + dx, topY + dy)
  ctx.lineTo(x + w + dx, topY + dy)
  ctx.lineTo(x + w, topY)
  ctx.closePath()
  ctx.fill()
  // front face
  ctx.fillStyle = color
  ctx.fillRect(x, topY, w, barH)
}

const PALETTE = ['#3B9EFF', '#32D74B', '#FF9F0A', '#FF453A', '#22D3EE', '#A78BFA', '#F472B6', '#00B8A9']
// Colors used by the in-app detector overlay + Detections tab per class
// (see labels.js CANON). Report and app charts stay visually in sync.
const CLASS_COLOR = { 'plastic bottle': '#22D3EE', trash: '#3B9EFF', 'river trash': '#00B8A9' }

/**
 * Render one isometric bar chart. items: [{label, value, color?}].
 * Returns a PNG data URL, or '' if the canvas is unavailable.
 */
export function renderBarChart3D({ title = '', items = [], width = 900, height = 460 } = {}) {
  let canvas
  try {
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
  } catch {
    return ''
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  // white document background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  // title
  ctx.fillStyle = '#14171c'
  ctx.font = '700 22px Inter, Arial, sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText(title, 40, 24)

  const padL = 64
  const padR = 40
  const padTop = 84
  const padBottom = 70
  const depth = 22
  const plotW = width - padL - padR - depth
  const baseY = height - padBottom
  const plotH = baseY - padTop

  const n = Math.max(1, items.length)
  const maxVal = Math.max(1, ...items.map((it) => Number(it.value) || 0))

  // y grid + axis
  ctx.strokeStyle = '#e5e7eb'
  ctx.fillStyle = '#9199a6'
  ctx.font = '500 12px Inter, Arial, sans-serif'
  ctx.lineWidth = 1
  const ticks = 4
  for (let i = 0; i <= ticks; i++) {
    const gy = baseY - (plotH * i) / ticks
    ctx.beginPath()
    ctx.moveTo(padL, gy)
    ctx.lineTo(padL + plotW, gy)
    ctx.stroke()
    const val = Math.round((maxVal * i) / ticks)
    ctx.fillText(String(val), 20, gy - 7)
  }

  // bars
  const slot = plotW / n
  const barW = Math.min(90, slot * 0.55)
  items.forEach((it, i) => {
    const value = Number(it.value) || 0
    const barH = Math.max(2, (value / maxVal) * (plotH - depth))
    const x = padL + i * slot + (slot - barW) / 2
    const color = it.color || PALETTE[i % PALETTE.length]
    drawIsoBar(ctx, x, baseY, barW, barH, depth, color)
    // value label
    ctx.fillStyle = '#14171c'
    ctx.font = '700 14px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(String(value), x + barW / 2 + depth / 2, baseY - barH + depth * -0.6 - 20)
    // category label
    ctx.fillStyle = '#4b5563'
    ctx.font = '600 13px Inter, Arial, sans-serif'
    wrapLabel(ctx, String(it.label ?? ''), x + barW / 2, baseY + 10, slot)
    ctx.textAlign = 'left'
  })

  try {
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

/**
 * Render one donut chart from items:[{label,value,color?}] to a PNG data URL.
 * Returns '' if the canvas isn't available.
 */
export function renderPieChart({ title = '', items = [], width = 620, height = 460 } = {}) {
  let canvas
  try {
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
  } catch {
    return ''
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#14171c'
  ctx.font = '700 22px Inter, Arial, sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText(title, 30, 22)

  const total = items.reduce((a, it) => a + (Number(it.value) || 0), 0)
  if (total <= 0) {
    ctx.fillStyle = '#9199a6'
    ctx.font = '500 14px Inter, Arial, sans-serif'
    ctx.fillText('No data yet', 30, 60)
    try { return canvas.toDataURL('image/png') } catch { return '' }
  }

  const cx = 200
  const cy = height / 2 + 20
  const r = Math.min(cx, cy) - 30
  const rInner = r * 0.55
  let a0 = -Math.PI / 2
  items.forEach((it, i) => {
    const v = Number(it.value) || 0
    if (v <= 0) return
    const a1 = a0 + (v / total) * Math.PI * 2
    const color = it.color || PALETTE[i % PALETTE.length]
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, r, a0, a1)
    ctx.closePath()
    ctx.fill()
    a0 = a1
  })
  // Donut hole
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2)
  ctx.fill()
  // Center total
  ctx.fillStyle = '#14171c'
  ctx.font = '800 32px Inter, Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(total), cx, cy - 6)
  ctx.font = '500 12px Inter, Arial, sans-serif'
  ctx.fillStyle = '#9199a6'
  ctx.fillText('items', cx, cy + 18)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  // Legend
  const lx = cx + r + 40
  let ly = cy - (items.length * 26) / 2
  ctx.font = '600 14px Inter, Arial, sans-serif'
  items.forEach((it, i) => {
    const v = Number(it.value) || 0
    const color = it.color || PALETTE[i % PALETTE.length]
    ctx.fillStyle = color
    ctx.fillRect(lx, ly, 16, 16)
    ctx.fillStyle = '#14171c'
    const pct = Math.round((v / total) * 100)
    ctx.fillText(`${it.label}  —  ${v} (${pct}%)`, lx + 24, ly + 1)
    ly += 26
  })

  try {
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

function wrapLabel(ctx, text, cx, y, maxW) {
  const words = text.split(' ')
  let line = ''
  let yy = y
  const lines = []
  for (const w of words) {
    const test = line ? line + ' ' + w : w
    if (ctx.measureText(test).width > maxW - 8 && line) {
      lines.push(line)
      line = w
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  for (const l of lines.slice(0, 2)) {
    ctx.fillText(l, cx, yy)
    yy += 16
  }
}

/**
 * Build the standard set of report charts from a dataset (see buildTrashDataset).
 * Returns [{ title, dataUrl }] skipping any that failed to render.
 */
export function renderReportCharts(data) {
  const out = []
  const s = data?.summary || {}
  const byClass = s.byClass || {}

  const classItems = Object.entries(byClass).map(([label, value], i) => ({
    label,
    value,
    color: CLASS_COLOR[label] || PALETTE[i % PALETTE.length],
  }))
  if (classItems.length) {
    const url = renderBarChart3D({ title: 'Detections by Type', items: classItems })
    if (url) out.push({ title: 'Detections by Type', dataUrl: url })
    const pieUrl = renderPieChart({ title: 'Trash Type Breakdown', items: classItems })
    if (pieUrl) out.push({ title: 'Trash Type Breakdown', dataUrl: pieUrl })
  }

  const coverage = [
    { label: 'Located (GPS)', value: s.located || 0, color: '#32D74B' },
    { label: 'Unlocated', value: s.unlocated || 0, color: '#FF9F0A' },
    { label: 'Live-cam peak', value: data?.liveCamera?.peakTrash || 0, color: '#3B9EFF' },
  ]
  const covUrl = renderBarChart3D({ title: 'Detection Coverage & Live Camera', items: coverage })
  if (covUrl) out.push({ title: 'Detection Coverage & Live Camera', dataUrl: covUrl })

  const b = s.confidenceBuckets || {}
  const confItems = [
    { label: '0-50%', value: b['0-50'] || 0, color: '#FF453A' },
    { label: '50-70%', value: b['50-70'] || 0, color: '#FF9F0A' },
    { label: '70-85%', value: b['70-85'] || 0, color: '#22D3EE' },
    { label: '85-100%', value: b['85-100'] || 0, color: '#32D74B' },
  ]
  if (confItems.some((it) => it.value > 0)) {
    const cUrl = renderBarChart3D({ title: 'Detection Confidence Distribution', items: confItems })
    if (cUrl) out.push({ title: 'Detection Confidence Distribution', dataUrl: cUrl })
  }

  return out
}
