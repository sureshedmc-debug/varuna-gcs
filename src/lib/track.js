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
    this.tracks = [] // { id,x1,y1,x2,y2,score,label,color,cls,feat,rl,lastSeen }
    this.nextId = 1
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
        t.feat = b.feat
        t.rl = b.rl
        t.lastSeen = now
        used[best] = true
      } else {
        this.tracks.push({ ...b, id: this.nextId++, lastSeen: now })
      }
    }
    // Drop tracks that haven't been re-observed within the grace period.
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= this.maxAgeMs)
    // `id` stays the same while the object stays in view (the operator's ✔/✖
    // is attached to it); `cls`, `feat` and `rl` carry the self-learning data.
    return this.tracks.map(({ id, x1, y1, x2, y2, score, label, color, cls, feat, rl }) => ({ id, x1, y1, x2, y2, score, label, color, cls, feat, rl }))
  }

  reset() {
    this.tracks = []
  }
}
