// Lightweight, always-on, fully LOCAL face detector.
//
// This exists for one reason: the trash model has no concept of a human face
// and can score one as "trash". Rather than depend on a cloud API to catch
// that (which is slow, throttled, costs money, and simply isn't there if the
// network/proxy/key is down), we run a small dedicated face-detection model
// ourselves — same-origin, every frame, in every engine mode — purely to
// suppress any trash-model box that lands on a face. Face boxes themselves are
// NEVER shown/output; this module exists only to clean up the other model.
//
// Model: YOLOv11n-face (single-class "face", from akanametov/yolo-face,
// trained on WIDERFACE — same YOLO11/Ultralytics family and export pipeline
// as trash.onnx). Because of that, its input/output layout is IDENTICAL to
// the trash detector: input images[1,3,320,320] RGB /255 letterboxed (mid-grey
// pad, matching Ultralytics training), output0[1,5,N] = [cx,cy,w,h,score] per
// anchor in 320-input pixel space, single class, NMS not baked in.
//
// It's small enough (~10.5MB, comparable cost to the trash model) to run
// every frame alongside it without hurting frame rate on WebGPU/WASM.

import { loadOrt, createSession } from './detector'

const IN = 640
const PAD_RGB = [114, 114, 114]

export async function createFaceDetector(onProgress) {
  const ort = await loadOrt() // shares the already-loaded ORT runtime
  onProgress && onProgress('Loading face-safety model…')
  const { session, ep } = await createSession(ort, '/models/face-yolo.onnx', onProgress)
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

  async function detectFaces(source, { confThr = 0.15, iouThr = 0.3 } = {}) {
    const sw = source.videoWidth || source.width || source.naturalWidth
    const sh = source.videoHeight || source.height || source.naturalHeight
    if (!sw || !sh) return []
    const { ratio, padX, padY } = preprocess(source, sw, sh)
    const tensor = new ort.Tensor('float32', buf, [1, 3, IN, IN])
    const result = await session.run({ [inputName]: tensor })
    const out = result[outputName]
    const data = out.getData ? await out.getData() : out.data
    const dims = out.dims
    const d0 = Number(dims[0]), d1 = Number(dims[1]), d2 = Number(dims[2])
    console.log('[face] outputNames:', session.outputNames, 'usedName:', outputName, 'dims:', [d0, d1, d2], 'dataLen:', data.length)
    const isTransposed = d1 < d2
    const n = isTransposed ? d2 : d1
    console.log('[face] isTransposed:', isTransposed, 'n:', n)
    const boxes = []

    for (let i = 0; i < n; i++) {
      let cxp, cyp, wp, hp, score
      if (isTransposed) {
        cxp   = data[i]
        cyp   = data[n + i]
        wp    = data[2 * n + i]
        hp    = data[3 * n + i]
        score = data[4 * n + i]
      } else {
        cxp   = data[i * 5]
        cyp   = data[i * 5 + 1]
        wp    = data[i * 5 + 2]
        hp    = data[i * 5 + 3]
        score = data[i * 5 + 4]
      }
      if (score < confThr) continue
      let x1 = (cxp - wp / 2 - padX) / ratio
      let y1 = (cyp - hp / 2 - padY) / ratio
      let x2 = (cxp + wp / 2 - padX) / ratio
      let y2 = (cyp + hp / 2 - padY) / ratio
      x1 = Math.max(0, Math.min(sw, x1))
      y1 = Math.max(0, Math.min(sh, y1))
      x2 = Math.max(0, Math.min(sw, x2))
      y2 = Math.max(0, Math.min(sh, y2))
      if (x2 <= x1 || y2 <= y1) continue
      boxes.push({ x1, y1, x2, y2, score })
    }
    const maxScore = boxes.length === 0 ? data.reduce((m, v) => Math.max(m, v), 0).toFixed(3) : 'N/A (boxes found)'
    const nmsResult = nms(boxes, iouThr)
    console.log('[face] boxes before NMS:', boxes.length, 'after NMS:', nmsResult.length, 'maxRawScore:', maxScore, 'confThr:', confThr)
    return nmsResult
  }

  function dispose() {
    try {
      session.release && session.release()
    } catch {
      /* noop */
    }
  }

  return { detectFaces, dispose, ep }
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
