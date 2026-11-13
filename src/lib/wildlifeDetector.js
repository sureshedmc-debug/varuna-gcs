// Animals (and people) on the boat camera, for wildlife-safe mode. Uses the
// app's shared COCO model (cocoRunner.js), which knows birds, people, dogs,
// cats and farm animals — not fish or turtles.

import { acquireCoco } from './cocoRunner'

export const WILDLIFE_CLASSES = { 0: 'person', 14: 'bird', 15: 'cat', 16: 'dog', 17: 'horse', 18: 'sheep', 19: 'cow' }

function iou(a, b) {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const inter = w * h
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter + 1e-6)
}

export async function createWildlifeDetector(onProgress) {
  const coco = acquireCoco(onProgress)
  let runner
  try {
    runner = await coco.ready
  } catch (e) {
    coco.release()
    throw e
  }
  let disposed = false

  async function detect(source, { confThr = 0.35, frame } = {}) {
    if (disposed) return []
    const r = await runner.run(source, frame)
    if (!r) return []
    const { data, n, numClasses, ratio, padX, padY, sw, sh } = r
    const boxes = []
    for (let i = 0; i < n; i++) {
      let best = -1, cls = -1
      for (const c of Object.keys(WILDLIFE_CLASSES)) {
        const k = Number(c)
        if (k >= numClasses) continue
        const s = data[(4 + k) * n + i]
        if (s > best) { best = s; cls = k }
      }
      if (best < confThr) continue
      const cx = data[i], cy = data[n + i], w = data[2 * n + i], h = data[3 * n + i]
      const x1 = Math.max(0, Math.min(sw, (cx - w / 2 - padX) / ratio))
      const y1 = Math.max(0, Math.min(sh, (cy - h / 2 - padY) / ratio))
      const x2 = Math.max(0, Math.min(sw, (cx + w / 2 - padX) / ratio))
      const y2 = Math.max(0, Math.min(sh, (cy + h / 2 - padY) / ratio))
      if (x2 > x1 && y2 > y1) boxes.push({ x1, y1, x2, y2, score: best, label: WILDLIFE_CLASSES[cls] })
    }
    boxes.sort((a, b) => b.score - a.score)
    const keep = []
    for (const b of boxes) if (!keep.some((k) => iou(k, b) > 0.4)) keep.push(b)
    return keep
  }

  return {
    detect,
    ep: runner.ep,
    dispose() {
      disposed = true
      coco.release()
    },
  }
}
