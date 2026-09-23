import { filterDetections } from './labels'

const DEFAULT_IN = 640
const CLASS_NAMES = ['Trash'] // model's single class 'item' â†’ shown as "Trash"
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

/** Create an inference session for `modelUrl`, preferring WebGPU and falling
 * back to WASM/SIMD on CPU. Shared by every local model in this app. */
export async function createSession(ort, modelUrl, onProgress) {
  let session
  let ep = 'wasm'
  const opts = { graphOptimizationLevel: 'all' }
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      onProgress && onProgress('Loading model (GPU)â€¦')
      session = await ort.InferenceSession.create(modelUrl, { ...opts, executionProviders: ['webgpu'] })
      ep = 'webgpu'
    } catch {
      session = null
    }
  }
  if (!session) {
    onProgress && onProgress('Loading model (CPU)â€¦')
    session = await ort.InferenceSession.create(modelUrl, { ...opts, executionProviders: ['wasm'] })
    ep = 'wasm'
  }
  return { session, ep }
}

export async function createDetector(onProgress, modelUrl = '/models/trash.onnx', classNames = ['Trash'], inputSize = DEFAULT_IN) {
  const ort = await loadOrt()
  onProgress && onProgress(`Loading ${classNames[0]} modelâ€¦`)
  const { session, ep } = await createSession(ort, modelUrl, onProgress)
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

    // Auto-detect layout from tensor shape - cast to Number for TypedArray safety
    const d0 = Number(dims[0]), d1 = Number(dims[1]), d2 = Number(dims[2])
    const isTransposed = d1 < d2
    const n = isTransposed ? d2 : d1
    console.log('[trash] dims:', [d0, d1, d2], 'isTransposed:', isTransposed, 'n:', n, 'confThr:', confThr)

    for (let i = 0; i < n; i++) {
      let cxp, cyp, wp, hp, score
      if (isTransposed) {
        // data layout: [all_cx, all_cy, all_w, all_h, all_scores]
        cxp   = data[i]
        cyp   = data[n + i]
        wp    = data[2 * n + i]
        hp    = data[3 * n + i]
        score = data[4 * n + i]
      } else {
        // data layout: [cx, cy, w, h, score,  cx, cy, w, h, score, ...]
        cxp   = data[i * 5]
        cyp   = data[i * 5 + 1]
        wp    = data[i * 5 + 2]
        hp    = data[i * 5 + 3]
        score = data[i * 5 + 4]
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
      boxes.push({ x1, y1, x2, y2, score, cls: 0, label: classNames[0] })
    }
    console.log('[trash] boxes before NMS:', boxes.length, 'top scores:', boxes.slice(0,5).map(b=>b.score.toFixed(2)))
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
    // filterDetections keeps only trash / plastic-bottle boxes.
    return filterDetections(postprocess(data, out.dims, meta, confThr, iouThr))
  }

  function dispose() {
    try {
      session.release && session.release()
    } catch {
      /* noop */
    }
  }

  return { detect, dispose, ep, classNames: CLASS_NAMES }
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

/** Plant suppression: removes trash boxes that significantly overlap with detected plants.
 * Used to prevent false positives when trash model detects river plants as trash.
 * @param {Array} trashBoxes - Boxes from trash detection
 * @param {Array} plantBoxes - Boxes from plant detection
 * @param {number} iouThr - IoU threshold for suppression (default: 0.15)
 */
export function suppressByPlants(trashBoxes, plantBoxes, iouThr = 0.15) {
  if (!trashBoxes) return []
  if (!plantBoxes || !plantBoxes.length) return trashBoxes
  return trashBoxes.filter(t => {
    for (const p of plantBoxes) {
      // If trash box overlaps significantly with a plant, remove it
      if (overlapRatio(t, p) > iouThr) return false
    }
    return true
  })
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
 * Runs alongside trash.onnx for high-accuracy dual-model detection.
 */
export async function createFaceDetector(onProgress) {
  // Face models typically use 320x320. Setting to 320 to resolve potential loading errors.
  return createDetector(onProgress, '/models/face-yolo.onnx', ['Face'], 320)
}


