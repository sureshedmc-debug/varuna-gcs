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

// 256-step colour ramp (cold → hot) used to colourize the accumulated density
// in renderHeatmapChart, the same "gradient lookup by alpha" technique real
// heatmap libraries use — built once as a 1×256 canvas, read back as pixels.
function heatPalette() {
  const c = document.createElement('canvas')
  c.width = 1
  c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0.0, 'rgba(59,130,246,0)')
  g.addColorStop(0.25, 'rgba(59,130,246,1)')
  g.addColorStop(0.5, 'rgba(34,211,238,1)')
  g.addColorStop(0.7, 'rgba(52,211,153,1)')
  g.addColorStop(0.85, 'rgba(250,204,21,1)')
  g.addColorStop(1.0, 'rgba(239,68,68,1)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1, 256)
  return ctx.getImageData(0, 0, 1, 256).data
}

/**
 * Render a density heatmap of trash locations as a PNG data URL. No map
 * tiles (would need a network fetch, breaking the report's offline
 * generation) — instead plots points in their own relative lat/lng space
 * with a light grid and corner coordinates for reference, same self-contained
 * canvas approach as the bar/pie charts above.
 * `points`: [{ lat, lng, weight }] — weight 0..1, already normalised by the caller.
 */
export function renderHeatmapChart({ title = 'Trash Density Heatmap', points = [], width = 900, height = 520 } = {}) {
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

  const padL = 70
  const padR = 40
  const padTop = 70
  const padBottom = 60
  const plotW = width - padL - padR
  const plotH = height - padTop - padBottom

  if (!points.length) {
    ctx.fillStyle = '#9199a6'
    ctx.font = '500 14px Inter, Arial, sans-serif'
    ctx.fillText('No located trash yet — run detection with GPS to build a density map.', 30, 60)
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return ''
    }
  }

  let minLat = Math.min(...points.map((p) => p.lat))
  let maxLat = Math.max(...points.map((p) => p.lat))
  let minLng = Math.min(...points.map((p) => p.lng))
  let maxLng = Math.max(...points.map((p) => p.lng))
  // A single point (or a tight cluster) has ~zero span — pad it out to a
  // sensible ~80 m box so the plot isn't a single dot with no context.
  const MIN_SPAN = 0.0008
  if (maxLat - minLat < MIN_SPAN) {
    const mid = (maxLat + minLat) / 2
    minLat = mid - MIN_SPAN / 2
    maxLat = mid + MIN_SPAN / 2
  }
  if (maxLng - minLng < MIN_SPAN) {
    const mid = (maxLng + minLng) / 2
    minLng = mid - MIN_SPAN / 2
    maxLng = mid + MIN_SPAN / 2
  }
  const toXY = (lat, lng) => [
    padL + ((lng - minLng) / (maxLng - minLng)) * plotW,
    // North (higher lat) is up — invert Y.
    padTop + (1 - (lat - minLat) / (maxLat - minLat)) * plotH,
  ]

  // Backdrop panel + grid so the heat blobs have a spatial frame of reference.
  ctx.fillStyle = '#0b1220'
  ctx.fillRect(padL, padTop, plotW, plotH)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  for (let i = 1; i < 6; i++) {
    const gx = padL + (plotW * i) / 6
    const gy = padTop + (plotH * i) / 6
    ctx.beginPath()
    ctx.moveTo(gx, padTop)
    ctx.lineTo(gx, padTop + plotH)
    ctx.moveTo(padL, gy)
    ctx.lineTo(padL + plotW, gy)
    ctx.stroke()
  }

  // Accumulate density on an offscreen alpha canvas: each point stamps a soft
  // radial-gradient circle (black centre → transparent edge), scaled by its
  // weight, drawn additively so overlaps build up higher alpha = hotter.
  const radius = Math.max(24, Math.min(plotW, plotH) / 8)
  const tmp = document.createElement('canvas')
  tmp.width = radius * 2
  tmp.height = radius * 2
  const tctx = tmp.getContext('2d')
  const grad = tctx.createRadialGradient(radius, radius, 0, radius, radius, radius)
  grad.addColorStop(0, 'rgba(0,0,0,1)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  tctx.fillStyle = grad
  tctx.fillRect(0, 0, radius * 2, radius * 2)

  const alphaCv = document.createElement('canvas')
  alphaCv.width = plotW
  alphaCv.height = plotH
  const actx = alphaCv.getContext('2d')
  for (const p of points) {
    const [x, y] = toXY(p.lat, p.lng)
    actx.globalAlpha = Math.max(0.12, Math.min(1, p.weight ?? 0.4))
    actx.drawImage(tmp, x - padL - radius, y - padTop - radius)
  }

  // Colourize: map each pixel's accumulated alpha through the heat palette.
  const palette = heatPalette()
  const img = actx.getImageData(0, 0, plotW, plotH)
  const out = actx.createImageData(plotW, plotH)
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]
    if (!a) continue
    out.data[i] = palette[a * 4]
    out.data[i + 1] = palette[a * 4 + 1]
    out.data[i + 2] = palette[a * 4 + 2]
    out.data[i + 3] = Math.min(255, a + 90) // floor opacity so light hits stay visible, not just hot spots
  }
  actx.putImageData(out, 0, 0)
  ctx.drawImage(alphaCv, padL, padTop)

  // Frame + corner coordinates for spatial reference (no map tiles available offline).
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.strokeRect(padL, padTop, plotW, plotH)
  ctx.fillStyle = '#4b5563'
  ctx.font = '500 10px Consolas, monospace'
  ctx.fillText(`${minLat.toFixed(5)}, ${minLng.toFixed(5)}`, padL, padTop + plotH + 6)
  ctx.textAlign = 'right'
  ctx.fillText(`${maxLat.toFixed(5)}, ${maxLng.toFixed(5)}`, padL + plotW, padTop - 16)
  ctx.textAlign = 'left'

  // Legend: a small horizontal gradient bar, Low → High.
  const legX = padL
  const legY = padTop + plotH + 22
  const legW = 200
  const legGrad = ctx.createLinearGradient(legX, 0, legX + legW, 0)
  legGrad.addColorStop(0, '#3B82F6')
  legGrad.addColorStop(0.5, '#22D3EE')
  legGrad.addColorStop(0.75, '#34D399')
  legGrad.addColorStop(1, '#EF4444')
  ctx.fillStyle = legGrad
  ctx.fillRect(legX, legY, legW, 10)
  ctx.strokeStyle = '#d1d5db'
  ctx.strokeRect(legX, legY, legW, 10)
  ctx.fillStyle = '#4b5563'
  ctx.font = '600 11px Inter, Arial, sans-serif'
  ctx.fillText('Low density', legX, legY + 16)
  ctx.textAlign = 'right'
  ctx.fillText('High density', legX + legW, legY + 16)
  ctx.textAlign = 'left'

  try {
    return canvas.toDataURL('image/png')
  } catch {
    return ''
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

  const located = (data?.detections || []).filter((d) => d.located && Number.isFinite(d.lat) && Number.isFinite(d.lng))
  if (located.length) {
    const maxCount = Math.max(1, ...located.map((d) => Number(d.count) || 1))
    const heatPoints = located.map((d) => ({ lat: d.lat, lng: d.lng, weight: 0.35 + 0.65 * ((Number(d.count) || 1) / maxCount) }))
    const heatUrl = renderHeatmapChart({ title: 'Trash Density Heatmap', points: heatPoints })
    if (heatUrl) out.push({ title: 'Trash Density Heatmap', dataUrl: heatUrl })
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
