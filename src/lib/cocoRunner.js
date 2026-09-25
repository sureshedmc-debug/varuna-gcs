// One shared coco-yolo.onnx session for the person and plant detectors.
// Both used to load their own copy of the same model and run it on the same
// frame; now the model loads once and, when both ask about the same frame
// (same `frame` token), it runs once and both read the same output.

import { loadOrt, createSession } from './detector'

export const COCO_IN = 320
const PAD_RGB = [114, 114, 114]

let shared = null // { promise, refs }

async function build(onProgress) {
  const ort = await loadOrt()
  const { session, ep } = await createSession(ort, '/models/coco-yolo.onnx', onProgress)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]

  const cv = document.createElement('canvas')
  cv.width = COCO_IN
  cv.height = COCO_IN
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const buf = new Float32Array(3 * COCO_IN * COCO_IN)

  function preprocess(source, sw, sh) {
    const ratio = Math.min(COCO_IN / sw, COCO_IN / sh)
    const nw = Math.round(sw * ratio)
    const nh = Math.round(sh * ratio)
    const padX = Math.floor((COCO_IN - nw) / 2)
    const padY = Math.floor((COCO_IN - nh) / 2)
    cx.fillStyle = `rgb(${PAD_RGB[0]},${PAD_RGB[1]},${PAD_RGB[2]})`
    cx.fillRect(0, 0, COCO_IN, COCO_IN)
    cx.drawImage(source, 0, 0, sw, sh, padX, padY, nw, nh)
    const { data } = cx.getImageData(0, 0, COCO_IN, COCO_IN)
    const area = COCO_IN * COCO_IN
    for (let i = 0; i < area; i++) {
      buf[i] = data[i * 4] / 255
      buf[area + i] = data[i * 4 + 1] / 255
      buf[area * 2 + i] = data[i * 4 + 2] / 255
    }
    return { ratio, padX, padY }
  }

  let lastFrame
  let lastResult = null

  /** Run the model on `source`. Returns null if the source has no size yet.
   *  Calls with the same (defined) `frame` token reuse the first call's result. */
  function run(source, frame) {
    if (frame !== undefined && frame === lastFrame && lastResult) return lastResult
    const p = (async () => {
      const sw = source.videoWidth || source.width || source.naturalWidth || 0
      const sh = source.videoHeight || source.height || source.naturalHeight || 0
      if (!sw || !sh) return null
      const { ratio, padX, padY } = preprocess(source, sw, sh)
      const tensor = new ort.Tensor('float32', buf, [1, 3, COCO_IN, COCO_IN])
      const result = await session.run({ [inputName]: tensor })
      const out = result[outputName]
      const data = out.getData ? await out.getData() : out.data
      // Cast dims to Number — out.dims is BigInt64Array on WebGPU
      return { data, n: Number(out.dims[2]), numClasses: Number(out.dims[1]) - 4, ratio, padX, padY, sw, sh }
    })()
    if (frame !== undefined) {
      lastFrame = frame
      lastResult = p
    }
    return p
  }

  return { run, ep, session }
}

/** Take a reference to the shared model. Call release() when done; the
 *  session is freed when the last holder releases it. */
export function acquireCoco(onProgress) {
  if (!shared) {
    const s = { refs: 0 }
    s.promise = build(onProgress)
    s.promise.catch(() => {
      if (shared === s) shared = null // let a later caller retry
    })
    shared = s
  }
  const s = shared
  s.refs++
  let released = false
  return {
    ready: s.promise,
    release() {
      if (released) return
      released = true
      s.refs--
      if (s.refs > 0) return
      if (shared === s) shared = null
      s.promise
        .then((r) => {
          try {
            r.session.release && r.session.release()
          } catch {
            /* noop */
          }
        })
        .catch(() => {})
    },
  }
}
