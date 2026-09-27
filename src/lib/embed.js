// A tiny visual fingerprint for one detection box.
//
// The self-learning filter needs to answer "does this box look like something
// already known to be a false positive?" hundreds of times a second, on the
// same thread that is already running three ONNX models. A neural embedding
// is far too expensive for that, so this is a classical descriptor: a
// contrast-normalised thumbnail plus a coarse colour layout, computed on a
// 16x16 canvas in well under a millisecond.
//
// It is deliberately crude. It will not tell a bottle from a can — but it
// reliably recognises "that same beige blob on the bank again", which is
// exactly what false-positive suppression needs. Contrast normalisation makes
// it survive changes in exposure and time of day; the colour block keeps it
// from confusing a dark object with a bright one of the same shape.

const N = 16 // thumbnail edge
const GRAY = 8 // grayscale cells per edge -> 64 dims
const COLOR = 4 // colour cells per edge    -> 32 dims (two opponent channels)
export const EMBED_DIM = GRAY * GRAY + COLOR * COLOR * 2 + 2 // + aspect, fill

// The three blocks are normalised SEPARATELY and then weighted, because they
// are not comparable on their own terms. Contrast-normalised grayscale has a
// much larger natural magnitude than colour does, so a single normalisation
// over the whole vector lets texture drown colour out — and then a beige pile
// of clothes and a cyan bottle of the same shape come out 0.95 similar, which
// would make the live filter suppress far more than it should.
const W_GRAY = 0.6
const W_COLOR = 0.7
const W_SHAPE = 0.25

let cv = null
let cx = null
function scratch() {
  if (!cv) {
    cv = document.createElement('canvas')
    cv.width = N
    cv.height = N
    cx = cv.getContext('2d', { willReadFrequently: true })
  }
  return cx
}

/**
 * Fingerprint the region of `source` covered by `box` (pixel coords).
 * @returns {Float32Array|null} L2-normalised descriptor, or null if the crop
 *   is unusable (zero-size, or the source canvas is cross-origin tainted).
 */
export function embedCrop(source, box, frameW, frameH) {
  const w = box.x2 - box.x1
  const h = box.y2 - box.y1
  if (!(w > 1 && h > 1)) return null
  const ctx = scratch()
  let px
  try {
    ctx.clearRect(0, 0, N, N)
    ctx.drawImage(source, box.x1, box.y1, w, h, 0, 0, N, N)
    px = ctx.getImageData(0, 0, N, N).data
  } catch {
    return null // tainted canvas (cross-origin drone stream)
  }

  const out = new Float32Array(EMBED_DIM)

  // --- grayscale block: mean/std normalised, so exposure doesn't matter ---
  const gray = new Float32Array(GRAY * GRAY)
  const step = N / GRAY
  for (let gy = 0; gy < GRAY; gy++) {
    for (let gx = 0; gx < GRAY; gx++) {
      let sum = 0
      let n = 0
      for (let y = gy * step; y < (gy + 1) * step; y++) {
        for (let x = gx * step; x < (gx + 1) * step; x++) {
          const i = (y * N + x) * 4
          sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
          n++
        }
      }
      gray[gy * GRAY + gx] = sum / (n || 1)
    }
  }
  let mean = 0
  for (const v of gray) mean += v
  mean /= gray.length
  let variance = 0
  for (const v of gray) variance += (v - mean) ** 2
  const std = Math.sqrt(variance / gray.length) || 1
  for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - mean) / std

  // --- colour block: opponent channels, NOT raw RGB ---
  // Raw RGB components are all positive, so the cosine between any two
  // natural colours is high — brown and cyan come out 0.8 similar, which is
  // useless for telling them apart. Red-green and yellow-blue are centred on
  // zero and genuinely oppose each other. Brightness is left out: the
  // grayscale block already carries it.
  const cstep = N / COLOR
  let o = gray.length
  for (let gy = 0; gy < COLOR; gy++) {
    for (let gx = 0; gx < COLOR; gx++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = gy * cstep; y < (gy + 1) * cstep; y++) {
        for (let x = gx * cstep; x < (gx + 1) * cstep; x++) {
          const i = (y * N + x) * 4
          r += px[i]
          g += px[i + 1]
          b += px[i + 2]
          n++
        }
      }
      n = n || 1
      r /= n
      g /= n
      b /= n
      out[o++] = (r - g) / 255 // red vs green
      out[o++] = (r + g - 2 * b) / 510 // yellow vs blue
    }
  }

  // --- shape: log aspect ratio and how much of the frame the box fills ---
  const shapeAt = o
  out[o++] = Math.max(-2, Math.min(2, Math.log(w / h))) / 2
  out[o++] = frameW && frameH ? Math.sqrt((w * h) / (frameW * frameH)) : 0

  // Normalise each block to unit length, then apply its weight, then
  // normalise the whole vector so similarity is a plain dot product.
  scaleBlock(out, 0, gray.length, W_GRAY)
  scaleBlock(out, gray.length, shapeAt, W_COLOR)
  scaleBlock(out, shapeAt, out.length, W_SHAPE)
  let norm = 0
  for (const v of out) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

function scaleBlock(v, from, to, weight) {
  let n = 0
  for (let i = from; i < to; i++) n += v[i] * v[i]
  const s = weight / (Math.sqrt(n) || 1)
  for (let i = from; i < to; i++) v[i] *= s
}

/** Cosine similarity of two L2-normalised descriptors (-1..1). */
export function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Highest similarity between `v` and any descriptor in `list`. */
export function nearest(v, list) {
  let best = -1
  for (const u of list) {
    const s = similarity(v, u)
    if (s > best) best = s
  }
  return best
}

// Descriptors are stored in IndexedDB, where a Float32Array survives the
// structured clone but a plain array is smaller and safer across upgrades.
export const packEmbed = (v) => (v ? Array.from(v, (x) => Math.round(x * 4096) / 4096) : null)
export const unpackEmbed = (a) => (Array.isArray(a) ? Float32Array.from(a) : null)
