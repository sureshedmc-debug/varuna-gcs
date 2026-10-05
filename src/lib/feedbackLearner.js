// Self-learning filter on top of the plastic detector — reinforcement learning
// from the operator's feedback (a contextual bandit).
//
// The detector (plastic.onnx) never changes. For every box it finds, this
// learner decides what to do with it:
//   show    — counted, logged and alerted on like before
//   explore — drawn dashed with a "?" so the operator can say whether it's
//             right; not counted (the learner isn't sure yet)
//   hide    — the learner is confident it's a false alarm
// The operator taps a box and answers ✔ plastic / ✖ not plastic. That answer
// is the reward, and the learner updates at once — no retraining, no internet.
//
// Model: Bayesian logistic regression with a diagonal Gaussian posterior
// (Chapelle & Li, "An Empirical Evaluation of Thompson Sampling", 2011). Each
// weight has a mean and a precision; uncertainty drives exploration (an upper
// confidence bound): a box the learner would hide, but might be wrong about,
// is shown as "explore" instead so feedback can correct it. The prior favours
// "show", so with no feedback the app behaves exactly like the bare detector.
//
// Inputs per box: its class, the detector's confidence, size, shape, position
// in the frame, and the colour statistics of the pixels inside it (bright,
// colourless blobs on water are usually glare, for example).
//
// State is per device (localStorage). Each answer is also saved with the
// frame it came from (IndexedDB), so the answers double as a labelled dataset
// for an occasional proper retrain — see exportFeedback().

import { openDb, idbPut, idbGetAll, idbGetAllKeys, idbDeleteMany, idbClear, idbCount } from './idb'

const STATE_KEY = 'varuna.rl.v1'
const ENABLED_KEY = 'varuna.rl.enabled'
const SHOW_FILTERED_KEY = 'varuna.rl.showFiltered'

const PRIOR_BIAS = 2.0 // sigmoid(2) ≈ 0.88: show everything until taught otherwise
const PRIOR_PRECISION = 1.0
const MAX_PRECISION = 5000 // keeps the learner able to change its mind later
const UCB_K = 1.0 // exploration width, in standard deviations
const RECENT = 50 // answers used for the "recent accuracy" read-out
const MAX_SAVED = 2000 // feedback examples kept on the device

const EXTRA_FEATURES = 8
export const featureDim = (nClasses) => 1 + nClasses + EXTRA_FEATURES

const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── Features ────────────────────────────────────────────────────────────────

let statCanvas = null
/** Colour statistics of the pixels inside box `b` of `source`, or null. */
export function cropStats(source, b) {
  try {
    if (!statCanvas) {
      statCanvas = document.createElement('canvas')
      statCanvas.width = 12
      statCanvas.height = 12
    }
    const w = Math.max(1, b.x2 - b.x1)
    const h = Math.max(1, b.y2 - b.y1)
    const ctx = statCanvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(source, b.x1, b.y1, w, h, 0, 0, 12, 12)
    const { data } = ctx.getImageData(0, 0, 12, 12)
    let sumL = 0
    let sumL2 = 0
    let sumS = 0
    const n = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255
      const g = data[i + 1] / 255
      const bl = data[i + 2] / 255
      const mx = Math.max(r, g, bl)
      const mn = Math.min(r, g, bl)
      const l = 0.299 * r + 0.587 * g + 0.114 * bl
      sumL += l
      sumL2 += l * l
      sumS += mx > 0 ? (mx - mn) / mx : 0
    }
    const bright = sumL / n
    return { bright, contrast: Math.sqrt(Math.max(0, sumL2 / n - bright * bright)), sat: sumS / n }
  } catch {
    return null // cross-origin frame or no canvas — colour features stay neutral
  }
}

/** Feature vector for one detection box. Every entry is roughly in -2..2. */
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

// ── Learner ─────────────────────────────────────────────────────────────────

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
  } catch {
    /* private mode / quota — learning still works for this session */
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

function freshState(signature, dim) {
  const m = new Array(dim).fill(0)
  m[0] = PRIOR_BIAS
  return { signature, m, q: new Array(dim).fill(PRIOR_PRECISION), n: 0, pos: 0, neg: 0, recent: [] }
}

/**
 * One learner per detection model. `names` are the model's class names; a
 * different model (different names) starts from scratch automatically, since
 * what was learned about the old one's classes doesn't apply.
 */
export function createLearner(names) {
  const nClasses = names.length
  const dim = featureDim(nClasses)
  const signature = `${names.join('|')}#${dim}`
  let st = readJson(STATE_KEY)
  if (!st || st.signature !== signature || st.m?.length !== dim || st.q?.length !== dim) {
    st = freshState(signature, dim)
  }
  const save = () => writeJson(STATE_KEY, st)

  function score(x) {
    let mean = 0
    let variance = 0
    for (let i = 0; i < dim; i++) {
      mean += st.m[i] * x[i]
      variance += (x[i] * x[i]) / st.q[i]
    }
    const sd = Math.sqrt(variance)
    // Probit approximation of the posterior predictive probability.
    const p = sigmoid(mean / Math.sqrt(1 + (Math.PI * variance) / 8))
    return { p, pUcb: sigmoid(mean + UCB_K * sd) }
  }

  return {
    names,
    nClasses,

    /** 'show' | 'explore' | 'hide' for a feature vector, with the probability. */
    decide(x) {
      const { p, pUcb } = score(x)
      const action = p >= 0.5 ? 'show' : pUcb >= 0.5 ? 'explore' : 'hide'
      return { action, p }
    },

    /** Learn from one answer: y = 1 (plastic, correct) or 0 (false alarm). */
    update(x, y) {
      const before = score(x).p
      // Find the posterior mode with a few diagonal Newton steps, then add the
      // new evidence to each weight's precision (Laplace approximation).
      const w = st.m.slice()
      for (let it = 0; it < 20; it++) {
        let z = 0
        for (let i = 0; i < dim; i++) z += w[i] * x[i]
        const p = sigmoid(z)
        let moved = 0
        for (let i = 0; i < dim; i++) {
          const grad = st.q[i] * (w[i] - st.m[i]) - (y - p) * x[i]
          const hess = st.q[i] + p * (1 - p) * x[i] * x[i]
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
        st.q[i] = Math.min(MAX_PRECISION, st.q[i] + p * (1 - p) * x[i] * x[i])
      }
      st.n++
      if (y) st.pos++
      else st.neg++
      // Was the learner right BEFORE seeing this answer? (honest accuracy)
      st.recent.push((before >= 0.5 ? 1 : 0) === y ? 1 : 0)
      if (st.recent.length > RECENT) st.recent.shift()
      save()
    },

    stats() {
      const r = st.recent
      return {
        answers: st.n,
        plastic: st.pos,
        notPlastic: st.neg,
        recentAccuracy: r.length >= 5 ? r.reduce((a, b) => a + b, 0) / r.length : null,
      }
    },

    reset() {
      st = freshState(signature, dim)
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
 * the camera frame, `box` is normalised {x1,y1,x2,y2} (0..1).
 */
export async function saveFeedback({ image, box, label, className, score }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  await idbPut(db(), 'answers', { id, t: Date.now(), image, box, label, className, score })
  const keys = (await idbGetAllKeys(db(), 'answers')).sort()
  if (keys.length > MAX_SAVED) await idbDeleteMany(db(), 'answers', keys.slice(0, keys.length - MAX_SAVED))
}

export const feedbackCount = () => idbCount(db(), 'answers')
export const clearFeedback = () => idbClear(db(), 'answers')

/**
 * Download every saved answer as one JSON file: each item has the frame
 * (JPEG data URL), the box (normalised x1,y1,x2,y2), the detector's class and
 * whether the operator said it IS plastic (label 1) or is NOT (label 0).
 * Label-1 items are positive training examples for their class; label-0
 * items are hard negatives (things that fooled the model).
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
