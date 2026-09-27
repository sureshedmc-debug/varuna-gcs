// Self-supervised learning loop for the trash detector.
//
// The detector improves from its own footage with nobody labelling anything.
// That is possible because the app already produces three signals that
// disagree with each other in useful ways:
//
//   1. TEMPORAL CONSISTENCY. A real object stays put across frames while the
//      aircraft moves; a false positive flickers for a frame or two and dies.
//      A track that survives STABLE_HITS observations over STABLE_MS is
//      almost certainly real -> POSITIVE. One that dies inside FLICKER_MAX_MS
//      having barely been seen is almost certainly noise -> NEGATIVE.
//
//   2. CROSS-MODEL DISAGREEMENT. When the trash model fires on something the
//      person/face models call a human, one of them is wrong — and it isn't
//      the person model, which is a well-trained general detector. Every box
//      the human filter kills is a free HARD NEGATIVE, labelled by another
//      model instead of by an operator. This is the exact failure the
//      thresholds were papering over: clothes, skin and faces scoring as trash.
//
//   3. THE OPERATOR, OPTIONALLY. Marking a row wrong in the Detections tab
//      feeds the same pipeline with reason 'operator'. It is never required —
//      it just carries more weight than the automatic signals.
//
// Two things are done with those labels:
//
//   LIVE (this session, no retraining): every sample keeps a cheap visual
//   fingerprint (see embed.js). Incoming boxes are matched against the
//   negative memory and suppressed when they look like something already
//   known to be wrong. Reject a pile of clothes once and clothes stop being
//   trash immediately — no training step, no restart.
//
//   OFFLINE (weights actually change): the same labels accumulate as a real
//   YOLO dataset — clean, un-annotated frames plus box coordinates, with
//   negatives exported as background images. datasetExport.js packages it and
//   the retraining script produces a new trash.onnx.
//
// SAFETY VALVE: a self-training loop that trusts itself completely will
// amplify its own mistakes until it detects nothing. Two limits prevent that.
// The live filter never suppresses a box the detector is very confident about
// (REJECT_CONF_CEILING), so a bad negative can dim a weak class but can never
// blind the detector. And near-duplicate samples are dropped, so the dataset
// stays diverse instead of becoming ten thousand copies of one riverbank.

import { openDb, idbGetAll, idbPut, idbClear, idbCount, idbDeleteMany, idbEach } from './idb'
import { embedCrop, similarity, nearest, packEmbed, unpackEmbed } from './embed'
import { savePhotos, pinPhotos } from './photoStore'

const DB = openDb('varuna-learn', 1, [
  { name: 'samples', keyPath: 'id', indexes: [{ name: 'ts', keyPath: 'ts' }, { name: 'verdict', keyPath: 'verdict' }] },
])
const STORE = 'samples'

// --- what counts as evidence -------------------------------------------------
const STABLE_HITS = 8 // observations before a track is trusted as real
const STABLE_MS = 1200 // ...and it must have lived at least this long
const POSITIVE_CONF = 0.45 // peak detector score required for a positive
const FLICKER_MAX_HITS = 3 // died having been seen no more than this often...
const FLICKER_MAX_MS = 600 // ...and lived no longer than this -> noise

// --- how aggressively the live filter acts -----------------------------------
const REJECT_SIM = 0.9 // cosine similarity to a known negative
const REJECT_MARGIN = 0.04 // ...and this much more like a negative than a positive
const REJECT_CONF_CEILING = 0.6 // never suppress a detection this confident

// --- rate limits, so a long flight doesn't write a million rows --------------
const POSITIVE_EVERY_MS = 4000
const NEGATIVE_EVERY_MS = 1500
const DUPLICATE_SIM = 0.96 // this similar to an existing sample -> not worth keeping
const MEM_MAX = 500 // fingerprints held in RAM per class
const MAX_SAMPLES = 8000 // rows kept on disk; oldest untrained rows go first
const EMBED_REFRESH_MS = 300 // how often a live track's fingerprint is redone

const ENABLED_KEY = 'varuna.selfLearn'
const EVT = 'varuna:selfLearn'

// --- in-memory state ---------------------------------------------------------
const negatives = [] // Float32Array fingerprints, newest last
const positives = []
const counts = { positive: 0, negative: 0, operator: 0, suppressed: 0, trained: 0 }
let ready = false
let seq = 0
let enabled = readEnabled()

function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off'
  } catch {
    return true
  }
}

export function isSelfLearnEnabled() {
  return enabled
}
export function setSelfLearnEnabled(on) {
  enabled = !!on
  try {
    localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off')
  } catch {
    /* private mode */
  }
  emit()
}

function emit() {
  try {
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {
    /* no window */
  }
}

/** Load the fingerprint memory. Safe to call repeatedly. */
export async function loadMemory() {
  if (ready) return
  ready = true
  const all = await idbGetAll(DB, STORE)
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  for (const s of all) {
    seq = Math.max(seq, Number(String(s.id).split('-')[2]) || 0)
    if (s.verdict === 'positive') counts.positive++
    else counts.negative++
    if (s.reason === 'operator') counts.operator++
    if (s.trained) counts.trained++
    const v = unpackEmbed(s.embed)
    if (!v) continue
    const bag = s.verdict === 'positive' ? positives : negatives
    bag.push(v)
    if (bag.length > MEM_MAX) bag.shift()
  }
  emit()
}
loadMemory()

export function selfLearnStats() {
  return { ...counts, enabled, memory: negatives.length + positives.length }
}
export function onSelfLearnChange(fn) {
  window.addEventListener(EVT, fn)
  return () => window.removeEventListener(EVT, fn)
}

/**
 * Should this box be suppressed because it looks like a known false positive?
 * Called for every candidate box, so it must stay cheap: one dot product per
 * remembered fingerprint over a 114-dim vector.
 */
export function judgeBox(embedding, score) {
  if (!enabled || !embedding || !negatives.length) return false
  if (Number(score) >= REJECT_CONF_CEILING) return false // too confident to overrule
  const nSim = nearest(embedding, negatives)
  if (nSim < REJECT_SIM) return false
  const pSim = positives.length ? nearest(embedding, positives) : -1
  if (nSim < pSim + REJECT_MARGIN) return false // it also looks like known-good trash
  counts.suppressed++
  return true
}

// --- per-track bookkeeping ---------------------------------------------------
// One entry per live track: its best fingerprint so far and how long it has
// been seen. Kept here rather than on the tracker so the tracker stays a
// pure geometry helper.
const pending = new Map() // trackId -> { embed, box, peak, lastEmbedAt, contributed }
let lastPositiveAt = 0
let lastNegativeAt = 0

/**
 * Feed one detector frame. Everything here is best-effort and must never
 * throw into the detect loop.
 *
 * @param {object} f
 * @param {HTMLVideoElement|HTMLImageElement} f.source  the raw camera frame
 * @param {number} f.frameW, f.frameH                   source pixel size
 * @param {Array}  f.live        tracked trash boxes on screen (id, hits, ageMs, score)
 * @param {Array}  f.retired     tracks dropped since the last call
 * @param {Array}  f.suppressed  trash boxes the human filter killed this frame
 * @param {Function} f.captureClean  () => dataURL of the un-annotated frame
 * @param {object} f.geo         { lat, lng } at capture, for traceability
 */
export function observeFrame({ source, frameW, frameH, live, retired, suppressed, captureClean, geo }) {
  if (!enabled || !source || !frameW || !frameH) return
  const now = performance.now()

  try {
    // 1 — refresh fingerprints for live tracks, remembering each at its best score.
    for (const b of live || []) {
      let p = pending.get(b.id)
      if (!p) {
        p = { embed: null, box: null, peak: -1, lastEmbedAt: 0, contributed: false }
        pending.set(b.id, p)
      }
      const better = (b.score || 0) > p.peak
      if (better || now - p.lastEmbedAt > EMBED_REFRESH_MS) {
        const e = embedCrop(source, b, frameW, frameH)
        if (e && (better || !p.embed)) {
          p.embed = e
          p.box = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
          p.peak = Math.max(p.peak, b.score || 0)
        }
        p.lastEmbedAt = now
      }
    }

    // 2 — CROSS-MODEL NEGATIVES: boxes the person/face filter just killed.
    if ((suppressed || []).length && now - lastNegativeAt >= NEGATIVE_EVERY_MS) {
      const b = suppressed[0]
      const e = embedCrop(source, b, frameW, frameH)
      if (e && !isDuplicate(e, negatives)) {
        lastNegativeAt = now
        write({
          verdict: 'negative',
          reason: 'person-overlap',
          embed: e,
          boxes: [],
          score: b.score,
          frameW,
          frameH,
          captureClean,
          geo,
        })
      }
    }

    // 3 — FLICKER NEGATIVES: tracks that died young.
    for (const t of retired || []) {
      const p = pending.get(t.id)
      pending.delete(t.id)
      if (!p || p.contributed || !p.embed) continue
      const shortLived = (t.hits || 0) <= FLICKER_MAX_HITS && (t.ageMs || 0) <= FLICKER_MAX_MS
      if (!shortLived) continue
      if (now - lastNegativeAt < NEGATIVE_EVERY_MS) continue
      if (isDuplicate(p.embed, negatives)) continue
      lastNegativeAt = now
      write({
        verdict: 'negative',
        reason: 'flicker',
        embed: p.embed,
        boxes: [],
        score: p.peak,
        frameW,
        frameH,
        captureClean,
        geo,
      })
    }

    // 4 — POSITIVES: at least one track has proven itself and hasn't been
    // written yet. The sample carries EVERY stable box in the frame, not just
    // the new one — a label file that omits a visible object would teach the
    // model that object is background.
    const stable = (live || []).filter(
      (b) => (b.hits || 0) >= STABLE_HITS && (b.ageMs || 0) >= STABLE_MS && (b.score || 0) >= POSITIVE_CONF,
    )
    const fresh = stable.filter((b) => !pending.get(b.id)?.contributed)
    if (fresh.length && now - lastPositiveAt >= POSITIVE_EVERY_MS) {
      const lead = pending.get(fresh[0].id)
      if (lead?.embed && !isDuplicate(lead.embed, positives)) {
        lastPositiveAt = now
        for (const b of stable) {
          const p = pending.get(b.id)
          if (p) p.contributed = true
        }
        write({
          verdict: 'positive',
          reason: 'persisted',
          embed: lead.embed,
          boxes: stable.map((b) => normBox(b, frameW, frameH)),
          score: Math.max(...stable.map((b) => b.score || 0)),
          frameW,
          frameH,
          captureClean,
          geo,
        })
      }
    }

    // Forget bookkeeping for tracks that vanished without being retired.
    if (pending.size > 200) {
      const alive = new Set((live || []).map((b) => b.id))
      for (const id of pending.keys()) if (!alive.has(id)) pending.delete(id)
    }
  } catch {
    /* learning is never allowed to break detection */
  }
}

/** Reset per-flight state when detection stops. */
export function resetObservation() {
  pending.clear()
}

function normBox(b, w, h) {
  return {
    x1: clamp01(b.x1 / w),
    y1: clamp01(b.y1 / h),
    x2: clamp01(b.x2 / w),
    y2: clamp01(b.y2 / h),
  }
}
const clamp01 = (v) => Math.max(0, Math.min(1, v))

function isDuplicate(e, bag) {
  for (const u of bag) if (similarity(e, u) >= DUPLICATE_SIM) return true
  return false
}

/** Persist one sample, its fingerprint and the clean frame it came from. */
function write({ verdict, reason, embed, boxes, score, frameW, frameH, captureClean, geo }) {
  const id = `s-${Date.now()}-${++seq}`
  const bag = verdict === 'positive' ? positives : negatives
  bag.push(embed)
  if (bag.length > MEM_MAX) bag.shift()
  counts[verdict]++
  if (reason === 'operator') counts.operator++
  emit()

  // The clean, un-annotated frame is the training image. Captured lazily —
  // only when a sample is actually being written, never per frame.
  const clean = typeof captureClean === 'function' ? captureClean() : null

  const row = {
    id,
    ts: Date.now(),
    verdict,
    reason,
    embed: packEmbed(embed),
    boxes: boxes || [],
    score: Number.isFinite(score) ? Math.round(score * 1000) / 1000 : null,
    frameW,
    frameH,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    hasFrame: !!clean,
    trained: false,
  }
  idbPut(DB, STORE, row).then(async (ok) => {
    if (ok && clean) {
      await savePhotos(id, { clean })
      await pinPhotos(id) // training data is never pruned
    }
    pruneSamples()
  }).catch(() => {})
}

/**
 * Operator override from the Detections tab. Optional — the loop runs without
 * it — but a human verdict is the strongest signal available, so it is written
 * with reason 'operator' and the retraining script weights it accordingly.
 */
export async function recordOperatorVerdict({ verdict, sightingId, photo, boxes, frameW, frameH, geo }) {
  const id = `s-${Date.now()}-${++seq}`
  // Fingerprint the stored photo so the live filter learns from it too.
  let embed = null
  if (photo) {
    try {
      const img = await loadImage(photo)
      embed = embedCrop(img, { x1: 0, y1: 0, x2: img.width, y2: img.height }, img.width, img.height)
    } catch {
      embed = null
    }
  }
  if (embed) {
    const bag = verdict === 'positive' ? positives : negatives
    bag.push(embed)
    if (bag.length > MEM_MAX) bag.shift()
  }
  counts[verdict]++
  counts.operator++
  emit()
  await idbPut(DB, STORE, {
    id,
    ts: Date.now(),
    verdict,
    reason: 'operator',
    embed: packEmbed(embed),
    boxes: verdict === 'positive' ? boxes || [] : [],
    score: null,
    frameW: frameW || null,
    frameH: frameH || null,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    sightingId: sightingId || null,
    hasFrame: false,
    trained: false,
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

export function getSamples() {
  return idbGetAll(DB, STORE)
}
export function sampleCount() {
  return idbCount(DB, STORE)
}

/** Mark rows as having been trained on, so the next export is incremental. */
export async function markTrained(ids) {
  const all = await idbGetAll(DB, STORE)
  const set = new Set(ids)
  for (const s of all) {
    if (set.has(s.id) && !s.trained) {
      counts.trained++
      await idbPut(DB, STORE, { ...s, trained: true })
    }
  }
  emit()
}

export async function clearLearning() {
  negatives.length = 0
  positives.length = 0
  counts.positive = counts.negative = counts.operator = counts.suppressed = counts.trained = 0
  pending.clear()
  await idbClear(DB, STORE)
  emit()
}

/** Keep the sample store bounded: oldest not-yet-trained rows go first. */
async function pruneSamples() {
  const n = await idbCount(DB, STORE)
  if (n <= MAX_SAMPLES) return
  const rows = []
  await idbEach(DB, STORE, (r) => {
    rows.push({ id: r.id, ts: r.ts || 0, trained: !!r.trained })
  })
  // Trained rows have already done their job; drop those first, then oldest.
  rows.sort((a, b) => Number(b.trained) - Number(a.trained) || a.ts - b.ts)
  await idbDeleteMany(DB, STORE, rows.slice(0, n - MAX_SAMPLES).map((r) => r.id))
}
