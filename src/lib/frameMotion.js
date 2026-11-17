// How far the whole picture moved between two detection passes.
//
// On a vibrating drone the camera shakes, so everything in its picture jumps
// a few % of the frame from one AI pass to the next. The box tracker matches
// each new detection to where the box WAS, so a shake that moves the picture
// more than about a box size breaks the track: the box drops out and comes
// back as a new one (blinks, loses its ✔ answer). Shifting the tracked boxes
// by the picture's own movement first keeps them on their items.
//
// Method: block matching on a small grey thumbnail (64 px wide). Every shift
// within ±maxShift thumbnail pixels is tried; the one where the two pictures
// differ least wins, refined to a fraction of a pixel. Brightness changes
// (auto exposure) are taken out by removing each picture's mean. A picture
// with nothing to lock on to (flat water, a blank sky) gives null: no shift
// rather than a wrong one.

export const MOTION_W = 64

/** Grey values (mean removed) of an RGBA image, as a Float32Array. */
export function greyOf(rgba, w, h) {
  const g = new Float32Array(w * h)
  let sum = 0
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const v = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]
    g[i] = v
    sum += v
  }
  const mean = sum / g.length
  for (let i = 0; i < g.length; i++) g[i] -= mean
  return g
}

/**
 * The shift {dx, dy} (thumbnail pixels) that moves `prev` onto `cur`
 * (cur(x, y) ≈ prev(x - dx, y - dy)), or null when the pictures have too
 * little detail to tell or don't match at any shift.
 */
export function estimateShift(prev, cur, w, h, maxShift = 10) {
  if (!prev || !cur || prev.length !== w * h || cur.length !== w * h) return null
  const m = maxShift
  if (w <= 2 * m + 4 || h <= 2 * m + 4) return null
  // Detail check: flat pictures can't be matched.
  let spread = 0
  for (let i = 0; i < cur.length; i++) spread += Math.abs(cur[i])
  spread /= cur.length
  if (spread < 4) return null

  const side = 2 * m + 1
  const cost = new Float32Array(side * side)
  let best = Infinity, bx = 0, by = 0, total = 0
  for (let dy = -m; dy <= m; dy++) {
    for (let dx = -m; dx <= m; dx++) {
      let s = 0
      for (let y = m; y < h - m; y += 1) {
        const rc = y * w, rp = (y - dy) * w - dx
        for (let x = m; x < w - m; x += 1) s += Math.abs(cur[rc + x] - prev[rp + x])
      }
      cost[(dy + m) * side + (dx + m)] = s
      total += s
      if (s < best) { best = s; bx = dx; by = dy }
    }
  }
  // A clear winner, or the shift is a guess (waves, flat water): no shift then.
  const mean = total / cost.length
  if (best > 0.75 * mean) return null
  // Sub-pixel: a parabola through the best cost and its neighbours.
  const at = (dx, dy) => cost[(dy + m) * side + (dx + m)]
  const refine = (a, b0, c) => {
    const d = a - 2 * b0 + c
    return d > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0
  }
  const fx = bx > -m && bx < m ? refine(at(bx - 1, by), best, at(bx + 1, by)) : 0
  const fy = by > -m && by < m ? refine(at(bx, by - 1), best, at(bx, by + 1)) : 0
  return { dx: bx + fx, dy: by + fy, quality: 1 - best / mean }
}
