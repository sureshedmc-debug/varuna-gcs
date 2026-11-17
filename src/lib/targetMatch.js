// Is the plastic the boat's camera sees the SAME piece the drone found?
//
// The drone-to-boat workflow: every drone find keeps a crop of the item
// (droneTargets.js). When the boat closes in on one, the boat vision engine
// (boatVision.js) scores each plastic box in the boat's video against that
// crop and sends the scores to the boat with the boxes; the boat only homes
// onto a box that scores at least its match_threshold.
//
//   score = 0.60 x appearance   (colour + shape signature, crop vs reference)
//         + 0.30 x class        (same kind of plastic?)
//         + 0.10 x detector     (how sure the boat's AI is)
//
// Appearance is classic computer vision, cheap enough for every box at 3 Hz:
//   * the item's pixels are separated from the water (the crop's border is
//     taken as the background);
//   * colour: a hue x saturation x brightness histogram of those pixels and
//     their mean colour;
//   * shape/texture: a histogram of edge directions (weighted by edge
//     strength), turned so its strongest direction comes first — so it does
//     not depend on how the item lies, or on the drone's vs the boat's angle;
//   * fill: how much of its box the item fills.
//
// Images are { data: RGBA bytes, width, height } (canvas ImageData), so this
// runs in the page and in Node tests. A learned model can replace
// `signature` / `similarity` later (e.g. an ONNX embedding, cosine
// similarity) without changing how the scores are used.

export const SIG = 40 // crops are compared at 40 x 40
const H_BINS = 12, S_BINS = 3, V_BINS = 3, G_BINS = 8
const W_LOOK = 0.75, W_CLASS = 0.2, W_CONF = 0.05

const KINDS = [
  ['bottle', 'bottle'], ['pet', 'bottle'],
  ['bag', 'bag'], ['wrapper', 'bag'], ['film', 'bag'], ['sachet', 'bag'], ['packet', 'bag'],
  ['cup', 'cup'], ['glass', 'cup'],
  ['container', 'container'], ['box', 'container'], ['tub', 'container'], ['can', 'container'],
  ['foam', 'foam'], ['styrofoam', 'foam'], ['thermocol', 'foam'],
]
const UNKNOWN = new Set(['', 'trash', 'plastic', 'item', 'object', 'other', 'other plastic', 'debris', 'litter', 'waste'])

/** 'plastic bottle' → 'bottle'; 'trash' / '' → null (unknown). Same rules as the boat's target_match.py. */
export function kind(label) {
  const s = String(label || '').trim().toLowerCase()
  if (UNKNOWN.has(s)) return null
  for (const [word, k] of KINDS) if (s.includes(word)) return k
  return s.replace('plastic', '').trim() || null
}

export function classAgreement(a, b) {
  const ka = kind(a), kb = kind(b)
  if (ka == null || kb == null) return 0.5
  return ka === kb ? 1 : 0.15
}

/** Nearest-pixel resize to SIG x SIG (a canvas drawImage does this better in the page). */
function toSig(img) {
  if (img.width === SIG && img.height === SIG) return img
  const out = new Uint8ClampedArray(SIG * SIG * 4)
  for (let y = 0; y < SIG; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / SIG))
    for (let x = 0; x < SIG; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / SIG))
      const i = (sy * img.width + sx) * 4, o = (y * SIG + x) * 4
      out[o] = img.data[i]; out[o + 1] = img.data[i + 1]; out[o + 2] = img.data[i + 2]; out[o + 3] = 255
    }
  }
  return { data: out, width: SIG, height: SIG }
}

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return [h / 360, mx ? d / mx : 0, mx / 255]
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

/**
 * The drone's and the boat's cameras see the same item in different light and
 * colour tint. Both crops have water all round the item, so the water (the
 * crop's border) is the white reference: scaling it to the same neutral grey
 * cancels the camera's tint and exposure while the item keeps its own colour
 * relative to the water.
 */
function normalise(im) {
  const src = im.data, n = im.width
  const border = []
  for (let i = 0; i < n; i++) border.push(i, (n - 1) * n + i, i * n, i * n + n - 1)
  const med = (k) => median(border.map((p) => src[p * 4 + k]))
  const r = med(0), g = med(1), b = med(2)
  const grey = Math.max(8, (r + g + b) / 3)
  const lim = (v) => Math.min(2.5, Math.max(0.4, v))
  const bright = Math.min(3, Math.max(0.33, 118 / grey))
  const k = [lim(grey / Math.max(1, r)) * bright, lim(grey / Math.max(1, g)) * bright, lim(grey / Math.max(1, b)) * bright]
  // Float, not clipped at 255: dark teal water needs big gains, and clipping
  // would turn every light item plain white (losing its colour).
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i] * k[0]; out[i + 1] = src[i + 1] * k[1]; out[i + 2] = src[i + 2] * k[2]; out[i + 3] = 255
  }
  return { data: out, width: im.width, height: im.height }
}

/**
 * The appearance signature of an image (any size); null for no image.
 * `raw: true` = the earlier signature (no lighting correction, hard hue bins),
 * kept for imageSearch.js, which compares against its own pixel bins.
 */
export function signature(img, { raw = false } = {}) {
  if (!img || !img.width || !img.height) return null
  const im = raw ? toSig(img) : normalise(toSig(img))
  const n = SIG, px = im.data
  const at = (x, y) => (y * n + x) * 4
  const border = []
  for (let i = 0; i < n; i++) border.push(at(i, 0), at(i, n - 1), at(0, i), at(n - 1, i))
  const bg = [0, 1, 2].map((k) => median(border.map((i) => px[i + k])))
  const fg = new Uint8Array(n * n)
  let count = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = at(x, y)
      const d = Math.hypot(px[i] - bg[0], px[i + 1] - bg[1], px[i + 2] - bg[2])
      if (d > 40) { fg[y * n + x] = 1; count++ }
    }
  }
  if (count < n * n * 0.04) {
    // The crop is all item (a tight box): use its middle.
    count = 0
    for (let y = n >> 2; y < n - (n >> 2); y++) for (let x = n >> 2; x < n - (n >> 2); x++) { fg[y * n + x] = 1; count++ }
  }
  const hist = new Float32Array(H_BINS * S_BINS * V_BINS)
  const mean = [0, 0, 0]
  const grad = new Float32Array(G_BINS)
  let x0 = n, y0 = n, x1 = 0, y1 = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!fg[y * n + x]) continue
      const i = at(x, y)
      const [h, s, v] = hsv(px[i], px[i + 1], px[i + 2])
      const sb = Math.min(S_BINS - 1, Math.floor(s * S_BINS))
      const vb = Math.min(V_BINS - 1, Math.floor(v * V_BINS))
      if (sb === 0) {
        hist[sb * V_BINS + vb]++ // greys / whites: hue means nothing
      } else if (raw) {
        hist[(Math.min(H_BINS - 1, Math.floor(h * H_BINS)) * S_BINS + sb) * V_BINS + vb]++
      } else {
        // Soft hue bins: a colour on a bin edge counts half in each, so a small
        // tint left over doesn't flip it into the neighbouring bin.
        const hf = h * H_BINS - 0.5
        const h0 = (Math.floor(hf) + H_BINS) % H_BINS, h1 = (h0 + 1) % H_BINS, fr = hf - Math.floor(hf)
        hist[(h0 * S_BINS + sb) * V_BINS + vb] += 1 - fr
        hist[(h1 * S_BINS + sb) * V_BINS + vb] += fr
      }
      mean[0] += px[i]; mean[1] += px[i + 1]; mean[2] += px[i + 2]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && y > 0 && x < n - 1 && y < n - 1) {
        // Sobel-ish gradient on brightness
        const L = (xx, yy) => { const j = at(xx, yy); return px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114 }
        const gx = L(x + 1, y) - L(x - 1, y), gy = L(x, y + 1) - L(x, y - 1)
        const mag = Math.hypot(gx, gy)
        if (mag > 8) {
          const a = (Math.atan2(gy, gx) + Math.PI) % Math.PI // 0..π: an edge has no sign
          grad[Math.min(G_BINS - 1, Math.floor((a / Math.PI) * G_BINS))] += mag
        }
      }
    }
  }
  for (let k = 0; k < hist.length; k++) hist[k] /= count
  for (let k = 0; k < 3; k++) mean[k] /= count
  // Rotate the edge histogram so its strongest direction is first.
  let top = 0
  for (let k = 1; k < G_BINS; k++) if (grad[k] > grad[top]) top = k
  const gsum = grad.reduce((a, b) => a + b, 0)
  const g = new Float32Array(G_BINS)
  for (let k = 0; k < G_BINS; k++) g[k] = gsum ? grad[(top + k) % G_BINS] / gsum : 0
  const fill = count / Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1))
  return { hist, mean, grad: gsum ? g : null, fill }
}

/** The earlier comparison, unchanged, for imageSearch.js (its own, un-normalised signatures). */
export function legacySimilarity(a, b) {
  if (!a || !b) return null
  let inter = 0
  for (let k = 0; k < a.hist.length; k++) inter += Math.min(a.hist[k], b.hist[k])
  const meanSim = Math.max(0, 1 - Math.hypot(a.mean[0] - b.mean[0], a.mean[1] - b.mean[1], a.mean[2] - b.mean[2]) / 200)
  let shape = null
  if (a.grad && b.grad) {
    let gi = 0
    for (let k = 0; k < G_BINS; k++) gi += Math.min(a.grad[k], b.grad[k])
    shape = 0.7 * gi + 0.3 * (1 - Math.min(1, Math.abs(a.fill - b.fill) * 2))
  }
  const colour = 0.6 * inter + 0.4 * meanSim
  return Math.max(0, Math.min(1, shape == null ? colour : 0.8 * colour + 0.2 * shape))
}

/** 0..1: how alike two signatures look. */
export function similarity(a, b) {
  if (!a || !b) return null
  // Bhattacharyya coefficient: smoother and more telling than plain overlap.
  let bc = 0
  for (let k = 0; k < a.hist.length; k++) bc += Math.sqrt(a.hist[k] * b.hist[k])
  // Mean colour as chromaticity (r, g, b shares), so brightness doesn't count twice.
  const chroma = (m) => { const t = m[0] + m[1] + m[2] || 1; return [m[0] / t, m[1] / t, m[2] / t] }
  const ca = chroma(a.mean), cb = chroma(b.mean)
  const meanSim = Math.max(0, 1 - Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) / 0.15)
  let shape = null
  if (a.grad && b.grad) {
    let gi = 0
    for (let k = 0; k < G_BINS; k++) gi += Math.sqrt(a.grad[k] * b.grad[k])
    shape = 0.7 * gi + 0.3 * (1 - Math.min(1, Math.abs(a.fill - b.fill) * 2))
  }
  const colour = 0.6 * bc + 0.4 * meanSim
  const s = shape == null ? colour : 0.85 * colour + 0.15 * shape
  // Spread the scale: unrelated items rarely score below ~0.42 on raw look,
  // so map 0.42..1 onto 0..1 to keep them clear of the threshold.
  return Math.max(0, Math.min(1, (s - 0.42) / 0.58))
}

/**
 * Score a candidate against the drone's item: { score 0..1, parts }.
 * Parts that can't be judged (no images) are left out and the weights renormalised.
 */
export function matchScore(refSig, refClass, candSig, candClass, candConf) {
  const parts = { class: classAgreement(refClass, candClass) }
  if (Number.isFinite(candConf)) parts.detector = Math.max(0, Math.min(1, candConf))
  const look = refSig && candSig ? similarity(refSig, candSig) : null
  if (look != null) parts.look = look
  const w = { look: W_LOOK, class: W_CLASS, detector: W_CONF }
  let tot = 0, s = 0
  for (const [k, v] of Object.entries(parts)) { tot += w[k]; s += w[k] * v }
  s = tot ? s / tot : 0
  // A clearly different-looking item never matches on class alone, and two
  // look-alikes the AIs call different things are probably different items.
  if (look != null && look < 0.25) s = Math.min(s, look + 0.2)
  if (parts.class < 0.5) s *= 0.75
  const r3 = (v) => Math.round(v * 1000) / 1000
  return { score: r3(s), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r3(v)])) }
}
