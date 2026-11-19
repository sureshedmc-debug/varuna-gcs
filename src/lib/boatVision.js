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

// Detection passes per second. Each pass is tracked, judged and sent to the
// boat, so this is also how fast the boat learns that plastic is there: at 6
// the two sightings an item needs take about a third of a second. The AI runs
// in its own loop and never runs two passes at once, so a slower computer
// simply does fewer passes instead of falling behind.
const PLASTIC_HZ = 6
const STALL_MS = 6000 // no frame for this long: drop the connection and reconnect
const GRID_W = 64
const GRID_H = 24

const listeners = new Set()
let state = initialState()
let run = null // the current run's private data
let matchTarget = null // { id, cls }: the drone find (with a picture) the Boat tab shows

/** The Boat tab's drone find to match the camera against when the boat isn't homing. */
export function setMatchTarget(t) {
  matchTarget = t?.id ? { id: String(t.id), cls: t.cls || null } : null
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
    maxM: Number(cfg.camera_target_max_m) || 15,
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
    set({ models: { ...state.models, plastic: 'ready' } })
    r.aiWake?.()
    r.aiWake = null
  } catch (e) {
    set({ models: { ...state.models, plastic: 'error' }, message: `Plastic model failed: ${e?.message || e}` })
  }
}

async function streamLoop(r) {
  while (run === r) {
    // One connection attempt. A half-open connection (NetBird dropped without a
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
    const water = { x1: 0, y1: 0, x2: 1, y2: Math.min(1, (cfg.ramp_top ?? 0.78) + 0.02) }
    const conf = Math.max(0.2, r.plastic.meta?.recommendedConf || 0.25)
    raw = (await exclusive(r, () => r.plastic.detect(srcCanvas, { confThr: conf, iouThr: 0.45, rect: water })))
      .filter((b) => (b.y1 + b.y2) / 2 < rampY)
    if (run !== r) return
    hazards = []
  }
  // The same tracking the Live tab uses, for the real camera and the simulator
  // alike: the picture's own movement is measured first (the boat rolls, the
  // camera shakes) and the boxes are carried with it, so an item keeps its id
  // and the evidence for it from pass to pass instead of looking like a new one
  // each time. Only a box that survives this can move the boat.
  followShake(r, srcCanvas, w, h)
  tracked = r.tracker.update(raw, performance.now())
  targets = tracked.map((b) => ({
    x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, score: b.score, label: b.label, id: b.id,
    ...(r.sim ? { sim: true } : {}),
  }))
  // 2b. Homing onto a drone find: how well does each box match the drone's crop?
  const homing = r.homing || matchTarget
  if (homing && targets.length) {
    const ref = await referenceFor(r, homing.id)
    if (run !== r) return
    const prev = r.prevMatch?.id === homing.id ? r.prevMatch.boxes : []
    targets = targets.map((b) => {
      const sig = ref?.sig ? signature(cropSig(r, srcCanvas, b, w, h)) : null
      const m = matchScore(ref?.sig || null, homing.cls, sig, b.label, Number(b.score))
      const p = prev.find((q) => iou(q, b) > 0.3)
      const sm = p ? 0.55 * m.score + 0.45 * p.match : m.score
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
  const lock = tracked ? r.lock.update(tracked, w, h, cfg) : null
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

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const i = ix * iy
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i
  return u > 0 ? i / u : 0
}

/** The drone's crop of a find, as a matcher signature (cached per find). */
async function referenceFor(r, id) {
  // Cached per find; no picture yet (still arriving) → try again every 3 s.
  if (r.ref?.id === id && (r.ref.sig || Date.now() - r.ref.t < 3000)) return r.ref
  r.ref = { id, sig: null, t: Date.now() }
  let url = await getDroneCrop(id)
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
    const cv = document.createElement('canvas')
    cv.width = cv.height = SIG
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, SIG, SIG)
    img.close?.()
    if (r.ref?.id === id) r.ref.sig = signature(ctx.getImageData(0, 0, SIG, SIG))
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
  return ctx.getImageData(0, 0, SIG, SIG)
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
