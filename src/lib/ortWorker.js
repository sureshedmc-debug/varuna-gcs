// Runs the ONNX detectors off the main thread.
//
// On WebGPU, onnxruntime-web dispatches every layer of the network from
// JavaScript, so one detection kept the page's main thread busy for 60-90 ms:
// the video, the map and every button stuttered while the AI ran (measured on
// the Live tab: ~25 such stalls every 4 s, the screen down to ~35 fps). Here
// that work happens in a worker and the page only posts the input in and gets
// the boxes' raw output back.
//
// Messages in:  { op: 'create', id, url } | { op: 'run', id, rid, feeds } | { op: 'release', id }
// Messages out: { op: 'created', id, ep, inputNames, outputNames } | { op: 'error', id, rid?, message }
//               { op: 'result', rid, outputs: { name: { data, dims, type } } }

let ortPromise = null
function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/webgpu').then((ort) => {
      ort.env.wasm.wasmPaths = '/ort/'
      ort.env.wasm.numThreads = 1
      ort.env.wasm.simd = true
      return ort
    })
  }
  return ortPromise
}

// Same guards as the main-thread path in detector.js: probe for a real GPU
// adapter first, and after one WebGPU failure stay on the CPU, because a
// half-built WebGPU session can poison the shared runtime for every model.
let adapterOk = null
let webgpuFailed = false
async function webgpuUsable() {
  if (webgpuFailed) return false
  if (adapterOk !== null) return adapterOk
  adapterOk = false
  try {
    if (self.navigator?.gpu) adapterOk = !!(await self.navigator.gpu.requestAdapter())
  } catch {
    adapterOk = false
  }
  return adapterOk
}

// Session creates must not overlap (onnxruntime's lazy WASM init races).
let chain = Promise.resolve()
function serialized(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

const sessions = new Map() // id -> session

async function create(url) {
  const ort = await loadOrt()
  return serialized(async () => {
    const opts = { graphOptimizationLevel: 'all' }
    if (await webgpuUsable()) {
      try {
        return { session: await ort.InferenceSession.create(url, { ...opts, executionProviders: ['webgpu'] }), ep: 'webgpu' }
      } catch (e) {
        console.warn('[ort worker] WebGPU unavailable, using CPU:', e?.message ?? e)
        webgpuFailed = true
      }
    }
    return { session: await ort.InferenceSession.create(url, { ...opts, executionProviders: ['wasm'] }), ep: 'wasm' }
  })
}

self.onmessage = async ({ data: msg }) => {
  if (msg.op === 'create') {
    try {
      const { session, ep } = await create(msg.url)
      sessions.set(msg.id, session)
      self.postMessage({ op: 'created', id: msg.id, ep, inputNames: session.inputNames, outputNames: session.outputNames })
    } catch (e) {
      self.postMessage({ op: 'error', id: msg.id, message: String(e?.message ?? e) })
    }
  } else if (msg.op === 'run') {
    try {
      const ort = await loadOrt()
      const session = sessions.get(msg.id)
      if (!session) throw new Error('model released')
      const feeds = {}
      for (const [name, t] of Object.entries(msg.feeds)) feeds[name] = new ort.Tensor(t.type, t.data, t.dims)
      const result = await session.run(feeds)
      const outputs = {}
      const transfer = []
      for (const [name, t] of Object.entries(result)) {
        const d = t.getData ? await t.getData() : t.data
        outputs[name] = { data: d, dims: t.dims, type: t.type }
        if (d?.buffer && !transfer.includes(d.buffer)) transfer.push(d.buffer)
      }
      self.postMessage({ op: 'result', rid: msg.rid, outputs }, transfer)
    } catch (e) {
      self.postMessage({ op: 'error', id: msg.id, rid: msg.rid, message: String(e?.message ?? e) })
    }
  } else if (msg.op === 'release') {
    const s = sessions.get(msg.id)
    sessions.delete(msg.id)
    try { await s?.release?.() } catch { /* already gone */ }
  }
}
