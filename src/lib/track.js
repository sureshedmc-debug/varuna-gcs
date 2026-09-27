// Lightweight IoU-matching box tracker. Detections for one scene now arrive
// from multiple asynchronous passes (a fast full-frame pass every tick, plus a
// rotating high-zoom tile pass for far-away objects) that don't all resolve on
// the same tick — without smoothing, boxes would jitter/flicker as sources
// update at different times. This blends new positions onto matched previous
// boxes (exponential smoothing) and gives a short grace period before dropping
// a box that momentarily didn't get re-detected, so on-screen boxes stay
// stable and track their object precisely instead of snapping every frame.

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  const w = Math.max(0, x2 - x1)
  const h = Math.max(0, y2 - y1)
  const inter = w * h
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (areaA + areaB - inter + 1e-6)
}

export class BoxTracker {
  constructor({ matchIou = 0.3, smoothing = 0.55, maxAgeMs = 700 } = {}) {
    this.matchIou = matchIou
    this.smoothing = smoothing // weight given to the NEW observation each update
    this.maxAgeMs = maxAgeMs
    this.tracks = [] // { id,x1,y1,x2,y2,score,label,color,firstSeen,lastSeen,hits,peak }
    this.seq = 0
    // Tracks dropped by the most recent update(). How long a box survived is
    // the self-learning loop's main evidence that it was real (see selfLearn.js),
    // and a track that has already been dropped can't be inspected — so the
    // last batch is kept here for one tick.
    this.retired = []
  }

  /** Feed a fresh detection list; returns the smoothed boxes to render. */
  update(boxes, now = performance.now()) {
    const used = new Array(this.tracks.length).fill(false)
    for (const b of boxes) {
      let best = -1
      let bestIou = this.matchIou
      for (let i = 0; i < this.tracks.length; i++) {
        if (used[i]) continue
        const v = iou(this.tracks[i], b)
        if (v > bestIou) {
          bestIou = v
          best = i
        }
      }
      if (best >= 0) {
        const t = this.tracks[best]
        const a = this.smoothing
        t.x1 = t.x1 * (1 - a) + b.x1 * a
        t.y1 = t.y1 * (1 - a) + b.y1 * a
        t.x2 = t.x2 * (1 - a) + b.x2 * a
        t.y2 = t.y2 * (1 - a) + b.y2 * a
        t.score = b.score
        t.label = b.label
        t.color = b.color
        t.cls = b.cls
        t.lastSeen = now
        t.hits++
        t.peak = Math.max(t.peak, b.score || 0)
        used[best] = true
      } else {
        this.tracks.push({ ...b, id: ++this.seq, firstSeen: now, lastSeen: now, hits: 1, peak: b.score || 0 })
      }
    }
    // Drop tracks that haven't been re-observed within the grace period.
    const keep = []
    this.retired = []
    for (const t of this.tracks) {
      if (now - t.lastSeen <= this.maxAgeMs) keep.push(t)
      else this.retired.push({ id: t.id, hits: t.hits, peak: t.peak, ageMs: t.lastSeen - t.firstSeen, cls: t.cls })
    }
    this.tracks = keep
    return this.tracks.map(({ id, x1, y1, x2, y2, score, label, color, cls, hits, peak, firstSeen }) => ({
      id, x1, y1, x2, y2, score, label, color, cls, hits, peak, ageMs: now - firstSeen,
    }))
  }

  reset() {
    this.tracks = []
    this.retired = []
  }
}
