// The desktop app's native AI engine (electron/aiEngine.cjs): the detectors run
// in their own process on the laptop's GPU (DirectML), not in this page, so the
// video, map and buttons never wait for them.
//
// nativeSession(url) gives back the same { session, ep } shape as the in-page
// worker (detector.js): session.inputNames / outputNames / run(feeds) / release().
// If the engine stops, every session reconnects and reloads its model on its
// next run. Outside the desktop app (a browser) hasNativeAI() is false and the
// page's own AI is used as before.

const CONNECT_MS = 4000
const RUN_MS = 15000

let port = null
let gen = 0 // bumps each time the engine connection is replaced
let connecting = null
let nextId = 0
const waiting = new Map() // 'c<id>' / 'r<rid>' -> { resolve, reject, timer }

export function hasNativeAI() {
  return typeof window !== 'undefined' && !!window.varuna?.nativeAI && typeof window.varuna.connectAI === 'function'
}

function dropConnection(why) {
  if (port) {
    try { port.close() } catch { /* already closed */ }
  }
  port = null
  gen++
  for (const w of waiting.values()) {
    clearTimeout(w.timer)
    w.reject(new Error(why))
  }
  waiting.clear()
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data !== 'varuna:ai-lost') return
    dropConnection('native AI engine stopped')
  })
}

function connect() {
  if (port) return Promise.resolve(port)
  if (connecting) return connecting
  connecting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onPort)
      reject(new Error('native AI engine did not answer'))
    }, CONNECT_MS)
    function onPort(e) {
      if (e.source !== window || e.data !== 'varuna:ai-port' || !e.ports?.[0]) return
      window.removeEventListener('message', onPort)
      clearTimeout(timer)
      const p = e.ports[0]
      p.onmessage = ({ data: m }) => {
        if (!m || m.op === 'hello') return
        const key = m.rid != null ? 'r' + m.rid : 'c' + m.id
        const w = waiting.get(key)
        if (!w) return
        waiting.delete(key)
        clearTimeout(w.timer)
        if (m.op === 'error') w.reject(new Error(m.message))
        else w.resolve(m)
      }
      port = p
      gen++
      resolve(p)
    }
    window.addEventListener('message', onPort)
    window.varuna.connectAI()
  }).finally(() => { connecting = null })
  return connecting
}

function ask(key, msg, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(key)
      reject(new Error('native AI engine timed out'))
    }, ms)
    waiting.set(key, { resolve, reject, timer })
    port.postMessage(msg)
  })
}

async function load(url) {
  await connect()
  const id = ++nextId
  const info = await ask('c' + id, { op: 'create', id, url }, 60000)
  return { id, gen, info }
}

// The pictures the detectors send are pixel values / 255: sent as one byte per
// value (exactly the same numbers once the engine divides by 255 again), a
// quarter of the 4.9 MB a 640 x 640 picture is as floats, so the copy between
// the processes costs the page a quarter of the time.
function packFeed(t) {
  if (t.type === 'rgba') return t // raw canvas pixels: the engine converts them
  const d = t.data
  if (t.type === 'float32' && d instanceof Float32Array && d.length >= 4096) {
    const u8 = new Uint8Array(d.length)
    for (let i = 0; i < d.length; i++) u8[i] = Math.round(d[i] * 255)
    // Spot-check that this really is /255 data; anything else goes as floats.
    let ok = true
    for (let i = 0; i < d.length && ok; i += 997) ok = Math.abs(u8[i] / 255 - d[i]) < 1e-6
    if (ok) return { type: 'u8norm', data: u8, dims: t.dims }
  }
  return { type: t.type, data: d, dims: t.dims }
}

/**
 * The model input for `data`, a size x size canvas's RGBA bytes (getImageData).
 * The native engine takes the bytes as they are and turns them into the model's
 * numbers itself, so this page does no per-pixel work at all; elsewhere they
 * become planar RGB / 255 floats in `buf`, as before.
 */
export function pixelsToInput(ort, session, data, size, buf) {
  if (session.rgba) return { type: 'rgba', data, dims: [1, 3, size, size] }
  const area = size * size
  for (let i = 0; i < area; i++) {
    buf[i] = data[i * 4] / 255
    buf[area + i] = data[i * 4 + 1] / 255
    buf[area * 2 + i] = data[i * 4 + 2] / 255
  }
  return new ort.Tensor('float32', buf, [1, 3, size, size])
}

// Speed of the last runs, for the System tab / debugging: window.varunaAIStats.
const stats = { runs: 0, avgTripMs: 0, avgGpuMs: 0 }
if (typeof window !== 'undefined') window.varunaAIStats = stats
function noteRun(trip, gpu) {
  stats.runs++
  const k = stats.runs < 10 ? 1 / stats.runs : 0.1
  stats.avgTripMs = Math.round(stats.avgTripMs + (trip - stats.avgTripMs) * k)
  if (Number.isFinite(gpu)) stats.avgGpuMs = Math.round(stats.avgGpuMs + (gpu - stats.avgGpuMs) * k)
}

/** Load the model at `url` (absolute) in the native engine: { session, ep }. */
export async function nativeSession(url) {
  let cur = await load(url)
  let released = false
  const session = {
    rgba: true, // takes a picture as raw canvas pixels (pixelsToInput)
    inputNames: cur.info.inputNames,
    outputNames: cur.info.outputNames,
    async run(feeds) {
      if (released) throw new Error('model released')
      // The engine restarted since this model was loaded: load it again there.
      if (cur.gen !== gen || !port) cur = await load(url)
      const rid = ++nextId
      const f = {}
      for (const [name, t] of Object.entries(feeds)) f[name] = packFeed(t)
      const t0 = performance.now()
      const m = await ask('r' + rid, { op: 'run', id: cur.id, rid, feeds: f }, RUN_MS)
      noteRun(performance.now() - t0, m.engineMs)
      const out = {}
      for (const [name, o] of Object.entries(m.outputs)) out[name] = { ...o, getData: async () => o.data }
      return out
    },
    release() {
      released = true
      if (port && cur.gen === gen) port.postMessage({ op: 'release', id: cur.id })
    },
  }
  return { session, ep: cur.info.ep }
}
