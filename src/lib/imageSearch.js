// Finds the drone's item in the boat camera's picture, with no AI model:
// pure image matching against the drone's photo of it.
//
//  1. Candidates: whatever stands out from the water. Each row of the
//     (small) picture has its own water colour (the median of the row: the
//     water changes with distance and light, an item is a small part of a
//     row); pixels far from it — or close to the drone item's own colours —
//     are joined into blobs, and each blob is a candidate box.
//  2. Each candidate is cut out of the full picture and compared with the
//     drone's photo (targetMatch.js: colour + shape signature); the score is
//     how alike they look, 0..1.
//
// Images are { data: RGBA bytes, width, height } (canvas ImageData), so this
// runs in the page and in Node tests (scripts/test-image-search.mjs).

import { legacySimilarity as similarity } from './targetMatch.js'

const H_BINS = 12, S_BINS = 3, V_BINS = 3

function hsvBin(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  const s = mx ? d / mx : 0, v = mx / 255
  const sb = Math.min(S_BINS - 1, Math.floor(s * S_BINS))
  const hb = sb === 0 ? 0 : Math.min(H_BINS - 1, Math.floor((h / 360) * H_BINS))
  const vb = Math.min(V_BINS - 1, Math.floor(v * V_BINS))
  return (hb * S_BINS + sb) * V_BINS + vb
}

const median = (a) => { const s = Array.from(a).sort((x, y) => x - y); return s[s.length >> 1] }

/**
 * Boxes (in `img` pixels) of what stands out from the water.
 * `refSig`, if given, also picks up pixels in the drone item's own colours.
 * Options: rows `y0`..`y1` to search (default all), `minArea` (pixels),
 * `maxWidthFrac` (wider blobs are a shore or a wave band, not an item).
 */
export function findCandidates(img, refSig = null, { y0 = 0, y1 = img.height, minArea = 4, maxWidthFrac = 0.5, max = 12 } = {}) {
  const { width: W, data: px } = img
  const H = Math.min(img.height, y1)
  const mask = new Uint8Array(W * img.height)
  const dist = new Float32Array(W)
  for (let y = y0; y < H; y++) {
    const rs = new Uint8Array(W), gs = new Uint8Array(W), bs = new Uint8Array(W)
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; rs[x] = px[i]; gs[x] = px[i + 1]; bs[x] = px[i + 2] }
    const mr = median(rs), mg = median(gs), mb = median(bs)
    for (let x = 0; x < W; x++) dist[x] = Math.hypot(rs[x] - mr, gs[x] - mg, bs[x] - mb)
    // Ripples and glare make some rows busier than others: the threshold follows the row's own spread.
    const thr = Math.max(34, 3 * median(dist))
    for (let x = 0; x < W; x++) {
      let on = dist[x] > thr
      if (!on && refSig && dist[x] > 16) {
        // Not very different from the water, but in the colours the drone saw the item in.
        on = refSig.hist[hsvBin(rs[x], gs[x], bs[x])] > 0.12
      }
      if (on) mask[y * W + x] = 1
    }
  }
  // Blobs: 8-connected, by flood fill.
  const seen = new Uint8Array(W * img.height)
  const boxes = []
  const stack = []
  for (let y = y0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x
      if (!mask[k] || seen[k]) continue
      let x1 = x, x2 = x, yA = y, yB = y, area = 0
      seen[k] = 1
      stack.push(k)
      while (stack.length) {
        const c = stack.pop()
        const cx = c % W, cy = (c - cx) / W
        area++
        if (cx < x1) x1 = cx
        if (cx > x2) x2 = cx
        if (cy < yA) yA = cy
        if (cy > yB) yB = cy
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy
          if (ny < y0 || ny >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            if (nx < 0 || nx >= W) continue
            const n = ny * W + nx
            if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n) }
          }
        }
      }
      if (area < minArea || x2 - x1 + 1 > maxWidthFrac * W) continue
      boxes.push({ x1, y1: yA, x2: x2 + 1, y2: yB + 1, area })
    }
  }
  boxes.sort((a, b) => b.area - a.area)
  return mergeNear(boxes).slice(0, max)
}

/** Joins blobs that touch or nearly touch (one item split by a highlight or its label). */
function mergeNear(boxes) {
  const out = []
  for (const b of boxes) {
    const pad = 0.25 * Math.max(b.x2 - b.x1, b.y2 - b.y1)
    const hit = out.find((o) => b.x1 - pad <= o.x2 && b.x2 + pad >= o.x1 && b.y1 - pad <= o.y2 && b.y2 + pad >= o.y1)
    if (hit) {
      hit.x1 = Math.min(hit.x1, b.x1); hit.y1 = Math.min(hit.y1, b.y1)
      hit.x2 = Math.max(hit.x2, b.x2); hit.y2 = Math.max(hit.y2, b.y2)
      hit.area += b.area
    } else out.push({ ...b })
  }
  return out
}

/**
 * 0..1: do the two have the same colour PARTS? The overall colour match is
 * ruled by the main colour (a white bottle and a white bag share it); this
 * checks each colour that makes up a few % of either item — a bottle's blue
 * cap, a label, a print — is there in the other one too.
 */
function colourParts(a, b) {
  let worst = 1
  for (let k = 0; k < a.hist.length; k++) {
    const hi = Math.max(a.hist[k], b.hist[k])
    if (hi < 0.03) continue
    worst = Math.min(worst, Math.min(1, Math.min(a.hist[k], b.hist[k]) / (0.3 * hi)))
  }
  return worst               // one part missing is enough: a different item
}

/**
 * 0..1: how well a candidate looks like the drone's item. Image matching
 * only: the colour + shape signature, and its colour parts.
 */
export function imageMatch(refSig, candSig) {
  const look = similarity(refSig, candSig)
  if (look == null) return null
  const s = 0.6 * look + 0.4 * colourParts(refSig, candSig)
  return Math.round(Math.min(look + 0.15, s) * 1000) / 1000
}
