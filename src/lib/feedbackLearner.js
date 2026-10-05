// Self-learning filter on top of the plastic detector — the operator teaches
// it with ✔ plastic / ✖ not plastic, and it obeys.
//
// The detector (plastic.onnx) never changes. For every box it finds, this
// decides what to do with it:
//   show    — counted, logged and alerted on
//   explore — drawn dashed with a "?" so the operator can answer it; not counted
//   hide    — a false alarm
//
// Two layers, so an answer is followed immediately AND generalises:
//
// 1. RULES (memory of answers). Every answer stores an appearance fingerprint
//    of the object (colour histogram, edge directions, a tiny grey thumbnail).
//    A new box that closely matches a ✖ fingerprint is hidden, one that
//    matches a ✔ is shown — every time, even after the object leaves the view
//    and comes back. The operator's answers always win over the learner.
//
// 2. LEARNER (reinforcement learning, a contextual bandit) for everything the
//    rules don't cover. Bayesian logistic regression with a diagonal Gaussian
//    posterior (Chapelle & Li 2011) over: class, detector confidence, size,
//    shape, position, edge contact and colour statistics. When it isn't sure
//    it asks ("explore") instead of guessing, and it may only overrule the
//    detector after it has seen both ✔ and ✖ answers. The prior favours
//    "show", so with no answers the app behaves like the bare detector.
//
// Everything is per device (localStorage); answers are also saved with their
// frame (IndexedDB) and can be exported as a dataset for a proper retrain.

import { openDb, idbPut, idbGetAll, idbGetAllKeys, idbDeleteMany, idbClear, idbCount } from './idb'

const STATE_KEY = 'varuna.rl.v2'
const ENABLED_KEY = 'varuna.rl.enabled'
const SHOW_FILTERED_KEY = 'varuna.rl.showFiltered'

// Learner
const PRIOR_BIAS = 1.5 // sigmoid(1.5) ≈ 0.82: show everything until taught otherwise
const PRIOR_PRECISION = 0.3 // low = each answer moves the learner a lot
const ANSWER_WEIGHT = 3 // an operator's answer counts as this many observations
const MAX_PRECISION = 5000 // keeps the learner able to change its mind later
const RECENT = 50 // answers used for the "recent accuracy" read-out
const MIN_EACH = 3 // ✔ and ✖ answers each needed before the learner may overrule the detector
const HIDE_P = 0.2 // ...and it hides an unfamiliar box only when this sure it's a false alarm

// Rules (fingerprint memory). Similarity is 0..1; thresholds were set on TACO
// litter photos: the same object seen again (shifted / rescaled ±10%) scores
// above RULE_SIM almost always, different objects almost never.
export const RULE_SIM = 0.82 // at or above: the stored answer is applied
export const ASK_SIM = 0.74 // close to a ✖ but not certain: ask instead of counting
const RULE_MARGIN = 0.03 // the winning answer must beat the other side by this much
const MAX_RULES = 400

const MAX_SAVED = 2000 // feedback examples (with frames) kept on the device

const EXTRA_FEATURES = 8
export const featureDim = (nClasses) => 1 + nClasses + EXTRA_FEATURES

const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── Appearance: colour statistics + fingerprint of a box ────────────────────

const PATCH = 32 // the box is resampled to 32×32 for both

/**
 * Colour statistics and appearance fingerprint from a PATCH×PATCH RGBA pixel
 * array (pure function — no DOM — so it can be tested outside the browser).
 */
export function describePixels(data, n = PATCH) {
  const lum = new Float32Array(n * n)
  const color = new Float32Array(52) // 8 hues × 2 saturations × 3 values, + 4 greys
  let sumL = 0
  let sumL2 = 0
  let sumS = 0
  for (let p = 0, i = 0; p < n * n; p++, i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const s = mx > 0 ? (mx - mn) / mx : 0
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    lum[p] = l
    sumL += l
    sumL2 += l * l
    sumS += s
    if (s < 0.15) {
      color[48 + Math.min(3, Math.floor(mx * 4))] += 1
    } else {
      let h
      const d = mx - mn
      if (mx === r) h = ((g - b) / d + 6) % 6
      else if (mx === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      const hb = Math.min(7, Math.floor((h / 6) * 8))
      const sb = s < 0.5 ? 0 : 1
      const vb = Math.min(2, Math.floor(mx * 3))
      color[hb * 6 + sb * 3 + vb] += 1
    }
  }
  const area = n * n
  const bright = sumL / area
  const stats = { bright, contrast: Math.sqrt(Math.max(0, sumL2 / area - bright * bright)), sat: sumS / area }

  // Edge directions: 8 orientation bins in each quarter of the patch.
  const grad = new Float32Array(32)
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const gx = lum[y * n + x + 1] - lum[y * n + x - 1]
      const gy = lum[(y + 1) * n + x] - lum[(y - 1) * n + x]
      const mag = Math.hypot(gx, gy)
      if (mag < 1e-3) continue
      let ang = Math.atan2(gy, gx)
      if (ang < 0) ang += Math.PI // unsigned direction
      const ob = Math.min(7, Math.floor((ang / Math.PI) * 8))
      const cell = (y < n / 2 ? 0 : 2) + (x < n / 2 ? 0 : 1)
      grad[cell * 8 + ob] += mag
    }
  }

  // 8×8 grey thumbnail, mean-removed (layout of light and dark).
  const thumb = new Float32Array(64)
  const step = n / 8
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      let sum = 0
      for (let y = ty * step; y < (ty + 1) * step; y++) for (let x = tx * step; x < (tx + 1) * step; x++) sum += lum[y * n + x]
      thumb[ty * 8 + tx] = sum / (step * step)
    }
  }
  let tMean = 0
  for (const v of thumb) tMean += v
  tMean /= 64
  for (let i = 0; i < 64; i++) thumb[i] -= tMean

  return { stats, fp: { c: unit(hellinger(color)), g: unit(hellinger(grad)), t: unit(thumb) } }
}

function hellinger(v) {
  let s = 0
  for (const x of v) s += x
  const out = new Float32Array(v.length)
  if (s > 0) for (let i = 0; i < v.length; i++) out[i] = Math.sqrt(v[i] / s)
  return out
}
function unit(v) {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s)
  const out = new Float32Array(v.length)
  if (n > 1e-6) for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}
function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const isZero = (v) => !v.some((x) => x !== 0)

/** How alike two fingerprints are: 0 (nothing in common) .. 1 (identical). */
export function similarity(a, b) {
  const tz = isZero(a.t)
  const tb = isZero(b.t)
  const t = tz && tb ? 1 : tz || tb ? 0 : Math.max(0, dot(a.t, b.t)) // flat patches have no layout
  return 0.45 * Math.max(0, dot(a.c, b.c)) + 0.3 * Math.max(0, dot(a.g, b.g)) + 0.25 * t
}

let patchCanvas = null
/** Colour statistics + fingerprint of box `b` in `source`, or null (e.g. cross-origin frame). */
export function cropInfo(source, b) {
  try {
    if (!patchCanvas) {
      patchCanvas = document.createElement('canvas')
      patchCanvas.width = PATCH
      patchCanvas.height = PATCH
    }
    const ctx = patchCanvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(source, b.x1, b.y1, Math.max(1, b.x2 - b.x1), Math.max(1, b.y2 - b.y1), 0, 0, PATCH, PATCH)
    return describePixels(ctx.getImageData(0, 0, PATCH, PATCH).data)
  } catch {
    return null
  }
}

/** Learner input for one box. Every entry is roughly in -2..2. */
export function boxFeatures(b, frameW, frameH, nClasses, stats) {
  const x = new Float64Array(featureDim(nClasses))
  x[0] = 1 // bias
  if (Number.isInteger(b.cls) && b.cls >= 0 && b.cls < nClasses) x[1 + b.cls] = 1
  let k = 1 + nClasses
  const W = Math.max(1, frameW)
  const H = Math.max(1, frameH)
  const bw = Math.max(1, b.x2 - b.x1)
  const bh = Math.max(1, b.y2 - b.y1)
  const s = clamp(Number(b.score) || 0, 1e-4, 1 - 1e-4)
  x[k++] = Math.log(s / (1 - s)) / 3 // detector confidence (logit)
  x[k++] = Math.sqrt((bw * bh) / (W * H)) * 3 // size: 0 tiny .. 3 whole frame
  x[k++] = clamp(Math.log(bw / bh), -2, 2) / 2 // shape: wide (+) or tall (-)
  x[k++] = ((b.y1 + b.y2) / 2 / H - 0.5) * 2 // vertical position: -1 top .. 1 bottom
  x[k++] = b.x1 <= 2 || b.y1 <= 2 || b.x2 >= W - 2 || b.y2 >= H - 2 ? 1 : 0 // cut off by the frame edge
  if (stats) {
    x[k++] = (stats.bright - 0.5) * 2
    x[k++] = (stats.sat - 0.3) * 3
    x[k++] = (stats.contrast - 0.15) * 6
  }
  return x
}

// ── Persistence helpers ─────────────────────────────────────────────────────

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}
function writeJson(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
    return true
  } catch {
    return false // private mode / quota — learning still works for this session
  }
}
function readFlag(key, dflt) {
  try {
    const v = localStorage.getItem(key)
    return v == null ? dflt : v === '1'
  } catch {
    return dflt
  }
}
function writeFlag(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

const packFp = (fp) => ({ c: Array.from(fp.c, r3), g: Array.from(fp.g, r3), t: Array.from(fp.t, r3) })
const unpackFp = (o) => ({ c: Float32Array.from(o.c), g: Float32Array.from(o.g), t: Float32Array.from(o.t) })
const r3 = (v) => Math.round(v * 1000) / 1000

function freshState(signature, dim) {
  const m = new Array(dim).fill(0)
  m[0] = PRIOR_BIAS
  return { signature, m, q: new Array(dim).fill(PRIOR_PRECISION), n: 0, pos: 0, neg: 0, recent: [], rules: [] }
}

// ── The learner ─────────────────────────────────────────────────────────────

/**
 * One learner per detection model. `names` are the model's class names; a
 * model with different classes starts from scratch automatically, since what
 * was learned about the old one's classes doesn't apply.
 */
export function createLearner(names) {
  const nClasses = names.length
  const dim = featureDim(nClasses)
  const signature = `${names.join('|')}#${dim}`
  try {
    localStorage.removeItem('varuna.rl.v1') // first version: no fingerprints, can't be carried over
  } catch {
    /* ignore */
  }
  let st = readJson(STATE_KEY)
  const valid =
    st && st.signature === signature && st.m?.length === dim && st.q?.length === dim && Array.isArray(st.rules)
  if (!valid) st = freshState(signature, dim)
  let rules = valid ? st.rules.map((r) => ({ y: r.y, fp: unpackFp(r.fp) })) : []
  let undoSnapshot = null

  const save = () => {
    st.rules = rules.map((r) => ({ y: r.y, fp: packFp(r.fp) }))
    if (!writeJson(STATE_KEY, st) && rules.length > 50) {
      rules = rules.slice(-Math.floor(rules.length / 2)) // over quota: keep the newer half
      st.rules = rules.map((r) => ({ y: r.y, fp: packFp(r.fp) }))
      writeJson(STATE_KEY, st)
    }
  }

  function score(x) {
    let mean = 0
    let variance = 0
    for (let i = 0; i < dim; i++) {
      mean += st.m[i] * x[i]
      variance += (x[i] * x[i]) / st.q[i]
    }
    // Probit approximation of the posterior predictive probability: the less
    // certain the weights, the closer to 0.5 (so it asks rather than hides).
    return { p: sigmoid(mean / Math.sqrt(1 + (Math.PI * variance) / 8)) }
  }

  /** Best similarity to a ✔ answer and to a ✖ answer. */
  function nearest(fp) {
    let pos = 0
    let neg = 0
    if (!fp) return { pos, neg }
    for (const r of rules) {
      const s = similarity(fp, r.fp)
      if (r.y) {
        if (s > pos) pos = s
      } else if (s > neg) neg = s
    }
    return { pos, neg }
  }

  /**
   * What to do with one box. Returns { action, p, reason } where reason is
   * 'rule' (an answer matched), 'similar' (close to a ✖, asking) or 'learner'.
   */
  function decide(x, fp) {
    const { pos, neg } = nearest(fp)
    // 1. The operator's own answers, for this object or one that looks the same.
    if (neg >= RULE_SIM && neg >= pos + RULE_MARGIN) return { action: 'hide', p: 0, reason: 'rule' }
    if (pos >= RULE_SIM && pos >= neg + RULE_MARGIN) return { action: 'show', p: 1, reason: 'rule' }
    const { p } = score(x)
    // 2. Looks like something the operator rejected, though not the same: ask,
    //    or hide if the learner agrees it's a false alarm.
    // The learner only gets a say once it has been shown both kinds of answer:
    // after nothing but ✖ it would conclude "nothing is plastic" and hide items
    // the operator never rejected.
    const trained = st.pos >= MIN_EACH && st.neg >= MIN_EACH
    if (neg >= ASK_SIM && neg > pos) return { action: trained && p < 0.5 ? 'hide' : 'explore', p, reason: 'similar' }
    // 3. Unlike anything answered: the detector's call, unless the trained
    //    learner is clearly sure it's a false alarm.
    if (!trained) return { action: 'show', p, reason: 'learner' }
    if (p < HIDE_P) return { action: 'hide', p, reason: 'learner' }
    // Unsure, or leaning towards "false alarm" but not sure enough: ask.
    return { action: p >= 0.5 ? 'show' : 'explore', p, reason: 'learner' }
  }

  return {
    names,
    nClasses,
    decide,

    /** Learn from one answer: y = 1 (plastic) or 0 (not plastic). */
    update(x, y, fp) {
      undoSnapshot = { st: JSON.parse(JSON.stringify(st)), rules: rules.slice() }
      const before = decide(x, fp)
      // Learner: find the posterior mode with diagonal Newton steps, then add
      // the evidence to each weight's precision (Laplace approximation). The
      // answer is weighted so a few answers are enough to change behaviour.
      const w = st.m.slice()
      for (let it = 0; it < 25; it++) {
        let z = 0
        for (let i = 0; i < dim; i++) z += w[i] * x[i]
        const p = sigmoid(z)
        let moved = 0
        for (let i = 0; i < dim; i++) {
          const grad = st.q[i] * (w[i] - st.m[i]) - ANSWER_WEIGHT * (y - p) * x[i]
          const hess = st.q[i] + ANSWER_WEIGHT * p * (1 - p) * x[i] * x[i]
          const step = grad / hess
          w[i] -= step
          moved = Math.max(moved, Math.abs(step))
        }
        if (moved < 1e-6) break
      }
      let z = 0
      for (let i = 0; i < dim; i++) z += w[i] * x[i]
      const p = sigmoid(z)
      for (let i = 0; i < dim; i++) {
        st.m[i] = w[i]
        st.q[i] = Math.min(MAX_PRECISION, st.q[i] + ANSWER_WEIGHT * p * (1 - p) * x[i] * x[i])
      }
      // Rule: remember what this object looks like. A newer answer replaces an
      // older contradicting one for the same-looking thing.
      if (fp) {
        rules = rules.filter((r) => !(r.y !== y && similarity(fp, r.fp) >= RULE_SIM))
        rules.push({ y, fp })
        if (rules.length > MAX_RULES) rules = rules.slice(-MAX_RULES)
      }
      st.n++
      if (y) st.pos++
      else st.neg++
      // Was it already right BEFORE this answer? (honest accuracy)
      st.recent.push((before.action === 'show' ? 1 : 0) === y ? 1 : 0)
      if (st.recent.length > RECENT) st.recent.shift()
      save()
    },

    /** Take back the most recent answer (one level). */
    undo() {
      if (!undoSnapshot) return false
      st = undoSnapshot.st
      rules = undoSnapshot.rules
      undoSnapshot = null
      save()
      return true
    },
    canUndo: () => !!undoSnapshot,

    stats() {
      const r = st.recent
      return {
        answers: st.n,
        plastic: st.pos,
        notPlastic: st.neg,
        rules: rules.length,
        recentAccuracy: r.length >= 5 ? r.reduce((a, b) => a + b, 0) / r.length : null,
      }
    },

    reset() {
      st = freshState(signature, dim)
      rules = []
      undoSnapshot = null
      save()
    },
  }
}

export const learnerEnabled = () => readFlag(ENABLED_KEY, true)
export const setLearnerEnabled = (on) => writeFlag(ENABLED_KEY, on)
export const showFilteredEnabled = () => readFlag(SHOW_FILTERED_KEY, false)
export const setShowFilteredEnabled = (on) => writeFlag(SHOW_FILTERED_KEY, on)

// ── Saved answers (the dataset) ─────────────────────────────────────────────

const db = () => openDb('varuna-feedback', 1, [{ name: 'answers', keyPath: 'id' }])

/**
 * Keep one answer with the frame it came from. `image` is a JPEG data URL of
 * the camera frame, `box` is normalised {x1,y1,x2,y2} (0..1). Returns its id.
 */
export async function saveFeedback({ image, box, label, className, score }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  await idbPut(db(), 'answers', { id, t: Date.now(), image, box, label, className, score })
  const keys = (await idbGetAllKeys(db(), 'answers')).sort()
  if (keys.length > MAX_SAVED) await idbDeleteMany(db(), 'answers', keys.slice(0, keys.length - MAX_SAVED))
  return id
}
export const deleteFeedback = (id) => idbDeleteMany(db(), 'answers', [id])
export const feedbackCount = () => idbCount(db(), 'answers')
export const clearFeedback = () => idbClear(db(), 'answers')

/**
 * Download every saved answer as one JSON file: each item has the frame
 * (JPEG data URL), the box (normalised x1,y1,x2,y2), the detector's class and
 * whether the operator said it IS plastic (label 1) or is NOT (label 0).
 */
export async function exportFeedback(modelNames) {
  const items = (await idbGetAll(db(), 'answers')).sort((a, b) => a.t - b.t)
  const payload = {
    format: 'varuna-feedback-v1',
    exported: new Date().toISOString(),
    modelClasses: modelNames,
    count: items.length,
    items: items.map(({ t, image, box, label, className, score }) => ({
      time: new Date(t).toISOString(), label, className, score, box, image,
    })),
  }
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `varuna_feedback_${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return items.length
}
