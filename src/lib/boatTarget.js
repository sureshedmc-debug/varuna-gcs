// Is that really plastic, and how far away is it?
//
// The boat camera's AI (boatVision.js) hands every tracked box to this module.
// Nothing here draws or fetches: it decides, from the boxes alone, whether the
// boat may act — so it can be tested on its own (scripts/test-boat-target.mjs).
//
// Three jobs:
//
//  1. CLASS — only the model's plastic classes count. A class the model calls
//     "OTHERS" (or a person, a boat, an animal) never starts the motor, even
//     when the model is sure of it.
//  2. EVIDENCE — a box must be seen in `minHits` passes in a row (the tracker
//     gives each item an id that survives frame-to-frame movement), or once at
//     `sureScore`. One bad frame — a glint, a shadow, a wave — never counts.
//  3. DISTANCE — where the box meets the water is turned into metres ahead and
//     to the side, with the boat's own camera geometry (the same maths the boat
//     uses: boat-pi/camera_model.py). That distance drives the motor and, in
//     the collection zone, the scoop.
//
// Once an item passes all three it is LOCKED: the lock stays on that item while
// it is in view, and is not given up because another box briefly scores higher.
// A lock survives `lostMs` of not being seen (spray, glare, the item passing
// under the bow) and is then dropped.

/** Plastic by name, when the model's sidecar JSON doesn't say which classes to act on. */
const PLASTIC_RE = /plastic|bottle|\bbag\b|cup|container|styrofoam|thermocol|wrapper|polythene|polybag|trash|litter|waste|debris|rubbish|garbage/i
/** Never acted on, whatever the model calls it. */
const NOT_PLASTIC_RE = /other|unknown|misc|background|person|human|face|boat|vessel|ship|animal|bird|duck|fish|turtle|dog|cow|plant|weed|vegetation|algae|leaf|tree|wood|log|rock|stone|water|wave|foam|reflection|shadow/i

/**
 * Which of a model's classes may start the motor.
 * `meta.motorClassIds` (from the model's sidecar JSON) wins; otherwise the
 * names decide, and if that leaves nothing, every target class is allowed.
 */
export function plasticClassIds(meta) {
  const names = meta?.names || []
  const explicit = meta?.motorClassIds
  if (Array.isArray(explicit) && explicit.length) return new Set(explicit.map(Number))
  const ids = []
  names.forEach((n, i) => {
    const name = String(n || '')
    if (PLASTIC_RE.test(name) && !NOT_PLASTIC_RE.test(name)) ids.push(i)
  })
  if (ids.length) return new Set(ids)
  // A single-class model ("plastic", "waste", or a name we don't recognise):
  // its target classes are what it was trained to find.
  return new Set((meta?.targetIds || names.map((_, i) => i)).map(Number))
}

/** True if this box's class is one the boat may act on. */
export function isPlastic(box, ids, names) {
  const cls = Number(box?.cls)
  if (Number.isFinite(cls) && ids && ids.size) {
    if (!ids.has(cls)) return false
    // The tracker's class vote can name a box by a class the ids allow while
    // its own label says otherwise; the label is what the operator sees.
    const label = String(box.label ?? names?.[cls] ?? '')
    return !NOT_PLASTIC_RE.test(label)
  }
  const label = String(box?.label || '')
  return PLASTIC_RE.test(label) && !NOT_PLASTIC_RE.test(label)
}

/**
 * Where a camera pixel lands on the water.
 *
 * The lens sits `heightM` above the water, tilted `tiltDeg` below the horizon,
 * looking straight ahead. Pixels are square, so the vertical field of view
 * follows from the horizontal one. Returns metres { forward, right } from the
 * boat, or null for a pixel at or above the horizon (no water there).
 *
 * This is the JS twin of boat-pi/camera_model.py — keep the two in step.
 */
export function pixelToGround(x, y, w, h, cfg) {
  const hfov = Number(cfg?.camera_hfov_deg) || 66
  const tilt = ((Number(cfg?.camera_tilt_deg) || 15) * Math.PI) / 180
  const camH = Number(cfg?.camera_height_m) || 0.6
  if (!(w > 0) || !(h > 0)) return null
  const th = Math.tan((hfov * Math.PI) / 180 / 2)
  const tv = (th * h) / w
  const cx = (x / w - 0.5) * 2 * th
  const cy = (y / h - 0.5) * 2 * tv
  const c = Math.cos(tilt)
  const s = Math.sin(tilt)
  const forward = c - cy * s
  const down = s + cy * c
  if (down <= 1e-6) return null // at or above the horizon
  const k = camH / down
  return { forward: forward * k, right: cx * k }
}

/** Metres ahead / to the side of the bottom-centre of a box, and how far away it is. */
export function boxGround(box, w, h, cfg) {
  const x = (Number(box.x1) + Number(box.x2)) / 2
  const y = Number(box.y2) // where the item meets the water
  const g = pixelToGround(x, Math.min(y, h), w, h, cfg)
  if (!g || !Number.isFinite(g.forward) || g.forward <= 0) return null
  return {
    forward: g.forward,
    right: g.right,
    distance: Math.hypot(g.forward, g.right),
    bearing: (Math.atan2(g.right, g.forward) * 180) / Math.PI, // + = to starboard
  }
}

const DEFAULTS = {
  conf: 0.45, // a box must score this to count as evidence
  sureScore: 0.8, // …or this much, and one sighting is enough
  minHits: 2, // sightings in a row before an item may be acted on
  lostMs: 1200, // lock survives this long with the item out of sight
  maxM: 15, // farther away than this: the distance estimate is not worth acting on
  centreFrac: 0.35, // |right| / forward must be under this to be in the boat's path
  smooth: 0.45, // weight of each new distance reading
}

/**
 * Keeps one plastic item locked while the boat goes for it.
 *
 * update() is given the tracker's boxes for one pass and returns the lock as
 * the boat sees it. The lock only changes to another item when there is none —
 * never because a different box scored higher for a moment.
 */
export class PlasticLock {
  constructor(opts = {}) {
    this.set(opts)
    this.lock = null // { id, label, score, hits, distance, bearing, forward, right, firstSeen, lastSeen, closing }
    this.cooldownUntil = 0
  }

  set(opts = {}) {
    const o = { ...DEFAULTS, ...(opts || {}) }
    for (const k of Object.keys(DEFAULTS)) this[k] = Number(o[k])
    if (opts.ids) this.ids = opts.ids
    if (opts.names) this.names = opts.names
  }

  /** Collected, or the operator took over: forget this item and pause briefly. */
  clear(cooldownMs = 0, now = Date.now()) {
    this.lock = null
    this.cooldownUntil = cooldownMs > 0 ? now + cooldownMs : 0
  }

  /** A box the boat may act on: right class, sure enough, seen enough, on the water ahead. */
  candidate(b, w, h, cfg) {
    const score = Number(b.score) || 0
    if (!isPlastic(b, this.ids, this.names)) return null
    if (score < this.conf) return null
    const hits = Number(b.hits) || 0
    const seenEnough = hits >= this.minHits || score >= this.sureScore
    const g = boxGround(b, w, h, cfg)
    if (!g || g.distance > this.maxM) return null
    return { ...g, id: b.id, label: b.label, score, hits, seenEnough }
  }

  /**
   * One detection pass. `boxes` are tracked boxes (ids that survive frames).
   * Returns the lock, or null when there is nothing to act on.
   */
  update(boxes, w, h, cfg, now = Date.now()) {
    const cands = []
    for (const b of boxes || []) {
      const c = this.candidate(b, w, h, cfg)
      if (c) cands.push(c)
    }
    const held = this.lock
    if (held) {
      const same = cands.find((c) => c.id === held.id)
      if (same) {
        // Smooth the distance: single detections jitter, the boat should not.
        const d = held.distance + (same.distance - held.distance) * this.smooth
        const closing = d < held.distance - 0.05 ? true : d > held.distance + 0.05 ? false : held.closing
        this.lock = {
          ...held, ...same,
          distance: d,
          bearing: held.bearing + (same.bearing - held.bearing) * this.smooth,
          forward: held.forward + (same.forward - held.forward) * this.smooth,
          right: held.right + (same.right - held.right) * this.smooth,
          lastSeen: now,
          seen: (held.seen || 0) + 1,
          closing,
        }
        return this.view(now)
      }
      if (now - held.lastSeen <= this.lostMs) return this.view(now) // a few blind frames: keep going
      this.lock = null
    }
    if (now < this.cooldownUntil) return null
    // Nothing locked: take the surest, nearest item that has been seen enough.
    const ready = cands.filter((c) => c.seenEnough)
    if (!ready.length) return null
    const best = ready.reduce((a, b) => (pick(b) > pick(a) ? b : a))
    this.lock = { ...best, firstSeen: now, lastSeen: now, seen: 1, closing: null }
    return this.view(now)
  }

  /** The lock as the boat is told about it. */
  view(now = Date.now()) {
    const l = this.lock
    if (!l) return null
    const ageMs = now - l.lastSeen
    return {
      id: String(l.id),
      label: l.label || null,
      score: Math.round(l.score * 1000) / 1000,
      hits: l.hits,
      seen: l.seen,
      distance_m: Math.round(l.distance * 100) / 100,
      forward_m: Math.round(l.forward * 100) / 100,
      right_m: Math.round(l.right * 100) / 100,
      bearing_deg: Math.round(l.bearing * 10) / 10,
      centred: Math.abs(l.right) <= this.centreFrac * Math.max(0.5, l.forward),
      closing: l.closing,
      age_ms: Math.round(ageMs),
      visible: ageMs < 250,
      held_ms: Math.round(now - l.firstSeen),
      // The boat acts on this only when it is true: class, confidence and
      // evidence all passed, and the item is in sight now or was a moment ago.
      confirmed: ageMs <= this.lostMs,
    }
  }
}

/** Highest score first, then nearest — used only to choose a NEW lock. */
function pick(c) {
  return c.score - c.distance / 100
}
