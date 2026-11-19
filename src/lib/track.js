// Lightweight box tracker. Detections for one scene arrive from several
// asynchronous passes (a fast full-frame pass every tick, plus a rotating
// high-zoom tile pass for far-away objects) that don't all resolve on the same
// tick, and the camera moves. Without tracking, boxes jitter, flicker and blink
// in for a single frame. This:
//  - matches each detection to the box it continues (overlap, or for a small
//    item that moved more than its own size, a nearby centre of the same kind),
//  - smooths position adaptively: steady boxes are held still (jitter averaged
//    out), boxes that really move follow at once (no lag behind the object),
//  - shows a new box only once it is seen twice, or once if the model is sure
//    (one-frame false alarms never appear), and
//  - keeps a box a short grace period after a missed detection, so on-screen
//    boxes stay put instead of blinking.

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

function sameKind(a, b) {
  // Two guesses from the same multi-class model may disagree on bottle vs bag
  // for one item: that is for the class vote to settle, not a different item.
  if (a.naming && a.naming === b.naming) return true
  return (a.cls ?? null) === (b.cls ?? null) && (a.label ?? null) === (b.label ?? null)
}

const VOTE_KEEP = 0.85   // each new frame's class evidence counts this much more than the last one's

/** Adds a detection's class scores to the track's running vote; sets its class from the vote. */
function vote(t, b) {
  const p = b.probs
  if (!p || !b.naming) {
    t.label = b.label
    t.color = b.color
    t.cls = b.cls
    t.classConf = null
    return
  }
  if (!t.vote || t.vote.length !== p.length) t.vote = new Float32Array(p.length)
  let best = 0
  let sum = 0
  for (let c = 0; c < p.length; c++) {
    t.vote[c] = t.vote[c] * VOTE_KEEP + p[c]
    if (t.vote[c] > t.vote[best]) best = c
    sum += t.vote[c]
  }
  const { names, colors } = b.naming
  t.naming = b.naming
  t.cls = best
  t.label = names[best] ?? `Class ${best}`
  t.color = colors[best % colors.length]
  t.classConf = sum > 0 ? t.vote[best] / sum : null
}

/** How well detection b continues track t: > 1 by overlap, 0..1 by nearness, 0 = not it. */
function matchScore(t, b, matchIou) {
  const v = iou(t, b)
  if (v >= matchIou) return 1 + v
  if (!sameKind(t, b)) return 0
  const size = Math.max(t.x2 - t.x1, t.y2 - t.y1, b.x2 - b.x1, b.y2 - b.y1)
  const d = Math.hypot((t.x1 + t.x2 - b.x1 - b.x2) / 2, (t.y1 + t.y2 - b.y1 - b.y2) / 2)
  const reach = 1.6 * size
  return d < reach ? 1 - d / reach : 0
}

export class BoxTracker {
  constructor({ matchIou = 0.3, smoothing = 0.55, maxAgeMs = 700, confirmHits = 2, instantScore = 0.7 } = {}) {
    this.matchIou = matchIou
    this.smoothing = smoothing // weight given to the NEW observation of a box that holds still
    this.maxAgeMs = maxAgeMs
    this.confirmHits = confirmHits
    this.instantScore = instantScore
    this.tracks = [] // { id,x1,y1,x2,y2,score,label,color,cls,feat,fp,rl,why,lastSeen,hits,shown }
    this.nextId = 1
    this.lastUpdate = null
    this.dt = 0 // average time between updates (ms)
  }

  /** Feed a fresh detection list; returns the smoothed, confirmed boxes to render. */
  update(boxes, now = performance.now()) {
    // The grace periods are in time, but a box can only be seen again on the
    // next update: when detection runs slowly (a busy computer, the drone
    // feed at a few fps) they stretch to cover a missed pass or two, or a new
    // box would be dropped before its second sighting and never shown.
    if (this.lastUpdate != null) {
      const gap = Math.min(5000, Math.max(0, now - this.lastUpdate))
      this.dt = this.dt ? 0.7 * this.dt + 0.3 * gap : gap
    }
    this.lastUpdate = now
    const used = new Array(this.tracks.length).fill(false)
    // Surest detections pick their track first.
    const order = [...boxes].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    for (const b of order) {
      let best = -1
      let bestScore = 0
      for (let i = 0; i < this.tracks.length; i++) {
        if (used[i]) continue
        const s = matchScore(this.tracks[i], b, this.matchIou)
        if (s > bestScore) {
          bestScore = s
          best = i
        }
      }
      if (best >= 0) {
        const t = this.tracks[best]
        // Movement relative to the box's size: jitter is a few %, real motion more.
        const size = Math.max(1e-6, Math.max(t.x2 - t.x1, t.y2 - t.y1))
        const moved = Math.hypot((t.x1 + t.x2 - b.x1 - b.x2) / 2, (t.y1 + t.y2 - b.y1 - b.y2) / 2) / size
        const a = Math.min(0.9, this.smoothing + Math.max(0, moved - 0.05) * 1.5)
        t.x1 = t.x1 * (1 - a) + b.x1 * a
        t.y1 = t.y1 * (1 - a) + b.y1 * a
        t.x2 = t.x2 * (1 - a) + b.x2 * a
        t.y2 = t.y2 * (1 - a) + b.y2 * a
        t.score = t.score * 0.4 + (Number(b.score) || 0) * 0.6
        vote(t, b)
        t.feat = b.feat
        t.fp = b.fp
        t.rl = b.rl
        t.why = b.why
        t.lastSeen = now
        t.hits += 1
        used[best] = true
      } else {
        const t = { ...b, score: Number(b.score) || 0, id: this.nextId++, lastSeen: now, hits: 1, shown: false, vote: null }
        vote(t, b)
        this.tracks.push(t)
        used.push(true)
      }
    }
    // Drop tracks that haven't been re-observed within the grace period; a box
    // never confirmed goes as soon as it is missed.
    const keepShown = Math.max(this.maxAgeMs, 2.5 * this.dt)
    const keepNew = Math.max(this.maxAgeMs / 2, 2.2 * this.dt)
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= (t.shown ? keepShown : keepNew))
    for (const t of this.tracks) {
      if (!t.shown && (t.hits >= this.confirmHits || t.score >= this.instantScore)) t.shown = true
    }
    // `id` stays the same while the object stays in view (the operator's ✔/✖
    // is attached to it); `cls`, `feat` and `rl` carry the self-learning data.
    return this.tracks
      .filter((t) => t.shown)
      .map(({ id, x1, y1, x2, y2, score, label, color, cls, classConf, feat, fp, rl, why, hits }) => ({ id, x1, y1, x2, y2, score, label, color, cls, classConf, feat, fp, rl, why, hits }))
  }

  /**
   * The whole picture moved by (dx, dy) pixels since the last update (the
   * camera shook): move every track with it, so the next detections match
   * the items they belong to (frameMotion.js measures the movement).
   */
  shift(dx, dy) {
    if (!dx && !dy) return
    for (const t of this.tracks) {
      t.x1 += dx
      t.x2 += dx
      t.y1 += dy
      t.y2 += dy
    }
  }

  reset() {
    this.tracks = []
    this.lastUpdate = null
    this.dt = 0
  }
}
