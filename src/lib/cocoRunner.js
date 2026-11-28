// One shared, reference-counted coco-yolo.onnx session. Callers that pass the
// same `frame` token share a single model pass instead of each running their
// own, and the session is loaded once however many detectors acquire it.

import { loadOrt, createSession } from './detector'
import { pixelsToInput } from './nativeAI.js'
import { letterbox } from './framePrep.js'

export const COCO_IN = 320

let shared = null // { promise, refs }

async function build(onProgress) {
  const ort = await loadOrt()
  const { session, ep, release } = await createSession(ort, '/models/coco-yolo.onnx', onProgress)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]

  const buf = new Float32Array(3 * COCO_IN * COCO_IN)

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
      // Letterboxed off the page's thread (framePrep.js): no stall here.
      const { data: pixels, ratio, padX, padY } = await letterbox(source, { cx1: 0, cy1: 0, cw: sw, ch: sh }, COCO_IN)
      const tensor = pixelsToInput(ort, session, pixels, COCO_IN, buf)
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

  return { run, ep, session, release }
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
            r.release()
          } catch {
            /* noop */
          }
        })
        .catch(() => {})
    },
  }
}
