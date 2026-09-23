// Plant / vegetation suppression for river scenes.
// Uses coco-yolo.onnx (80-class YOLO11n).
// Detects plant-related COCO classes and suppresses trash boxes that overlap them.
//
// COCO classes checked for vegetation:
//   58 = potted plant (outdoor pots/houseplants)
//   59 = flower (bouquets, cut flowers)
//   60 = dining table (skip - not vegetation)
//   61 = chair (skip - not vegetation)
//   62 = couch (skip - not vegetation)
//   63 = potted plant (repeat of 58)
//   64 = bed (skip)
//   65 = dining table (skip)
//   66 = toilet (skip)
//   67 = tv (skip)
//   68 = laptop (skip)
//   69 = mouse (skip)
//   70 = remote (skip)
//   71 = keyboard (skip)
//   72 = cell phone (skip)
//   73 = microwave (skip)
//   74 = oven (skip)
//   75 = toaster (skip)
//   76 = sink (skip)
//   77 = refrigerator (skip)
//   78 = book (skip)
//   79 = clock (skip)
//   80 = vase (plant-related - vases often hold flowers/plants)
//   81 = scissors (skip)
//   82 = teddy bear (skip)
//   83 = hair drier (skip)
//   84 = toothbrush (skip)
//   85 = hair brush (skip)
//   86 = back pack (skip)
//   87 = umbrella (skip - could be outdoor but not vegetation)
//   88 = handbag (skip)
//   89 = tie (skip)
//   90 = suitcase (skip)
//   91 = frisbee (skip)
//   92 = skis (skip)
//   93 = snowboard (skip)
//   94 = sports ball (skip)
//   95 = kite (skip)
//   96 = baseball bat (skip)
//   97 = baseball glove (skip)
//   98 = skateboard (skip)
//   99 = surfboard (skip)
//   100 = tennis racket (skip)
//
// For river scenes, only classes 58 (potted plant) and 80 (vase) are relevant.
// Vase is included because vases with flowers/plants often appear near rivers.
//
// Output tensor layout: [1, 84, N] transposed
//   data[0*n + i] = cx,  data[1*n + i] = cy
//   data[2*n + i] = w,   data[3*n + i] = h
//   data[(4+c)*n + i]    = score for class c
//
// All dims cast with Number() to avoid BigInt64Array TypeError on WebGPU.

import { loadOrt, createSession } from './detector'

const IN = 320
const PAD_RGB = [114, 114, 114]

// COCO class IDs to treat as plant-related (vases hold flowers, potted plants are vegetation)
const PLANT_CLASSES = [58, 80] // 58 = potted plant, 80 = vase

export async function createPlantDetector(onProgress) {
  const ort = await loadOrt()
  onProgress && onProgress('Loading plant detection model...')

  let session, ep
  try {
    const result = await createSession(ort, '/models/coco-yolo.onnx', onProgress)
    session = result.session
    ep = result.ep
  } catch (e) {
    console.warn('[plant] coco-yolo.onnx not found or failed:', e.message)
    return { detectPlants: async () => [], dispose: () => {}, ep: null, available: false }
  }

  const inputName  = session.inputNames[0]
  const outputName = session.outputNames[0]

  const cv = document.createElement('canvas')
  cv.width  = IN
  cv.height = IN
  const cx  = cv.getContext('2d', { willReadFrequently: true })
  const buf = new Float32Array(3 * IN * IN)

  function preprocess(source, sw, sh) {
    const ratio = Math.min(IN / sw, IN / sh)
    const nw    = Math.round(sw * ratio)
    const nh    = Math.round(sh * ratio)
    const padX  = Math.floor((IN - nw) / 2)
    const padY  = Math.floor((IN - nh) / 2)
    cx.fillStyle = `rgb(${PAD_RGB[0]},${PAD_RGB[1]},${PAD_RGB[2]})`
    cx.fillRect(0, 0, IN, IN)
    cx.drawImage(source, 0, 0, sw, sh, padX, padY, nw, nh)
    const { data } = cx.getImageData(0, 0, IN, IN)
    const area = IN * IN
    for (let i = 0; i < area; i++) {
      buf[i]           = data[i * 4]     / 255
      buf[area + i]    = data[i * 4 + 1] / 255
      buf[area * 2 + i]= data[i * 4 + 2] / 255
    }
    return { ratio, padX, padY }
  }

  async function detectPlants(source, { confThr = 0.20, iouThr = 0.30 } = {}) {
    const sw = source.videoWidth  || source.width        || source.naturalWidth  || 0
    const sh = source.videoHeight || source.height       || source.naturalHeight || 0
    if (!sw || !sh) return []

    const { ratio, padX, padY } = preprocess(source, sw, sh)
    const tensor = new ort.Tensor('float32', buf, [1, 3, IN, IN])
    const result = await session.run({ [inputName]: tensor })
    const out    = result[outputName]
    const data   = out.getData ? await out.getData() : out.data

    // Cast ALL dims to Number — out.dims is BigInt64Array on WebGPU
    const n          = Number(out.dims[2])
    const numClasses = Number(out.dims[1]) - 4

    const boxes = []
    for (let i = 0; i < n; i++) {
      // Find best plant-class score for this anchor
      let bestScore = 0
      for (const classId of PLANT_CLASSES) {
        if (classId >= numClasses) continue
        const s = data[(4 + classId) * n + i]
        if (s > bestScore) bestScore = s
      }
      if (bestScore < confThr) continue

      // Decode box — transposed layout: row = attribute, col = anchor
      const cxp = data[0 * n + i]
      const cyp = data[1 * n + i]
      const wp  = data[2 * n + i]
      const hp  = data[3 * n + i]

      let x1 = (cxp - wp / 2 - padX) / ratio
      let y1 = (cyp - hp / 2 - padY) / ratio
      let x2 = (cxp + wp / 2 - padX) / ratio
      let y2 = (cyp + hp / 2 - padY) / ratio

      x1 = Math.max(0, Math.min(sw, x1))
      y1 = Math.max(0, Math.min(sh, y1))
      x2 = Math.max(0, Math.min(sw, x2))
      y2 = Math.max(0, Math.min(sh, y2))
      if (x2 <= x1 || y2 <= y1) continue

      boxes.push({ x1, y1, x2, y2, score: bestScore })
    }

    const result2 = nms(boxes, iouThr)
    console.log('[plant] detected:', result2.length, 'boxes at confThr:', confThr)
    return result2
  }

  function dispose() {
    try { session.release && session.release() } catch { /* noop */ }
  }

  return { detectPlants, dispose, ep, available: true }
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (areaA + areaB - inter + 1e-6)
}

function nms(boxes, iouThr) {
  boxes.sort((a, b) => b.score - a.score)
  const keep    = []
  const removed = new Array(boxes.length).fill(false)
  for (let i = 0; i < boxes.length; i++) {
    if (removed[i]) continue
    keep.push(boxes[i])
    for (let j = i + 1; j < boxes.length; j++) {
      if (!removed[j] && iou(boxes[i], boxes[j]) > iouThr) removed[j] = true
    }
  }
  return keep
}