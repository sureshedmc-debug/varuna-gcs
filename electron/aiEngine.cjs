// VARUNA native AI engine (desktop app only).
//
// Runs the ONNX detectors in their own process with onnxruntime-node, so the
// app's window only sends each picture in and gets the boxes' raw output back:
// the video, the map and the buttons never wait for the AI.
//
// GPU or CPU, per model, by measurement. On the Intel Iris Xe (2026-11-28)
// DirectML was not better across the board:
//   plastic_v3 (YOLO26n, 640)  GPU   37 ms   CPU 243 ms
//   coco-yolo (320)            GPU   57 ms   CPU  33 ms
//   face-yolo (320)            GPU   95 ms   CPU  37 ms
//   plastic (YOLO11s, 640)     GPU  645 ms (93 s to build!)   CPU 317 ms
// So every model starts on the CPU at once (it builds in under a second), and
// once it has seen a real picture the engine builds it on the GPU in the
// background, times both and keeps the faster one. The choice is remembered
// (ai-engine-choices.json in the app's data folder), so later starts load the
// winner straight away and never try again.
//
// Started by main.cjs with utilityProcess.fork. The window talks to it over a
// MessagePort that main.cjs hands to both sides, with the same messages as the
// in-page worker (src/lib/ortWorker.js):
//   in : { op: 'create', id, url } | { op: 'run', id, rid, feeds } | { op: 'release', id }
//   out: { op: 'created', id, ep, inputNames, outputNames } | { op: 'error', id, rid?, message }
//        { op: 'result', rid, outputs: { name: { data, dims, type } }, engineMs }

const fs = require('node:fs')
const path = require('node:path')

let ort = null
let loadError = null
try {
  ort = require('onnxruntime-node')
} catch (e) {
  loadError = String(e && e.message ? e.message : e)
}
console.log(`[ai engine] runtime ${ort ? 'loaded' : 'FAILED: ' + loadError}`)

const GPU_OK = process.platform === 'win32' // DirectML ships in the Windows build only
// Half the laptop's threads: the other half keep the window, video and map smooth.
const CPU_OPTS = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 4, interOpNumThreads: 1 }
// DirectML wants no memory pattern and sequential execution.
const GPU_OPTS = { executionProviders: ['dml'], graphOptimizationLevel: 'all', enableMemPattern: false, executionMode: 'sequential' }
const GPU_BUILD_MAX_MS = 30000 // slower to build than this: not worth it on every start
const GPU_MUST_BEAT = 0.8 // the GPU is kept only if at least 20 % faster
// Bigger models aren't tried on the GPU: YOLO11s (38 MB) took 93 s to build
// there, with the laptop crawling meanwhile, and then ran slower than the CPU.
const GPU_TRY_MAX_BYTES = 20e6

// ── Remembered choices: "<model file>:<bytes>" -> 'gpu' | 'cpu' ───────────────
const CHOICE_FILE = process.argv[2] || ''
let choices = {}
try {
  if (CHOICE_FILE) choices = JSON.parse(fs.readFileSync(CHOICE_FILE, 'utf8')) || {}
} catch { choices = {} }
function remember(key, choice) {
  choices[key] = choice
  if (!CHOICE_FILE) return
  try {
    fs.mkdirSync(path.dirname(CHOICE_FILE), { recursive: true })
    fs.writeFileSync(CHOICE_FILE, JSON.stringify(choices, null, 2))
  } catch (e) {
    console.warn('[ai engine] could not save the GPU/CPU choice:', e.message)
  }
}

// One model run at a time across all models, in order.
let chain = Promise.resolve()
function queued(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

async function readModel(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`model ${url}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** A model, ready to run: { session, ep, key, trial (bytes for a GPU try, or null) }. */
async function create(url) {
  if (!ort) throw new Error('native AI not available: ' + loadError)
  const bytes = await readModel(url)
  const key = `${url.split('/').pop().split('?')[0]}:${bytes.length}`
  const choice = choices[key]
  if (GPU_OK && choice === 'gpu') {
    try {
      const session = await queued(() => ort.InferenceSession.create(bytes, GPU_OPTS))
      console.log(`[ai engine] ${key} on the GPU (remembered)`)
      return { session, ep: 'native-gpu', key, trial: null }
    } catch (e) {
      console.warn(`[ai engine] ${key}: the GPU failed (${e.message}), using the CPU`)
      remember(key, 'cpu')
    }
  }
  const session = await queued(() => ort.InferenceSession.create(bytes, CPU_OPTS))
  console.log(`[ai engine] ${key} on the CPU${choice ? ' (remembered)' : ''}`)
  const tryIt = GPU_OK && !choice && bytes.length <= GPU_TRY_MAX_BYTES
  if (GPU_OK && !choice && !tryIt) remember(key, 'cpu')
  return { session, ep: 'native-cpu', key, trial: tryIt ? bytes : null }
}

// ── The GPU try: one model at a time, in the background ──────────────────────
let trying = false
async function timeRuns(session, feeds, n) {
  await session.run(feeds) // warm-up
  const t0 = performance.now()
  for (let i = 0; i < n; i++) await session.run(feeds)
  return (performance.now() - t0) / n
}

async function tryGpu(entry, feeds) {
  if (trying || !entry.trial) return
  trying = true
  const bytes = entry.trial
  entry.trial = null
  const key = entry.key
  let gpu = null
  try {
    const t0 = performance.now()
    gpu = await ort.InferenceSession.create(bytes, GPU_OPTS) // builds while the CPU copy keeps running
    const buildMs = performance.now() - t0
    if (buildMs > GPU_BUILD_MAX_MS) {
      console.log(`[ai engine] ${key}: the GPU took ${Math.round(buildMs / 1000)} s to build - staying on the CPU`)
      remember(key, 'cpu')
      return
    }
    const [g, c] = await queued(async () => [await timeRuns(gpu, feeds, 5), await timeRuns(entry.session, feeds, 5)])
    if (g < c * GPU_MUST_BEAT) {
      const old = entry.session
      entry.session = gpu
      entry.ep = 'native-gpu'
      gpu = null
      old.release().catch(() => {})
      remember(key, 'gpu')
      console.log(`[ai engine] ${key}: GPU ${Math.round(g)} ms vs CPU ${Math.round(c)} ms - switched to the GPU`)
    } else {
      remember(key, 'cpu')
      console.log(`[ai engine] ${key}: GPU ${Math.round(g)} ms vs CPU ${Math.round(c)} ms - staying on the CPU`)
    }
  } catch (e) {
    remember(key, 'cpu')
    console.warn(`[ai engine] ${key}: the GPU failed (${e.message}) - staying on the CPU`)
  } finally {
    // Not through the queue: freeing a GPU copy can take a while, and the
    // models in use must keep running meanwhile.
    if (gpu) gpu.release().catch(() => {})
    trying = false
  }
}

// ── Pictures in ──────────────────────────────────────────────────────────────
const U8_TO_F = new Float32Array(256).map((_, i) => i / 255)
// 'rgba': a canvas's RGBA bytes (nativeAI.js pixelsToInput): to planar RGB / 255.
// 'u8norm': planar values already / 255, sent as bytes (nativeAI.js packFeed).
function toTensor(t) {
  if (t.type === 'rgba') {
    const [, , h, w] = t.dims
    const area = h * w, src = t.data
    const f = new Float32Array(3 * area)
    for (let i = 0, j = 0; i < area; i++, j += 4) {
      f[i] = U8_TO_F[src[j]]
      f[area + i] = U8_TO_F[src[j + 1]]
      f[2 * area + i] = U8_TO_F[src[j + 2]]
    }
    return new ort.Tensor('float32', f, t.dims)
  }
  if (t.type === 'u8norm') {
    const f = new Float32Array(t.data.length)
    for (let i = 0; i < f.length; i++) f[i] = U8_TO_F[t.data[i]]
    return new ort.Tensor('float32', f, t.dims)
  }
  return new ort.Tensor(t.type, t.data, t.dims)
}

const errText = (e) => String(e && e.message ? e.message : e)

function onMessage(port, sessions, msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.op === 'create') {
    create(msg.url).then(
      (entry) => {
        sessions.set(msg.id, entry)
        port.postMessage({ op: 'created', id: msg.id, ep: entry.ep, inputNames: entry.session.inputNames, outputNames: entry.session.outputNames })
      },
      (e) => port.postMessage({ op: 'error', id: msg.id, message: errText(e) }),
    )
  } else if (msg.op === 'run') {
    const entry = sessions.get(msg.id)
    if (!entry) {
      port.postMessage({ op: 'error', id: msg.id, rid: msg.rid, message: 'model released' })
      return
    }
    let feeds = null
    queued(async () => {
      feeds = {}
      for (const [name, t] of Object.entries(msg.feeds)) feeds[name] = toTensor(t)
      const t0 = performance.now()
      const result = await entry.session.run(feeds)
      const ms = performance.now() - t0
      const outputs = {}
      for (const [name, t] of Object.entries(result)) outputs[name] = { data: t.data, dims: t.dims, type: t.type }
      return { outputs, ms }
    }).then(
      ({ outputs, ms }) => {
        port.postMessage({ op: 'result', rid: msg.rid, outputs, engineMs: Math.round(ms) })
        if (entry.trial && !trying) tryGpu(entry, feeds) // a real picture to time the GPU with
      },
      (e) => port.postMessage({ op: 'error', id: msg.id, rid: msg.rid, message: errText(e) }),
    )
  } else if (msg.op === 'release') {
    const entry = sessions.get(msg.id)
    sessions.delete(msg.id)
    if (entry) {
      entry.trial = null
      queued(async () => { try { await entry.session.release() } catch { /* already gone */ } })
    }
  }
}

// main.cjs sends { type: 'port' } with a MessagePort for each window (a reload
// gets a fresh one). Each port has its own models (ids restart on a reload).
process.parentPort.on('message', (e) => {
  if (!e.data || e.data.type !== 'port' || !e.ports || !e.ports[0]) return
  const port = e.ports[0]
  const sessions = new Map() // this window's models: id -> entry
  port.on('message', (m) => onMessage(port, sessions, m.data))
  // The window closed or reloaded: free its models.
  port.on('close', () => {
    for (const entry of sessions.values()) {
      entry.trial = null
      queued(async () => { try { await entry.session.release() } catch { /* gone */ } })
    }
    sessions.clear()
  })
  port.start()
  port.postMessage({ op: 'hello', ready: !!ort, error: loadError })
})
