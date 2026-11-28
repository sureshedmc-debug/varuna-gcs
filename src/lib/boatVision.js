// Boat vision engine — the boat camera's AI, running in this app.
//
// The boat's Pi (a Pi Zero) is far too slow for the AI models, so the app
// does the seeing and the boat does the deciding:
//
//   boat camera ──MJPEG (+ capture time)──▶ this engine
//     • plastic model on the water area      → targets for last-metre homing
//     • motion check on the ramp band        → catch counter (+ the plastic model names the item)
//   this engine ──/api/vision/observe (3×/s)──▶ boat: homing
//   this engine ──/api/catch/item─────────────▶ boat: catch log, bin count
//
// Drone-to-boat matching: while the boat homes onto a drone find (the observe
// reply names it), each plastic box is compared with the drone's crop of that
// find (targetMatch.js — colour + shape computer vision) and sent with its
// `match` score; the boat only steers onto a box that scores its
// match_threshold. The crop comes from this app's own store (droneTargets.js)
// or, failing that, from the copy the boat keeps.
//
// It runs whichever tab is open (homing needs it), and stops when the boat
// goes offline or the operator switches it off. If it stops while the boat is
// working, the boat notices and falls back (System → Boat vision: slow / hold
// / continue).
//
// In the simulator the drawn items and ducks can't be recognised by the real
// models, so the engine asks the simulator where they are instead (marked SIM
// DETECTIONS on screen). Everything else — stream, timestamps, the ramp
// motion check, posting to the boat — is the real code path.

import { boatApi, boatUrls } from '../api/boatClient'
import { readMjpeg } from './mjpegReader'
import { RampCounter, toGray } from './catchCounter'
import { SIG, matchScore, signature } from './targetMatch'
import { getDroneCrop } from './droneTargets'
import { BoxTracker } from './track'
import { MOTION_W, greyOf, estimateShift } from './frameMotion'
import { PlasticLock, plasticClassIds } from './boatTarget'
import { createLearner, boxFeatures, cropInfo, learnerEnabled } from './feedbackLearner'

// Detection passes per second. Each pass is tracked, judged and sent to the
// boat, so this is also how fast the boat learns that plastic is there: at 6
// the two sightings an item needs take about a third of a second. The AI runs
// in its own loop and never runs two passes at once, so a slower computer
// simply does fewer passes instead of falling behind.
const PLASTIC_HZ = 6
// The Live tab's extra layers (WebcamDetect.jsx), the same values:
//  * people: the face and person models; a plastic box on a face, or touching
//    a person at all, is dropped - the boat must never go for a person;
//  * self-learning: what the operator marked ✖ (not plastic) on the Live tab is
//    dropped here too ('hide'); a box that looks like one but isn't certain
//    ('explore') is shown but never moves the boat.
const HUMAN_EVERY_MS = 350
const FACE_CONF = 0.7
const PERSON_CONF = 0.7
const FACE_SUPPRESS_IOU = 0.2
const LEARNER_REFRESH_MS = 5000 // pick up new ✔/✖ answers given on the Live tab
// Long range (Boat tab switch, boat setting camera_long_range): far plastic is
// a few pixels at full-frame scale, too small for the model. Each pass then also
// runs the model on ONE zoomed-in piece of the far water (three overlapping
// pieces, in turn, like the Live tab's long-range scan), so a far item is seen
// two to three times bigger; each piece's boxes count for LR_TILE_TTL_MS.
const MATCH_GATES_LOCK = false // true: with a drone picture, only plastic that matches it may lock
const LR_TILES = 3
const LR_OVERLAP = 0.35
const LR_FAR_BAND = 0.6 // the far water: the top 60% of the picture (above the ramp)
const LR_TILE_TTL_MS = 1500
// Matching a box this small (pixels, shorter side) is guesswork: no score.
const MATCH_MIN_PX = 8
// Below this size a box's match is averaged over more passes (long range).
const MATCH_SMALL_PX = 24
const STALL_MS = 6000 // no frame for this long: drop the connection and reconnect
const GRID_W = 64
const GRID_H = 24

const listeners = new Set()
let state = initialState()
let run = null // the current run's private data
let matchTarget = null // { id, cls }: the drone find (with a picture) the Boat tab shows

/**
 * The Boat tab's drone picture to match the camera against when the boat isn't
 * homing: { id, cls } (the find's stored picture), or with `crop` (a JPEG data
 * URL) and `key` to match against exactly that picture - the live one.
 */
export function setMatchTarget(t) {
  matchTarget = t?.id
    ? { id: String(t.id), cls: t.cls || null, crop: t.crop || null, key: t.crop ? String(t.key ?? '') : null }
    : null
}

function initialState() {
  return {
    status: 'off', // off | connecting | loading | running | error
    message: '',
    sim: false,
    fps: 0,
    aiMs: null,
    frame: null, // { w, h, time, seq }
    targets: [],
    hazards: [],
    tracks: [],
    counted: 0,
    lastCatch: null,
    observed: 0,
    models: { plastic: 'off', wildlife: 'off' },
    matching: null, // { id, cls, hasRef } while the boat homes onto a drone find
    lock: null, // the verified plastic the boat is acting on (boatTarget.js)
  }
}

function set(patch) {
  state = { ...state, ...patch }
  for (const fn of listeners) fn(state)
}

export function subscribeVision(fn) {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

export function getVisionState() {
  return state
}

/** The newest decoded frame (ImageBitmap) for the Boat Vision tab to draw. */
export function getLatestFrame() {
  return run?.bitmap || null
}

/** Called whenever the boat's vision settings arrive or change. */
export function setVisionConfig(cfg) {
  if (!run || !cfg) return
  run.cfg = cfg
  run.counter.line = cfg.count_line ?? run.counter.line
  run.counter.setSensitivity(cfg.motion_sensitivity)
  applyLockConfig(run)
}

/**
 * How sure the boat must be, from its own settings (boat-pi/config.py, System
 * → Boat vision). The model's own recommended confidence is the floor, so a
 * model that needs a high threshold is never run below it.
 */
function applyLockConfig(r) {
  const cfg = r.cfg || {}
  const floor = Number(r.plastic?.meta?.recommendedConf) || 0
  r.lock.set({
    conf: Math.max(floor, Number(cfg.camera_plastic_conf) || 0.45),
    minHits: Math.max(1, Number(cfg.camera_plastic_hits) || 2),
    lostMs: Math.max(200, (Number(cfg.camera_lock_lost_s) || 1.2) * 1000),
    maxM: cfg.camera_long_range
      ? Math.max(Number(cfg.camera_target_max_m) || 15, Number(cfg.camera_long_range_max_m) || 30)
      : Number(cfg.camera_target_max_m) || 15,
  })
}

export function setVisionSim(sim) {
  if (run) run.sim = !!sim
  set({ sim: !!sim })
}

export function isVisionRunning() {
  return !!run
}

export function startBoatVision({ cfg, sim }) {
  if (run) return
  const r = {
    abort: new AbortController(),
    cfg: cfg || {},
    sim: !!sim,
    counter: new RampCounter({ cols: GRID_W, rows: GRID_H, line: cfg?.count_line ?? 0.55, sensitivity: cfg?.motion_sensitivity ?? 0.5 }),
    latest: null,
    wake: null,
    bitmap: null,
    latestMeta: null,
    stamps: [],
    lastPlastic: 0,
    lastUiPush: 0,
    aiBusy: false,
    aiWake: null,
    lastWildlife: 0,
    observing: false,
    queue: Promise.resolve(), // model calls run one at a time (one onnx session can't run twice at once)
    lastFrameAt: 0,
    hadHazard: false,
    plastic: null,
    wildlife: null,
    grid: document.createElement('canvas'),
    aiCanvas: document.createElement('canvas'),
    crop: document.createElement('canvas'),
    sig: document.createElement('canvas'), // SIG x SIG: candidate crops for the matcher
    homing: null, // { id, cls } from the boat's observe reply
    ref: null, // { id, sig } the drone's crop of that find
    // Same tracking the Live tab uses: boxes keep an id across frames, so an
    // item can be required to appear in several passes before the boat acts,
    // and keeps that id while the boat drives towards it.
    tracker: new BoxTracker({ matchIou: 0.3, smoothing: 0.5, maxAgeMs: 900, confirmHits: 2, instantScore: 0.8 }),
    lock: new PlasticLock(),
    lr: { next: 0, boxes: new Map() }, // long range: next piece, each piece's last boxes
    motion: { cv: document.createElement('canvas'), prev: null, w: 0, h: 0 },
  }
  r.sig.width = r.sig.height = SIG
  r.grid.width = GRID_W
  r.grid.height = GRID_H
  run = r
  set({ ...initialState(), status: 'connecting', message: 'Connecting to the boat camera…', sim: r.sim })
  streamLoop(r)
  processLoop(r)
  aiLoop(r)
  if (!r.sim) loadModels(r)
}

export function stopBoatVision() {
  const r = run
  if (!r) return
  run = null
  r.abort.abort()
  r.wake?.()
  r.aiWake?.()
  try {
    r.plastic?.dispose()
    r.wildlife?.dispose()
    r.person?.dispose()
    r.face?.dispose()
  } catch {
    /* already gone */
  }
  r.bitmap?.close?.()
  set({ ...initialState() })
}

async function loadModels(r) {
  // Plastic only: wildlife-safe mode was removed from the app (2026-11-16).
  set({ models: { plastic: 'loading', wildlife: 'off' } })
  const { createPlasticDetector } = await import('./detector')
  try {
    r.plastic = await createPlasticDetector()
    if (run !== r) return r.plastic.dispose()
    // Which of this model's classes may move the boat (a class it calls
    // "OTHERS" never does), and how sure it must be.
    r.lock.set({ ids: plasticClassIds(r.plastic.meta), names: r.plastic.meta?.names })
    applyLockConfig(r)
    r.det = await import('./detector')
    r.learner = createLearner(r.plastic.meta?.names || [])
    r.learnerAt = performance.now()
    loadPeopleModels(r) // in the background: plastic detection starts without waiting
    set({ models: { ...state.models, plastic: 'ready' } })
    r.aiWake?.()
    r.aiWake = null
  } catch (e) {
    set({ models: { ...state.models, plastic: 'error' }, message: `Plastic model failed: ${e?.message || e}` })
  }
}

/** The Live tab's face + person models (people are never plastic). Optional: without them, plastic still runs. */
async function loadPeopleModels(r) {
  try {
    const { createFaceDetector } = await import('./faceDetector')
    const fd = await createFaceDetector()
    if (run !== r) return fd.dispose()
    r.face = fd
  } catch (e) {
    console.warn('[boat vision] face model:', e?.message || e)
  }
  try {
    const { createPersonDetector } = await import('./personDetector')
    const pd = await createPersonDetector()
    if (run !== r) return pd.dispose()
    r.person = pd
  } catch (e) {
    console.warn('[boat vision] person model:', e?.message || e)
  }
}

/**
 * The Live tab's layers after the plastic model: drop boxes on people, then
 * let the self-learner (the operator's ✔/✖ answers) drop learned false alarms.
 * Each box left gets `rl`: 'show' (may move the boat) or 'explore' (unsure: shown only).
 */
async function liveLayers(r, src, raw, w, h) {
  const now = performance.now()
  if ((r.face || r.person) && now - (r.humanAt || 0) >= HUMAN_EVERY_MS) {
    r.humanAt = now
    if (r.face) {
      try { r.faces = await exclusive(r, () => r.face.detectFaces(src, { confThr: FACE_CONF, iouThr: 0.25 })) } catch { /* keep the last */ }
    }
    if (r.person) {
      try { r.persons = await exclusive(r, () => r.person.detectPersons(src, { confThr: PERSON_CONF, iouThr: 0.3, frame: {} })) } catch { /* keep the last */ }
    }
    if (run !== r) return []
  }
  if (r.det && r.faces?.length) raw = raw.filter((t) => !r.faces.some((f) => r.det.overlapRatio(f, t) > FACE_SUPPRESS_IOU))
  // A box that IS a person (their body, their shirt) is dropped. Plastic that
  // only touches one (a bottle in a hand, an item next to a swimmer) stays
  // visible but unsure ('explore'): shown with a "?", never locked, so the
  // boat never drives at a person. Dropping it outright hid every bottle
  // someone held up to the camera.
  const touchesPerson = (b) => (r.persons || []).some((p) => r.det.overlapRatio(b, p) > 0)
  if (r.det && r.persons?.length) raw = r.det.suppressPersonBody(raw, r.persons)
  const rlOf = (b, action) => (touchesPerson(b) ? 'explore' : action)
  if (!raw.length || !r.learner || !learnerEnabled()) return raw.map((b) => ({ ...b, rl: rlOf(b, 'show') }))
  if (now - r.learnerAt > LEARNER_REFRESH_MS) {
    r.learner = createLearner(r.plastic?.meta?.names || [])
    r.learnerAt = now
  }
  const lrn = r.learner
  const out = []
  for (const b of raw) {
    let d = { action: 'show' }
    try {
      const ci = cropInfo(src, b)
      d = lrn.decide(boxFeatures(b, w, h, lrn.nClasses, ci?.stats), ci?.fp || null)
    } catch { /* no picture of it: the detector's call */ }
    if (d.action === 'hide') continue // a learned false alarm
    out.push({ ...b, rl: rlOf(b, d.action), why: touchesPerson(b) ? 'next to a person' : d.reason })
  }
  return out
}

async function streamLoop(r) {
  while (run === r) {
    // One connection attempt. A half-open connection (Tailscale dropped without a
    // reset) never delivers another byte, so a watchdog aborts it when frames stop.
    const attempt = new AbortController()
    const stopAll = () => attempt.abort()
    r.abort.signal.addEventListener('abort', stopAll)
    r.lastFrameAt = performance.now()
    const dog = setInterval(() => {
      if (performance.now() - r.lastFrameAt > STALL_MS) attempt.abort()
    }, 1000)
    try {
      await readMjpeg(boatUrls.video(), (f) => {
        r.latest = f
        const now = performance.now()
        r.lastFrameAt = now
        r.stamps.push(now)
        while (r.stamps.length && now - r.stamps[0] > 3000) r.stamps.shift()
        r.wake?.()
      }, { signal: attempt.signal })
    } catch (e) {
      if (run !== r) return
      set({ status: 'error', message: attempt.signal.aborted ? 'Camera stream stalled — reconnecting…' : `Camera stream: ${e?.message || e}` })
    } finally {
      clearInterval(dog)
      r.abort.signal.removeEventListener('abort', stopAll)
    }
    if (run !== r) return
    await new Promise((res) => setTimeout(res, 2000)) // stream ended or failed: retry
  }
}

/** Run a model call after any call already in progress (shared onnx sessions). */
function exclusive(r, fn) {
  const p = r.queue.then(() => fn())
  r.queue = p.catch(() => {})
  return p
}

function nextFrame(r) {
  if (r.latest) return Promise.resolve()
  return new Promise((res) => { r.wake = res })
}

async function processLoop(r) {
  while (run === r) {
    await nextFrame(r)
    if (run !== r) return
    const f = r.latest
    r.latest = null
    r.wake = null
    if (!f || f.frameTime == null) continue
    let bmp
    try {
      bmp = await createImageBitmap(new Blob([f.jpeg], { type: 'image/jpeg' }))
    } catch {
      continue // a damaged frame: skip it
    }
    if (run !== r) return bmp.close()
    const old = r.bitmap
    r.bitmap = bmp
    old?.close?.()
    const w = bmp.width, h = bmp.height
    const now = performance.now()
    r.latestMeta = { w, h, frameTime: f.frameTime, seq: f.seq }

    // 1. Catch counter: motion on the ramp band, every frame (fast, synchronous crop).
    const rampY = (r.cfg.ramp_top ?? 0.78) * h
    const g = r.grid.getContext('2d', { willReadFrequently: true })
    g.drawImage(bmp, 0, rampY, w, h - rampY, 0, 0, GRID_W, GRID_H)
    const crossings = r.counter.step(toGray(g.getImageData(0, 0, GRID_W, GRID_H)), now)
    for (const c of crossings) countItem(r, bmp, f, c, w, h, rampY)

    // 2. Wake the independent AI loop without ever stalling frame decode/display.
    if (!r.aiBusy && now - r.lastPlastic >= 1000 / PLASTIC_HZ && (r.sim || r.plastic)) {
      r.aiWake?.()
      r.aiWake = null
    }

    // 3. Throttle React state pushes (4 Hz after the first frame) so 30-60 fps video
    //    doesn't trigger 60 full React re-renders/s; canvases read getLatestFrame() directly.
    const ready = r.sim || (state.models.plastic === 'ready')
    const wantStatus = ready ? 'running' : 'loading'
    if (!state.frame || state.status !== wantStatus || now - r.lastUiPush >= 250) {
      r.lastUiPush = now
      const fps = r.stamps.length > 1 ? Math.round(((r.stamps.length - 1) * 1000) / Math.max(1000, r.stamps[r.stamps.length - 1] - r.stamps[0])) : 0
      set({
        status: wantStatus,
        message: ready ? '' : state.message || 'Loading the AI models…',
        fps,
        tracks: trackView(r),
        frame: { w, h, time: f.frameTime, seq: f.seq },
      })
    }
  }
}

async function aiLoop(r) {
  while (run === r) {
    if (!r.bitmap || (!r.sim && !r.plastic) || performance.now() - r.lastPlastic < 1000 / PLASTIC_HZ) {
      await new Promise((res) => { r.aiWake = res })
      continue
    }
    r.aiBusy = true
    try {
      const bmp = r.bitmap
      const meta = r.latestMeta
      if (!bmp || !meta) continue
      const { w, h, frameTime } = meta
      // Snapshot bmp synchronously onto r.aiCanvas so processLoop can swap/close r.bitmap freely.
      if (r.aiCanvas.width !== w || r.aiCanvas.height !== h) {
        r.aiCanvas.width = w
        r.aiCanvas.height = h
      }
      r.aiCanvas.getContext('2d').drawImage(bmp, 0, 0)
      await runAiPass(r, r.aiCanvas, frameTime, w, h)
    } catch (e) {
      if (run === r) set({ message: `Vision: ${e?.message || e}` })
    } finally {
      r.aiBusy = false
    }
  }
}

async function runAiPass(r, srcCanvas, frameTime, w, h) {
  const cfg = r.cfg
  const rampY = (cfg.ramp_top ?? 0.78) * h
  r.lastPlastic = performance.now()
  let targets = state.targets, hazards = state.hazards
  let tracked = null // the tracker's boxes (ids + how often each was seen)
  const t0 = performance.now()
  let raw = null
  if (r.sim) {
    const det = await boatApi.simDetections(frameTime)
    if (run !== r) return
    if (!det || det._httpError) return
    r.simRamp = det.ramp || []
    raw = (det.targets || []).map((b) => ({ ...b, sim: true }))
    hazards = []
  } else {
    if (!r.plastic) return
    // The whole picture, the scoop's mouth at the bottom included: the item the
    // boat is going for is followed right into the scoop, so the boat can tell
    // it is TRAPPED there before the scoop closes (boat_extras.py). A box down
    // there may only CONTINUE that lock, never start one (see below).
    const whole = { x1: 0, y1: 0, x2: 1, y2: 1 }
    const conf = Math.max(0.2, r.plastic.meta?.recommendedConf || 0.25)
    raw = await exclusive(r, () => r.plastic.detect(srcCanvas, { confThr: conf, iouThr: 0.45, rect: whole }))
    if (run !== r) return
    // Zoomed pieces always run: a bottle that is small in the whole picture is
    // missed at full-frame scale but found in a 2x zoom (long range: far water).
    raw = await longRangeBoxes(r, srcCanvas, raw, conf, cfg)
    if (run !== r) return
    raw = await liveLayers(r, srcCanvas, raw, w, h)
    if (run !== r) return
    hazards = []
  }
  // The same tracking the Live tab uses, for the real camera and the simulator
  // alike: the picture's own movement is measured first (the boat rolls, the
  // camera shakes) and the boxes are carried with it, so an item keeps its id
  // and the evidence for it from pass to pass instead of looking like a new one
  // each time. Only a box that survives this can move the boat.
  // A box over a big part of the picture is the model calling the whole scene
  // (a wall, the sky, glare on the water) plastic, not an item: a real piece in
  // front of the boat is small in the frame. It is dropped before tracking, so
  // it can never be matched, lock, run the motor or fire the scoop.
  // A box bigger than an item on the water usually is (a bottle held close to
  // the camera) is still shown, but unsure: it can't lock, so it can't move the
  // boat. Only a box covering most of the picture is dropped as the scene.
  const maxFrac = Math.min(0.9, Math.max(0.05, Number(cfg.camera_max_box_frac) || 0.25))
  raw = raw.filter((b) => !wholeScene(b, w, h)).map((b) => (plausibleBox(b, w, h, maxFrac) ? b : { ...b, rl: 'explore' }))
  followShake(r, srcCanvas, w, h)
  tracked = r.tracker.update(raw, performance.now())
  // Down in the ramp / scoop band only the item already locked is kept: a box
  // there that was never chased across the water (a part of the boat, a splash)
  // is not shown, matched or locked.
  const heldId = r.lock.lock ? String(r.lock.lock.id) : null
  tracked = tracked.filter((b) => (b.y1 + b.y2) / 2 < rampY || (heldId != null && String(b.id) === heldId))
  targets = tracked.map((b) => ({
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, score: b.score, label: b.label, id: b.id,
    ...(b.rl === 'explore' ? { unsure: true } : {}),
    ...(r.sim ? { sim: true } : {}),
  }))
  // 2b. Homing onto a drone find: how well does each box match the drone's crop?
  const homing = r.homing || matchTarget
  if (homing && targets.length) {
    const ref = await referenceFor(r, homing)
    if (run !== r) return
    const prev = r.prevMatch?.id === homing.id ? r.prevMatch.boxes : []
    // Boxes from 30% up are compared, so a clear bottle the AI is only 35-45%
    // sure of still shows its match. The lock (boatTarget.js) still needs the
    // boat's own camera_plastic_conf before anything moves.
    const matchConf = Math.max(0.3, Number(r.plastic?.meta?.recommendedConf) || 0)
    targets = targets.map((b) => {
      if (!(Number(b.score) >= matchConf)) return b
      const side = Math.min(b.x2 - b.x1, b.y2 - b.y1)
      if (side < MATCH_MIN_PX) return b // too few pixels to compare (still far): matched when closer
      const sig = ref?.sig ? signature(cropSig(r, srcCanvas, b, w, h)) : null
      const m = matchScore(ref?.sig || null, homing.cls, sig, b.label, Number(b.score))
      const p = prev.find((q) => Number.isFinite(q.match) && iou(q, b) > 0.3)
      // A small (far) box's picture is noisy: its score follows more passes.
      const k = side < MATCH_SMALL_PX ? 0.3 : 0.55
      const sm = p ? k * m.score + (1 - k) * p.match : m.score
      return { ...b, match: Math.round(sm * 1000) / 1000, matchParts: m.parts }
    })
    r.prevMatch = { id: homing.id, boxes: targets }
  }
  // 2c. Is one of these really plastic, and how far ahead is it? Only a box of
  // a plastic class, sure enough and seen in enough passes running, becomes the
  // LOCK — the one item the boat drives at and scoops. It keeps that lock while
  // the item is in view (and for a moment after), so a brief glint on another
  // box never makes the boat change its mind. The boat checks all of this again
  // before it moves anything (boat-pi/boat_extras.py, CameraCollect).
  // With a drone picture to match against (the Boat tab's "Drone saw this", or
  // the find the boat is homing onto), only plastic that MATCHES it may lock:
  // a "not a match" box - or one not compared yet (too small, too unsure) -
  // never runs the motor, the buzzer or the scoop. With no drone picture, any
  // plastic the camera confirms counts.
  // An unsure box (the self-learner is asking about it) never moves the boat.
  let lockable = tracked ? tracked.filter((b) => b.rl !== 'explore') : tracked
  // Matching is skipped: any plastic the camera confirms runs the motor. The
  // match scores are still worked out and shown on the Boat tab.
  if (MATCH_GATES_LOCK && homing && lockable) {
    const thr = Math.min(0.95, Math.max(0.2, Number(cfg.match_threshold) || 0.55))
    const ok = new Set(targets.filter((b) => Number.isFinite(b.match) && b.match >= thr).map((b) => b.id))
    lockable = lockable.filter((b) => ok.has(b.id))
  }
  const lock = lockable ? r.lock.update(lockable, w, h, cfg) : null
  const aiMs = Math.round(performance.now() - t0)
  set({ targets, hazards, lock, tracks: trackView(r), aiMs: aiMs > 2 ? aiMs : state.aiMs })

  // 3. Tell the boat what this pass saw.
  if (r.observing) return
  const inZone = hazards.some((x) => x.in_zone)
  const body = {
    frame_time: frameTime, frame_w: w, frame_h: h,
    targets: targets.map(({ x1, y1, x2, y2, score, label, match }) => ({ x1, y1, x2, y2, score, label, ...(match != null && r.homing ? { match } : {}) })),
    matcher: 'app-cv', // this app compares the boxes with the drone's crop (the boat waits for its scores)
    // The verified plastic (null = nothing the boat may act on). The boat's
    // motor and scoop follow THIS, never the raw boxes above.
    plastic: lock,
    ...(r.homing ? { match_for: r.homing.id } : {}),
    hazards: hazards.map(({ x1, y1, x2, y2, score, label, in_zone }) => ({ x1, y1, x2, y2, score, label, in_zone })),
  }
  if (inZone && !r.hadHazard) body.hazard_photo = snapshot(r, srcCanvas, 0, 0, w, h, 480)
  r.hadHazard = inZone
  r.observing = true
  boatApi.observe(body)
    .then((res) => {
      if (run !== r || !res || res._httpError) return
      // The reply names the drone find the boat is homing onto (if any): match against it from the next pass.
      const id = res.homing_id || null
      r.homing = id ? { id, cls: res.homing_class || null } : null
      set({
        observed: state.observed + 1,
        matching: id ? { id, cls: res.homing_class || null, hasRef: !!(r.ref?.id === id && r.ref.sig) } : null,
      })
    })
    .catch(() => {})
    .finally(() => { r.observing = false })
}

/**
 * The whole picture moved (the boat rolled, the camera shook): move every
 * tracked box with it, so this pass's detections match the items they belong
 * to instead of starting new tracks. Same measurement the Live tab uses.
 */
function followShake(r, src, sw, sh) {
  const mv = r.motion
  const w = MOTION_W
  const h = Math.max(8, Math.round((MOTION_W * sh) / Math.max(1, sw)))
  if (mv.cv.width !== w || mv.cv.height !== h) {
    mv.cv.width = w
    mv.cv.height = h
    mv.prev = null
  }
  let g
  try {
    const x = mv.cv.getContext('2d', { willReadFrequently: true })
    x.drawImage(src, 0, 0, w, h)
    g = greyOf(x.getImageData(0, 0, w, h).data, w, h)
  } catch {
    mv.prev = null
    return
  }
  const s = mv.prev && mv.w === w && mv.h === h ? estimateShift(mv.prev, g, w, h, 10) : null
  mv.prev = g
  mv.w = w
  mv.h = h
  if (!s || (Math.abs(s.dx) < 0.3 && Math.abs(s.dy) < 0.3)) return
  r.tracker.shift(s.dx * (sw / w), s.dy * (sh / h))
}

/**
 * Long range: run the model on the next piece of the far water and merge every
 * piece's recent boxes with the full-frame ones (overlaps become one box).
 */
async function longRangeBoxes(r, srcCanvas, full, conf, cfg) {
  // Long range: the far water in LR_TILES pieces. Otherwise: the whole picture in 2x2 pieces.
  const far = cfg.camera_long_range ? Math.min(LR_FAR_BAND, cfg.ramp_top ?? 0.78) : 'all'
  if (!r.lr.tiles || r.lr.far !== far) {
    const { makeTileGrid } = await import('./detector')
    r.lr.tiles = far === 'all'
      ? makeTileGrid(2, 2, LR_OVERLAP)
      : makeTileGrid(LR_TILES, 1, LR_OVERLAP).map((t) => ({ x1: t.x1, x2: t.x2, y1: 0, y2: far }))
    r.lr.far = far
    r.lr.next = 0
    r.lr.boxes.clear()
  }
  const idx = r.lr.next % r.lr.tiles.length
  r.lr.next = idx + 1
  try {
    // A zoomed piece guesses a little more: its boxes must still pass the lock's
    // confidence before the boat acts, so the floor here only finds candidates.
    const boxes = await exclusive(r, () => r.plastic.detect(srcCanvas, { confThr: Math.max(0.2, conf * 0.85), iouThr: 0.4, rect: r.lr.tiles[idx] }))
    r.lr.boxes.set(idx, { boxes, t: performance.now() })
  } catch {
    /* one piece missed: the others still count */
  }
  const now = performance.now()
  const recent = [...r.lr.boxes.values()].filter((e) => now - e.t <= LR_TILE_TTL_MS).map((e) => e.boxes)
  if (!recent.length) return full
  const { mergeBoxes } = await import('./detector')
  return mergeBoxes([full, ...recent], 0.4)
}

/** True for a box over most of the picture: the model calling the whole scene plastic. */
export function wholeScene(b, w, h) {
  const bw = (b.x2 - b.x1) / Math.max(1, w), bh = (b.y2 - b.y1) / Math.max(1, h)
  return bw * bh > 0.6 || (bw > 0.85 && bh > 0.85)
}

/** False for a box too big to be one item on the water: over `maxFrac` of the frame, or over 70% of its width or height. */
export function plausibleBox(b, w, h, maxFrac = 0.25) {
  const bw = (b.x2 - b.x1) / Math.max(1, w), bh = (b.y2 - b.y1) / Math.max(1, h)
  return bw > 0 && bh > 0 && bw * bh <= maxFrac && bw <= 0.7 && bh <= 0.7
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const i = ix * iy
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i
  return u > 0 ? i / u : 0
}

/**
 * The drone's crop of a find, as a matcher signature: the given live picture
 * (`h.crop`), else the find's stored one. Cached per picture; no picture yet
 * (still arriving) → try again every 3 s.
 */
async function referenceFor(r, h) {
  const id = h.id
  const key = h.crop ? `${id}#${h.key}` : id
  if (r.ref?.key === key && (r.ref.sig || Date.now() - r.ref.t < 3000)) return r.ref
  r.ref = { id, key, sig: null, t: Date.now() }
  let url = h.crop || await getDroneCrop(id)
  if (!url) {
    try {
      const res = await fetch(boatUrls.liveReference(id), { cache: 'no-store' })
      if (res.ok) url = URL.createObjectURL(await res.blob())
    } catch {
      /* the boat has none either */
    }
  }
  if (!url) return r.ref
  try {
    const img = await createImageBitmap(await (await fetch(url)).blob())
    const aspect = img.width / Math.max(1, img.height) // the crop's true shape, before it is squeezed to SIG x SIG
    const cv = document.createElement('canvas')
    cv.width = cv.height = SIG
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, SIG, SIG)
    img.close?.()
    if (r.ref?.key === key) r.ref.sig = signature(ctx.getImageData(0, 0, SIG, SIG), { aspect })
  } catch {
    /* a damaged image: class + score only */
  } finally {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
  return r.ref
}

/** A box of the frame with some water around it, scaled to SIG x SIG, as ImageData. */
function cropSig(r, bmp, b, w, h) {
  const bw = b.x2 - b.x1, bh = b.y2 - b.y1
  const x1 = Math.max(0, b.x1 - 0.35 * bw), y1 = Math.max(0, b.y1 - 0.35 * bh)
  const x2 = Math.min(w, b.x2 + 0.35 * bw), y2 = Math.min(h, b.y2 + 0.35 * bh)
  if (x2 - x1 < 3 || y2 - y1 < 3) return null
  const ctx = r.sig.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, x1, y1, x2 - x1, y2 - y1, 0, 0, SIG, SIG)
  const data = ctx.getImageData(0, 0, SIG, SIG)
  data.aspect = (x2 - x1) / (y2 - y1) // the true shape (a bottle is long and thin), before the squeeze
  return data
}

function trackView(r) {
  return r.counter.tracks.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, counted: t.counted }))
}

/** JPEG data URL of a region of the frame, at most `maxW` wide. */
function snapshot(r, bmp, x, y, w, h, maxW) {
  const k = Math.min(1, maxW / Math.max(1, w))
  const cv = r.crop
  cv.width = Math.max(1, Math.round(w * k))
  cv.height = Math.max(1, Math.round(h * k))
  cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, cv.width, cv.height)
  return cv.toDataURL('image/jpeg', 0.72)
}

async function countItem(r, bmp, f, c, w, h, rampY) {
  // Crop around the moving blob (band coordinates → frame pixels), with a margin.
  // Everything taken from the frame happens now, synchronously: by the time the
  // model runs, a newer frame may have replaced (and closed) this one.
  const bandH = h - rampY
  const pad = 0.08
  const x1 = Math.max(0, (c.x - pad) * w), y1 = Math.max(0, rampY + (c.y - pad) * bandH)
  const x2 = Math.min(w, (c.x + c.w + pad) * w), y2 = Math.min(h, rampY + (c.y + c.h + pad) * bandH)
  const photo = snapshot(r, bmp, x1, y1, x2 - x1, y2 - y1, 240)
  let label = 'item', score = null
  let ctxCanvas = null
  if (!r.sim && r.plastic) {
    // A slightly larger crop gives the model some context.
    const cx1 = Math.max(0, x1 - 0.05 * w), cy1 = Math.max(0, y1 - 0.1 * h)
    const cw = Math.min(w, x2 + 0.05 * w) - cx1, ch = h - cy1
    ctxCanvas = document.createElement('canvas')
    ctxCanvas.width = Math.max(1, Math.round(cw))
    ctxCanvas.height = Math.max(1, Math.round(ch))
    ctxCanvas.getContext('2d').drawImage(bmp, cx1, cy1, cw, ch, 0, 0, ctxCanvas.width, ctxCanvas.height)
  }
  try {
    if (r.sim) {
      const hit = (r.simRamp || [])[0]
      if (hit) label = hit.label
    } else if (ctxCanvas) {
      const found = await exclusive(r, () => r.plastic.detect(ctxCanvas, { confThr: 0.15, iouThr: 0.45 }))
      if (found.length) {
        const best = found.reduce((a, b) => (b.score > a.score ? b : a))
        label = best.label
        score = best.score
      }
    }
  } catch {
    /* keep 'item' */
  }
  if (run !== r) return
  const res = await boatApi.catchItem({ label, score, frame_time: f.frameTime, photo }).catch(() => null)
  if (run === r && res && res.success !== false && !res._httpError) {
    set({ counted: state.counted + 1, lastCatch: { label, t: Date.now(), photo } })
  }
}
