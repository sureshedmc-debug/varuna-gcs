// Boat vision engine — the boat camera's AI, running in this app.
//
// The boat's Pi (a Pi Zero) is far too slow for the AI models, so the app
// does the seeing and the boat does the deciding:
//
//   boat camera ──MJPEG (+ capture time)──▶ this engine
//     • plastic model on the water area      → targets for last-metre homing
//     • COCO model on the water area         → animals for wildlife-safe mode
//     • motion check on the ramp band        → catch counter (+ the plastic model names the item)
//   this engine ──/api/vision/observe (3×/s)──▶ boat: homing, wildlife holds
//   this engine ──/api/catch/item─────────────▶ boat: catch log, bin count
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
import { inDangerZone } from './boatCamera'

const PLASTIC_HZ = 3 // detection passes per second; each pass is sent to the boat
const WILDLIFE_HZ = 2
const STALL_MS = 6000 // no frame for this long: drop the connection and reconnect
const GRID_W = 64
const GRID_H = 24

const listeners = new Set()
let state = initialState()
let run = null // the current run's private data

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
    stamps: [],
    lastPlastic: 0,
    lastWildlife: 0,
    observing: false,
    queue: Promise.resolve(), // model calls run one at a time (one onnx session can't run twice at once)
    lastFrameAt: 0,
    hadHazard: false,
    plastic: null,
    wildlife: null,
    grid: document.createElement('canvas'),
    crop: document.createElement('canvas'),
  }
  r.grid.width = GRID_W
  r.grid.height = GRID_H
  run = r
  set({ ...initialState(), status: 'connecting', message: 'Connecting to the boat camera…', sim: r.sim })
  streamLoop(r)
  processLoop(r)
  if (!r.sim) loadModels(r)
}

export function stopBoatVision() {
  const r = run
  if (!r) return
  run = null
  r.abort.abort()
  r.wake?.()
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
  set({ models: { plastic: 'loading', wildlife: 'loading' } })
  const [{ createPlasticDetector }, { createWildlifeDetector }] = await Promise.all([
    import('./detector'),
    import('./wildlifeDetector'),
  ])
  try {
    r.plastic = await createPlasticDetector()
    if (run !== r) return r.plastic.dispose()
    set({ models: { ...state.models, plastic: 'ready' } })
  } catch (e) {
    set({ models: { ...state.models, plastic: 'error' }, message: `Plastic model failed: ${e?.message || e}` })
  }
  try {
    r.wildlife = await createWildlifeDetector()
    if (run !== r) return r.wildlife.dispose()
    set({ models: { ...state.models, wildlife: 'ready' } })
  } catch (e) {
    set({ models: { ...state.models, wildlife: 'error' }, message: `Animal model failed: ${e?.message || e}` })
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
    const fps = r.stamps.length > 1 ? Math.round(((r.stamps.length - 1) * 1000) / Math.max(1000, r.stamps[r.stamps.length - 1] - r.stamps[0])) : 0
    try {
      await analyse(r, bmp, f, w, h)
    } catch (e) {
      if (run === r) set({ message: `Vision: ${e?.message || e}` })
    }
    if (run !== r) return
    const ready = r.sim || (state.models.plastic === 'ready' && state.models.wildlife === 'ready')
    set({
      status: ready ? 'running' : 'loading',
      message: ready ? '' : state.message || 'Loading the AI models…',
      fps,
      frame: { w, h, time: f.frameTime, seq: f.seq },
    })
  }
}

async function analyse(r, bmp, f, w, h) {
  const cfg = r.cfg
  const rampY = (cfg.ramp_top ?? 0.78) * h
  const now = performance.now()

  // 1. Catch counter: motion on the ramp band, every frame (cheap).
  const g = r.grid.getContext('2d', { willReadFrequently: true })
  g.drawImage(bmp, 0, rampY, w, h - rampY, 0, 0, GRID_W, GRID_H)
  const crossings = r.counter.step(toGray(g.getImageData(0, 0, GRID_W, GRID_H)), now)
  for (const c of crossings) countItem(r, bmp, f, c, w, h, rampY)

  // 2. Plastic + animals on the water, a few times a second. Each pass is sent
  //    to the boat stamped with THIS frame's capture time, so the boat matches
  //    the boxes to where it was when the frame was taken.
  if (now - r.lastPlastic < 1000 / PLASTIC_HZ) {
    set({ tracks: trackView(r) })
    return
  }
  r.lastPlastic = now
  let targets = state.targets, hazards = state.hazards
  const t0 = performance.now()
  if (r.sim) {
    const det = await boatApi.simDetections(f.frameTime)
    if (run !== r) return
    if (!det || det._httpError) return
    r.simRamp = det.ramp || []
    targets = (det.targets || []).map((b) => ({ ...b, sim: true }))
    hazards = (det.hazards || []).map((b) => ({ ...b, sim: true, in_zone: inDangerZone(cfg, b, w, h) }))
  } else {
    // Only with BOTH models working: an observation without the animal model
    // would tell the boat "no animals" when nobody is actually looking.
    if (!r.plastic || !r.wildlife) {
      set({ tracks: trackView(r) })
      return
    }
    const water = { x1: 0, y1: 0, x2: 1, y2: Math.min(1, (cfg.ramp_top ?? 0.78) + 0.02) }
    const conf = Math.max(0.2, r.plastic.meta?.recommendedConf || 0.25)
    targets = (await exclusive(r, () => r.plastic.detect(bmp, { confThr: conf, iouThr: 0.45, rect: water })))
      .filter((b) => (b.y1 + b.y2) / 2 < rampY)
      .map((b) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, score: b.score, label: b.label }))
    if (run !== r) return
    if (now - r.lastWildlife >= 1000 / WILDLIFE_HZ) {
      r.lastWildlife = now
      hazards = (await exclusive(r, () => r.wildlife.detect(bmp, { confThr: 0.4, frame: `boat:${f.seq}` })))
        .filter((b) => (b.y1 + b.y2) / 2 < rampY)
        .map((b) => ({ ...b, in_zone: inDangerZone(cfg, b, w, h) }))
      if (run !== r) return
    }
  }
  const aiMs = Math.round(performance.now() - t0)
  set({ targets, hazards, tracks: trackView(r), aiMs: aiMs > 2 ? aiMs : state.aiMs })

  // 3. Tell the boat what this pass saw.
  if (r.observing) return
  const inZone = hazards.some((x) => x.in_zone)
  const body = {
    frame_time: f.frameTime, frame_w: w, frame_h: h,
    targets: targets.map(({ x1, y1, x2, y2, score, label }) => ({ x1, y1, x2, y2, score, label })),
    hazards: hazards.map(({ x1, y1, x2, y2, score, label, in_zone }) => ({ x1, y1, x2, y2, score, label, in_zone })),
  }
  if (inZone && !r.hadHazard) body.hazard_photo = snapshot(r, bmp, 0, 0, w, h, 480)
  r.hadHazard = inZone
  r.observing = true
  boatApi.observe(body)
    .then((res) => { if (run === r) set({ observed: state.observed + (res && !res._httpError ? 1 : 0) }) })
    .catch(() => {})
    .finally(() => { r.observing = false })
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
