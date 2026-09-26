// Aggressive human detection using COCO YOLO model.
// Suppresses ANY trash detection that overlaps with a detected person by ANY amount.
//
// Uses the same coco-yolo.onnx model as cocoDetector.js but filters specifically
// for 'person' class (COCO id 0) and applies a very aggressive suppression policy.

import { acquireCoco } from './cocoRunner'

export const PERSON_CLASS = 0 // COCO class id for 'person'

export async function createPersonDetector(onProgress) {
  onProgress && onProgress('Loading human detection model…')
  const coco = acquireCoco(onProgress)
  let runner
  try {
    runner = await coco.ready
  } catch (e) {
    coco.release()
    throw e
  }
  const { ep } = runner

  /** Detect only 'person' class from COCO model, suppressing other classes.
   * Uses low confidence threshold to catch all possible humans.
   * `frame`: optional per-frame token — any other detector on the shared COCO
   * session asking about the same frame reuses this pass instead of rerunning. */
  let disposed = false
  async function detectPersons(source, { confThr = 0.25, iouThr = 0.3, frame } = {}) {
    if (disposed) return [] // the shared session may now belong to another detector
    const r = await runner.run(source, frame)
    if (!r) return []
    const { data, n, ratio, padX, padY, sw, sh } = r

    const boxes = []
    for (let i = 0; i < n; i++) {
      // Extract person class score (class 0) - tensor layout: [cx, cy, w, h, score_class0, score_class1, ...]
      const personScore = data[(4 + 0) * n + i]  // Class 0 is person
      if (personScore < confThr) continue

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
      boxes.push({ x1, y1, x2, y2, score: personScore })
    }

    return nms(boxes, iouThr)
  }

  function dispose() {
    disposed = true
    coco.release()
  }

  return { detectPersons, dispose, ep }
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
