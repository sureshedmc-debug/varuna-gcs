// Catch counter for the boat's intake ramp.
//
// The bottom band of the boat camera's picture shows the ramp. A cheap motion
// check runs on a tiny grey copy of that band every frame: a slowly updated
// background picture is subtracted, changed cells are grouped into blobs, and
// blobs are followed from frame to frame. A blob that crosses the counting
// line moving down the picture (from the water toward the bin) is one item.
// Splashes and glare that flicker without crossing, or float back out, never
// count. The AI only names the item afterwards (bottle, bag, …), on a crop.

export class RampCounter {
  /**
   * @param {object} o
   * @param {number} o.cols, o.rows   size of the grey grid the band is shrunk to
   * @param {number} o.line           counting line, 0..1 down the band
   * @param {number} o.sensitivity    0..1 (higher = smaller changes count)
   */
  constructor({ cols = 64, rows = 24, line = 0.55, sensitivity = 0.5 } = {}) {
    this.cols = cols
    this.rows = rows
    this.line = line
    this.setSensitivity(sensitivity)
    this.bg = null
    this.tracks = []
    this.nextId = 1
    this.frames = 0
  }

  setSensitivity(s) {
    const v = Math.max(0.05, Math.min(1, Number(s) || 0.5))
    this.threshold = 14 + (1 - v) * 46 // grey levels (0..255) a cell must change by
    this.minCells = v > 0.7 ? 2 : 3
  }

  /**
   * One frame of the band as grey levels (cols × rows, row-major).
   * Returns the crossings: [{ id, x, y, w, h }] in 0..1 band coordinates.
   */
  step(gray, now = performance.now()) {
    const { cols, rows } = this
    const n = cols * rows
    this.frames++
    if (!this.bg || this.bg.length !== n) {
      this.bg = Float32Array.from(gray)
      return []
    }
    // Foreground mask, and a slow background update (fast where nothing moves).
    const mask = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const d = Math.abs(gray[i] - this.bg[i])
      if (d > this.threshold) mask[i] = 1
      this.bg[i] += (gray[i] - this.bg[i]) * (mask[i] ? 0.02 : 0.15)
    }
    const blobs = this._blobs(mask)
    return this._track(blobs, now)
  }

  _blobs(mask) {
    const { cols, rows } = this
    const seen = new Uint8Array(mask.length)
    const out = []
    const stack = []
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || seen[i]) continue
      let cells = 0, sx = 0, sy = 0, x1 = cols, y1 = rows, x2 = 0, y2 = 0
      stack.push(i)
      seen[i] = 1
      while (stack.length) {
        const k = stack.pop()
        const x = k % cols, y = (k / cols) | 0
        cells++; sx += x; sy += y
        if (x < x1) x1 = x
        if (y < y1) y1 = y
        if (x > x2) x2 = x
        if (y > y2) y2 = y
        const nb = [k - 1, k + 1, k - cols, k + cols]
        for (const j of nb) {
          if (j < 0 || j >= mask.length || seen[j] || !mask[j]) continue
          if ((j === k - 1 && x === 0) || (j === k + 1 && x === cols - 1)) continue
          seen[j] = 1
          stack.push(j)
        }
      }
      if (cells >= this.minCells) {
        out.push({ cx: (sx / cells + 0.5) / cols, cy: (sy / cells + 0.5) / rows,
                   x: x1 / cols, y: y1 / rows, w: (x2 - x1 + 1) / cols, h: (y2 - y1 + 1) / rows, cells })
      }
    }
    return out
  }

  _track(blobs, now) {
    const crossings = []
    const used = new Set()
    for (const t of this.tracks) {
      let best = null, bestD = 0.25
      blobs.forEach((b, i) => {
        if (used.has(i)) return
        const d = Math.hypot(b.cx - t.cx, b.cy - t.cy)
        if (d < bestD) { bestD = d; best = i }
      })
      if (best === null) { t.missed++; continue }
      used.add(best)
      const b = blobs[best]
      const wasAbove = t.cy < this.line
      Object.assign(t, b, { missed: 0, seen: now })
      if (wasAbove && b.cy >= this.line && !t.counted && t.age >= 1) {
        t.counted = true
        crossings.push({ id: t.id, x: b.x, y: b.y, w: b.w, h: b.h })
      }
      t.age++
    }
    blobs.forEach((b, i) => {
      if (!used.has(i)) this.tracks.push({ ...b, id: this.nextId++, missed: 0, age: 0, counted: false, seen: now })
    })
    this.tracks = this.tracks.filter((t) => t.missed <= 4)
    return crossings
  }
}

/** Grey levels of a canvas region, already drawn at cols × rows. */
export function toGray(imageData) {
  const { data, width, height } = imageData
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8
  return out
}
