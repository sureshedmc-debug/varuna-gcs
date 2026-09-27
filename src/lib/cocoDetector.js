// Local general-object verifier model (COCO, 80 classes). Two jobs, both about
// making the trash model's output more TRUSTWORTHY, not about detecting more
// stuff on its own:
//
// 1. Identify plastic bottles SPECIFICALLY. trash.onnx is a single-class model
//    (everything it sees is just "item" → shown as "Trash") — it has no concept
//    of "bottle" vs. other trash. This model's 'bottle' class (COCO id 39) is
//    used to relabel/confirm which of the trash boxes are actually bottles, and
//    to catch bottles the trash model missed.
// 2. Suppress the trash model's bad detections. When this model confidently
//    recognises a real, common, non-trash object (a person, a chair, a car, an
//    animal, …) sitting where the trash model flagged something, that's strong
//    independent evidence the trash box is wrong — same idea as the dedicated
//    face-suppression model, generalised to any recognisable object.
//
// Same export pipeline/conventions as trash.onnx (input images[1,3,320,320]
// RGB /255 letterboxed, mid-grey pad), but multi-class: output0[1,84,N] =
// [cx,cy,w,h, score_c0..score_c79] per anchor — Ultralytics YOLO11 standard
// COCO head, exported at a fixed 320 input to match this app's pipeline.
//
// It's a full second detector model, so it's meant to be run THROTTLED (see
// WebcamDetect.jsx) rather than every frame — it verifies/corrects, it doesn't
// need to be real-time.

import { loadOrt, createSession } from './detector'

const IN = 320
const PAD_RGB = [114, 114, 114]
export const BOTTLE_CLASS = 39 // COCO class id for 'bottle'

export async function createCocoDetector(onProgress) {
  const ort = await loadOrt()
  onProgress && onProgress('Loading verification model…')
  const { session, ep, release } = await createSession(ort, '/models/coco-yolo.onnx', onProgress)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]

  const cv = document.createElement('canvas')
  cv.width = IN
  cv.height = IN
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const buf = new Float32Array(3 * IN * IN)

  function preprocess(source, sw, sh) {
    const ratio = Math.min(IN / sw, IN / sh)
    const nw = Math.round(sw * ratio)
    const nh = Math.round(sh * ratio)
    const padX = Math.floor((IN - nw) / 2)
    const padY = Math.floor((IN - nh) / 2)
    cx.fillStyle = `rgb(${PAD_RGB[0]},${PAD_RGB[1]},${PAD_RGB[2]})`
    cx.fillRect(0, 0, IN, IN)
    cx.drawImage(source, 0, 0, sw, sh, padX, padY, nw, nh)
    const { data } = cx.getImageData(0, 0, IN, IN)
    const area = IN * IN
    for (let i = 0; i < area; i++) {
      buf[i] = data[i * 4] / 255
      buf[area + i] = data[i * 4 + 1] / 255
      buf[area * 2 + i] = data[i * 4 + 2] / 255
    }
    return { ratio, padX, padY }
  }

  /** Detect all 80 COCO classes; caller separates bottle (BOTTLE_CLASS) from
   * everything else. Class-agnostic NMS — good enough for verification use. */
  async function detect(source, { confThr = 0.4, iouThr = 0.45 } = {}) {
    const sw = source.videoWidth || source.width || source.naturalWidth
    const sh = source.videoHeight || source.height || source.naturalHeight
    if (!sw || !sh) return []
    const { ratio, padX, padY } = preprocess(source, sw, sh)
    const tensor = new ort.Tensor('float32', buf, [1, 3, IN, IN])
    const result = await session.run({ [inputName]: tensor })
    const out = result[outputName]
    const data = out.getData ? await out.getData() : out.data
    const n = out.dims[2]
    const numClasses = out.dims[1] - 4
    const boxes = []
    for (let i = 0; i < n; i++) {
      let bestCls = 0
      let bestScore = -1
      for (let c = 0; c < numClasses; c++) {
        const s = data[(4 + c) * n + i]
        if (s > bestScore) {
          bestScore = s
          bestCls = c
        }
      }
      if (bestScore < confThr) continue
      const cxp = data[i]
      const cyp = data[n + i]
      const wp = data[2 * n + i]
      const hp = data[3 * n + i]
      let x1 = (cxp - wp / 2 - padX) / ratio
      let y1 = (cyp - hp / 2 - padY) / ratio
      let x2 = (cxp + wp / 2 - padX) / ratio
      let y2 = (cyp + hp / 2 - padY) / ratio
      x1 = Math.max(0, Math.min(sw, x1))
      y1 = Math.max(0, Math.min(sh, y1))
      x2 = Math.max(0, Math.min(sw, x2))
      y2 = Math.max(0, Math.min(sh, y2))
      if (x2 <= x1 || y2 <= y1) continue
      boxes.push({ x1, y1, x2, y2, score: bestScore, cls: bestCls })
    }
    return nms(boxes, iouThr)
  }

  function dispose() {
    // Shared session: drop this holder's reference. It is only freed once the
    // last holder releases it (see createSession in detector.js).
    release()
  }

  return { detect, dispose, ep }
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

function nms(boxes, iouThr) {
  boxes.sort((p, q) => q.score - p.score)
  const keep = []
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
