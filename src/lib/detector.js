
const DEFAULT_IN = 640
// One colour per model class (by class index), used for its on-screen boxes.
const CLASS_PALETTE = ['#22D3EE', '#a78bfa', '#FF6B6B', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#fb923c']
const PAD_RGB = [114, 114, 114]

let ortPromise = null
/** Shared, cached onnxruntime-web module â€” reused by every local model
 * (trash detector, face detector) so the WASM/WebGPU runtime is fetched once. */
export async function loadOrt() {
  if (!ortPromise) {
    // The /webgpu build ships the GPU (jsep) + WASM fallback in one module.
    ortPromise = import('onnxruntime-web/webgpu').then((ort) => {
      ort.env.wasm.wasmPaths = '/ort/'
      ort.env.wasm.numThreads = 1
      ort.env.wasm.simd = true
      return ort
    })
  }
  return ortPromise
}

// `navigator.gpu` merely EXISTING does not mean a usable GPU is available:
// requestAdapter() still returns null on a blocklisted driver, a headless or
// remote session, or a device already under pressure. That distinction turns
// out to matter here.
//
// onnxruntime-web is ONE shared WASM module for every model. A WebGPU session
// create that fails PART WAY through can leave that module's heap in a bad
// state, and every later create on it then traps with "memory access out of
// bounds" - including the CPU fallback, which is meant to be the safety net.
// So a GPU problem surfaces as a total failure to load any model at all, and
// once the module traps there is no way back short of reloading the page.
//
// Two guards: ask for an adapter before touching the GPU path at all, and
// after a single WebGPU failure stop trying it for the rest of the session
// (three models each retrying it is three chances to poison the runtime).
let adapterOk = null // null = not probed yet
let webgpuFailed = false

async function webgpuUsable() {
  if (webgpuFailed) return false
  if (adapterOk !== null) return adapterOk
  adapterOk = false
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      adapterOk = !!(await navigator.gpu.requestAdapter())
    }
  } catch {
    adapterOk = false
  }
  return adapterOk
}

// onnxruntime initialises its WASM runtime lazily, on the first
// InferenceSession.create. Two creates racing that first init throw
// "multiple calls to 'initWasm()' detected" and leave the runtime half
// built - after which every later create traps with "memory access out of
// bounds" and NO model can load until the page is reloaded.
//
// React StrictMode makes that race the default in development: it mounts,
// runs effects, unmounts and remounts, so the model-loading effect fires
// twice and the second createDetector starts while the first is still in
// flight. (Production doesn't double-invoke, which is why this only ever
// showed up on localhost.) Two WebcamDetect instances mounted at once would
// do the same thing anywhere.
//
// Funnelling every create through one chain removes the race outright, and
// costs nothing: they were already awaited one after another.
let createChain = Promise.resolve()
function serialized(fn) {
  const run = createChain.then(fn, fn)
  // Keep the chain alive whether or not this create succeeded.
  createChain = run.then(() => {}, () => {})
  return run
}

// Sessions are SHARED and reference counted, one per model file.
//
// Building a session is expensive and blocks the main thread: three models is
// ~32MB, and measured at ~12s of blocked main thread when they are built
// twice. They were being built twice, every time, because React StrictMode
// mounts, unmounts and remounts in development — so opening the Live tab
// froze the UI. Switching away from Live and back did the same thing.
//
// Releasing is deferred, because refs hit zero between StrictMode's unmount
// and its immediate remount. Freeing there would throw the work away a
// millisecond before it is needed again.
const sessions = new Map() // modelUrl -> { promise, refs, timer }
const RELEASE_GRACE_MS = 15000

// ── Running the models in a worker ──────────────────────────────────────────
// On WebGPU, onnxruntime dispatches every layer from JavaScript, so a model run
// on the page's own thread blocked it 60-90 ms per detection: video, map and
// buttons stuttered on the Live tab. Sessions are built in ortWorker.js
// instead and this file hands back a stand-in with the same inputNames /
// outputNames / run() / release(), so the detectors don't change. If the
// worker can't start, everything runs here as before.
let worker = null
let workerBroken = false
let nextId = 0
const waiting = new Map() // 'c<id>' (create) / 'r<rid>' (run) -> { resolve, reject }

function getWorker() {
  if (workerBroken || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./ortWorker.js', import.meta.url), { type: 'module' })
  } catch (e) {
    console.warn('[ort] no worker, running the AI on the page:', e?.message ?? e)
    workerBroken = true
    return null
  }
  worker.onmessage = ({ data: m }) => {
    const key = m.rid != null ? 'r' + m.rid : 'c' + m.id
    const w = waiting.get(key)
    if (!w) return
    waiting.delete(key)
    if (m.op === 'error') w.reject(new Error(m.message))
    else w.resolve(m)
  }
  worker.onerror = (e) => {
    console.warn('[ort] AI worker failed:', e?.message ?? e)
    workerBroken = true
    worker = null
    sessions.clear() // sessions in the dead worker are gone: rebuild on next use
    for (const w of waiting.values()) w.reject(new Error('AI worker stopped'))
    waiting.clear()
  }
  return worker
}

function ask(w, key, msg) {
  return new Promise((resolve, reject) => {
    waiting.set(key, { resolve, reject })
    w.postMessage(msg)
  })
}

async function workerSession(w, modelUrl) {
  const id = ++nextId
  const info = await ask(w, 'c' + id, { op: 'create', id, url: new URL(modelUrl, location.href).href })
  const session = {
    inputNames: info.inputNames,
    outputNames: info.outputNames,
    async run(feeds) {
      const rid = ++nextId
      const f = {}
      for (const [name, t] of Object.entries(feeds)) f[name] = { type: t.type, data: t.data, dims: t.dims }
      const m = await ask(w, 'r' + rid, { op: 'run', id, rid, feeds: f }) // the input is copied, so callers may reuse it
      const out = {}
      for (const [name, o] of Object.entries(m.outputs)) out[name] = { ...o, getData: async () => o.data }
      return out
    },
    release() {
      w.postMessage({ op: 'release', id })
    },
  }
  return { session, ep: info.ep }
}

function buildSession(ort, modelUrl, onProgress) {
  const w = getWorker()
  if (!w) return buildSessionHere(ort, modelUrl, onProgress)
  onProgress && onProgress('Loading model…')
  return workerSession(w, modelUrl).catch((e) => {
    console.warn('[ort] worker could not load', modelUrl, '- loading it on the page:', e?.message ?? e)
    return buildSessionHere(ort, modelUrl, onProgress)
  })
}

function buildSessionHere(ort, modelUrl, onProgress) {
  return serialized(async () => {
  let session
  let ep = 'wasm'
  const opts = { graphOptimizationLevel: 'all' }
  if (await webgpuUsable()) {
    try {
      onProgress && onProgress('Loading model (GPU)â€¦')
      session = await ort.InferenceSession.create(modelUrl, { ...opts, executionProviders: ['webgpu'] })
      ep = 'webgpu'
    } catch (e) {
      console.warn('[ort] WebGPU unavailable, using CPU for the rest of this session:', e?.message ?? e)
      webgpuFailed = true
      session = null
    }
  }
  if (!session) {
    onProgress && onProgress('Loading model (CPU)â€¦')
    session = await ort.InferenceSession.create(modelUrl, { ...opts, executionProviders: ['wasm'] })
    ep = 'wasm'
  }
  return { session, ep }
  })
}

/** Acquire the shared session for `modelUrl`. Call release() when done. */
export async function createSession(ort, modelUrl, onProgress) {
  let entry = sessions.get(modelUrl)
  if (entry?.timer) {
    clearTimeout(entry.timer) // someone wants it again before the grace expired
    entry.timer = null
  }
  if (!entry) {
    entry = { refs: 0, timer: null }
    entry.promise = buildSession(ort, modelUrl, onProgress)
    // A failed build must not be cached, or every later attempt inherits it.
    entry.promise.catch(() => {
      if (sessions.get(modelUrl) === entry) sessions.delete(modelUrl)
    })
    sessions.set(modelUrl, entry)
  }
  entry.refs++
  const { session, ep } = await entry.promise

  let released = false
  function release() {
    if (released) return
    released = true
    entry.refs--
    if (entry.refs > 0) return
    entry.timer = setTimeout(() => {
      if (entry.refs > 0) return
      if (sessions.get(modelUrl) === entry) sessions.delete(modelUrl)
      try {
        session.release && session.release()
      } catch {
        /* already gone */
      }
    }, RELEASE_GRACE_MS)
  }
  return { session, ep, release }
}

/**
 * Detection models the operator can pick on the Live view. Each is a pair of
 * files in public/models: <key>.onnx and its sidecar <key>.json (class names,
 * which classes to report, recommended confidence). Swapping in a retrained
 * model = replacing those two files; no code change needed.
 */
export const DETECT_MODELS = [
  { key: 'plastic', label: 'TACO groups', test: false }, // default: trained on TACO in Colab
  { key: 'plastic_detection', label: 'Plastic v2', test: true }, // single-class model, under test
]
export const DEFAULT_DETECT_MODEL = 'plastic'
const MODEL_PREF_KEY = 'varuna.detectModel'

export function getDetectModel() {
  try {
    const k = localStorage.getItem(MODEL_PREF_KEY)
    return DETECT_MODELS.some((m) => m.key === k) ? k : DEFAULT_DETECT_MODEL
  } catch {
    return DEFAULT_DETECT_MODEL
  }
}
export function setDetectModel(key) {
  try {
    localStorage.setItem(MODEL_PREF_KEY, key)
  } catch {
    /* private mode */
  }
}

export async function createPlasticDetector(onProgress, key = getDetectModel()) {
  const meta = await fetch(`/models/${key}.json`).then((r) => {
    if (!r.ok) throw new Error(`${key}.json: HTTP ${r.status}`)
    return r.json()
  })
  const names = meta.names || ['Plastic']
  const ids = meta.target_class_ids || meta.plastic_class_ids || names.map((_, i) => i)
  const det = await createDetector(onProgress, `/models/${key}.onnx`, names, meta.imgsz || DEFAULT_IN)
  const targets = new Set(ids)
  return {
    ...det,
    /** Same as detect(), keeping only the classes the app reports. */
    async detect(source, opts) {
      return (await det.detect(source, opts)).filter((b) => targets.has(b.cls))
    },
    meta: {
      key, names, targetIds: ids, recommendedConf: Number(meta.recommended_conf) || 0.5,
      test: !!DETECT_MODELS.find((m) => m.key === key)?.test,
    },
  }
}

export async function createDetector(onProgress, modelUrl = '/models/plastic.onnx', classNames = ['Plastic'], inputSize = DEFAULT_IN) {
  const ort = await loadOrt()
  onProgress && onProgress(`Loading ${classNames[0]} modelâ€¦`)
  const { session, ep, release } = await createSession(ort, modelUrl, onProgress)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]

  // reusable scratch canvas for letterboxing
  const cv = document.createElement('canvas')
  cv.width = inputSize
  cv.height = inputSize
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const buf = new Float32Array(3 * inputSize * inputSize)

  /**
   * Letterbox a CROP of `source` (pixel rect [cx1,cy1,cx2,cy2]) into the fixed
   * input buffer. Returns the transform needed to map model-space boxes
   * back to full-source pixel coords.
   */
  function preprocess(source, crop) {
    const { cx1, cy1, cw, ch } = crop
    const ratio = Math.min(inputSize / cw, inputSize / ch)
    const nw = Math.round(cw * ratio)
    const nh = Math.round(ch * ratio)
    const padX = Math.floor((inputSize - nw) / 2)
    const padY = Math.floor((inputSize - nh) / 2)
    cx.fillStyle = `rgb(${PAD_RGB[0]},${PAD_RGB[1]},${PAD_RGB[2]})`
    cx.fillRect(0, 0, inputSize, inputSize)
    // 9-arg drawImage: crop [cx1,cy1,cw,ch] from source, scaled into the pad box.
    cx.drawImage(source, cx1, cy1, cw, ch, padX, padY, nw, nh)
    const { data } = cx.getImageData(0, 0, inputSize, inputSize)
    const area = inputSize * inputSize
    for (let i = 0; i < area; i++) {
      buf[i] = data[i * 4] / 255 // R
      buf[area + i] = data[i * 4 + 1] / 255 // G
      buf[area * 2 + i] = data[i * 4 + 2] / 255 // B
    }
    return { ratio, padX, padY, cx1, cy1, cw, ch }
  }

  function postprocess(data, dims, meta, confThr, iouThr) {
    const { ratio, padX, padY, cx1, cy1, cw, ch } = meta
    const boxes = []

    // Auto-detect layout from tensor shape - cast to Number for TypedArray safety.
    // Rows = 4 box values + one score per class; the class is the best-scoring one.
    const d1 = Number(dims[1]), d2 = Number(dims[2])
    const isTransposed = d1 < d2
    const n = isTransposed ? d2 : d1
    const rows = isTransposed ? d1 : d2
    const nc = Math.max(1, rows - 4)

    for (let i = 0; i < n; i++) {
      let cxp, cyp, wp, hp
      let score = -1, cls = 0
      if (isTransposed) {
        // data layout: [all_cx, all_cy, all_w, all_h, all_scores_c0, all_scores_c1, ...]
        cxp   = data[i]
        cyp   = data[n + i]
        wp    = data[2 * n + i]
        hp    = data[3 * n + i]
        for (let c = 0; c < nc; c++) { const s = data[(4 + c) * n + i]; if (s > score) { score = s; cls = c } }
      } else {
        // data layout: [cx, cy, w, h, score_c0, ...] per anchor
        const o = i * rows
        cxp   = data[o]
        cyp   = data[o + 1]
        wp    = data[o + 2]
        hp    = data[o + 3]
        for (let c = 0; c < nc; c++) { const s = data[o + 4 + c]; if (s > score) { score = s; cls = c } }
      }

      if (score < confThr) continue

      let x1 = (cxp - wp / 2 - padX) / ratio + cx1
      let y1 = (cyp - hp / 2 - padY) / ratio + cy1
      let x2 = (cxp + wp / 2 - padX) / ratio + cx1
      let y2 = (cyp + hp / 2 - padY) / ratio + cy1

      x1 = Math.max(cx1, Math.min(cx1 + cw, x1))
      y1 = Math.max(cy1, Math.min(cy1 + ch, y1))
      x2 = Math.max(cx1, Math.min(cx1 + cw, x2))
      y2 = Math.max(cy1, Math.min(cy1 + ch, y2))

      if (x2 <= x1 || y2 <= y1) continue
      boxes.push({ x1, y1, x2, y2, score, cls, label: classNames[cls] ?? `Class ${cls}`, color: CLASS_PALETTE[cls % CLASS_PALETTE.length] })
    }
    return nms(boxes, iouThr)
  }

  /**
   * Run detection on `source`, optionally restricted to a normalised crop
   * rect {x1,y1,x2,y2} in 0..1 (default = full frame). A tight rect zooms the
   * fixed-input model onto that region, recovering small/far-away objects that
   * are invisible at full-frame scale.
   */
  async function detect(source, { confThr = 0.25, iouThr = 0.45, rect = null } = {}) {
    const sw = source.videoWidth || source.width || source.naturalWidth
    const sh = source.videoHeight || source.height || source.naturalHeight
    if (!sw || !sh) return []
    const r = rect || { x1: 0, y1: 0, x2: 1, y2: 1 }
    const cx1 = Math.round(r.x1 * sw)
    const cy1 = Math.round(r.y1 * sh)
    const cw = Math.max(2, Math.round((r.x2 - r.x1) * sw))
    const ch = Math.max(2, Math.round((r.y2 - r.y1) * sh))
    const meta = preprocess(source, { cx1, cy1, cw, ch })
    const tensor = new ort.Tensor('float32', buf, [1, 3, inputSize, inputSize])
    const result = await session.run({ [inputName]: tensor })
    const out = result[outputName]
    // getData() downloads from the GPU on WebGPU; on WASM it returns .data.
    const data = out.getData ? await out.getData() : out.data
    return postprocess(data, out.dims, meta, confThr, iouThr)
  }

  function dispose() {
    // Drops this holder's reference; the session itself only goes when the
    // last holder lets go (and the grace period passes).
    release()
  }

  return { detect, dispose, ep, classNames }
}

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

/** Fraction of box `a` that lies inside box `b` (0..1). Used to test whether a
 * box "belongs to" another region â€” e.g. suppressing a trash box that actually
 * sits on a detected face. */
export function overlapRatio(a, b) {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1) || 1e-6
  return inter / areaA
}

/** AGGRESSIVE person suppression: removes ANY trash box that overlaps with a person box by ANY amount.
 * Used to prevent the trash model from detecting humans as trash. */
export function suppressByPerson(trashBoxes, personBoxes) {
  if (!personBoxes || !personBoxes.length) return trashBoxes
  return trashBoxes.filter(t => {
    for (const p of personBoxes) {
      // Any overlap at all means the trash box is actually on a person
      if (overlapRatio(t, p) > 0) return false
    }
    return true
  })
}

/**
 * For a webcam, where the person holding the plastic is always in the picture.
 * A trash box mostly on a person is removed when it IS the person (a large part
 * of their size: their shirt, their body) or when it is unsure (below
 * `minOnPerson`: a hand, a face), unless another model named it (`sure`, a
 * COCO bottle). Something they hold up stays.
 */
export function suppressPersonBody(trashBoxes, personBoxes, minOnPerson = 0.5) {
  if (!personBoxes || !personBoxes.length) return trashBoxes
  const area = (b) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
  return trashBoxes.filter((t) => !personBoxes.some((p) =>
    overlapRatio(t, p) > 0.6 && (area(t) > 0.3 * area(p) || (t.score < minOnPerson && !t.sure))))
}

function nms(boxes, iouThr) {
  boxes.sort((p, q) => q.score - p.score)
  const keep = []
  const removed = new Array(boxes.length).fill(false)
  for (let i = 0; i < boxes.length; i++) {
    if (removed[i]) continue
    keep.push(boxes[i])
    for (let j = i + 1; j < boxes.length; j++) {
      // Standard NMS: use the provided IOU threshold
      if (!removed[j] && iou(boxes[i], boxes[j]) > iouThr) removed[j] = true
    }
  }
  return keep
}

/** Merge box lists from multiple passes (full-frame + tiles) and dedupe by NMS. */
export function mergeBoxes(lists, iouThr = 0.4) {
  return nms(lists.flat(), iouThr)
}

/**
 * Build a grid of overlapping normalised crop rects covering the whole frame,
 * for rotating "long-range" tile scans. `overlap` (0..1) is extra size added
 * to each tile so objects near a tile boundary still land fully inside one.
 */
export function makeTileGrid(gridX, gridY, overlap = 0.25) {
  const tiles = []
  const strideX = 1 / gridX
  const strideY = 1 / gridY
  const tw = Math.min(1, strideX * (1 + overlap))
  const th = Math.min(1, strideY * (1 + overlap))
  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      let x1 = gx * strideX - (tw - strideX) / 2
      let y1 = gy * strideY - (th - strideY) / 2
      x1 = Math.max(0, Math.min(1 - tw, x1))
      y1 = Math.max(0, Math.min(1 - th, y1))
      tiles.push({ x1, y1, x2: x1 + tw, y2: y1 + th })
    }
  }
  return tiles
}

/**
 * Dedicated plastic bottle specialist detector (YOLO11s).
 * Runs alongside plastic.onnx to filter out faces.
 */
export async function createFaceDetector(onProgress) {
  // Face models typically use 320x320. Setting to 320 to resolve potential loading errors.
  return createDetector(onProgress, '/models/face-yolo.onnx', ['Face'], 320)
}


