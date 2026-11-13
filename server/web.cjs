// Public web backend for the hosted VARUNA GCS demo (Render).
//
// The frontend is hosted on Vercel; this one process runs everything it calls
// server-side:
//   /local/*  sign-in, accounts and CSV records (electron/localData.cjs).
//             Vercel rewrites these to us, so the browser sees them same-origin.
//   /boat/*   the boat backend (boat-pi/main.py) running in --sim mode next to
//             this process, with the /boat prefix stripped. The browser calls
//             it directly (VITE_BOAT_BASE), so the live WebSocket and the video
//             stream work. FastAPI there already sends CORS headers.
//   /api, /video_feed, /stream, /tune
//             the drone. There is no drone simulator, so these answer a fast
//             plain-text 503 and the app shows the drone as offline.
//
// Nothing here can reach a real vehicle: the only target is the local simulator.
//
// The data store is written for the desktop app and only answers loopback
// callers whose Host is localhost. Rather than loosen it, it runs on an internal
// loopback port and this server forwards to it after its own origin check.

const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const httpProxy = require('http-proxy')
const { createLocalData } = require('../electron/localData.cjs')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT) || 10000
const BOAT_PORT = Number(process.env.BOAT_SIM_PORT) || 8001
const LOCAL_PORT = Number(process.env.LOCAL_DATA_PORT) || 8002
const PYTHON = process.env.PYTHON || 'python3'
const DATA_DIR = process.env.VARUNA_DATA_DIR || '/tmp/varuna-data'

// Origins allowed to call /local/* cross-site and to drive the boat sim.
// Comma-separated; '*' inside an entry matches any run of host characters, e.g.
//   https://varuna-gcs.vercel.app,https://varuna-gcs-*.vercel.app
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((s) => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*') + '$'))

const DRONE_PREFIXES = ['/api', '/video_feed', '/stream', '/tune']
const BOAT_PREFIX = '/boat'

const pathOf = (url) => String(url || '/').split('?')[0]
const under = (p, prefix) => p === prefix || p.startsWith(prefix + '/')
const originAllowed = (o) => !!o && ALLOWED.some((re) => re.test(String(o).toLowerCase()))

function refererOrigin(req) {
  try {
    return new URL(req.headers.referer).origin
  } catch {
    return ''
  }
}

/**
 * Only the GCS's own pages may use the data store: a request the browser marks
 * same-origin (it came through the Vercel rewrite, or straight from a page on
 * this host), or one whose Origin/Referer is the hosted frontend.
 */
function localCallerAllowed(req) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true
  if (req.headers.origin) return originAllowed(req.headers.origin)
  return originAllowed(refererOrigin(req))
}

// Sign-in pages opened as a top-level navigation; the store serves these
// before its own same-origin check, and so do we.
const LOCAL_PAGES = /^\/local\/auth\/(google|fingerprint)\/page(\.js)?$/

function sendText(res, status, text, extra = {}) {
  if (res.headersSent) return res.end()
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  })
  res.end(text)
}

// ---------------------------------------------------------------- boat simulator
let boatAlive = false
let boatRestarts = 0

function startBoatSim() {
  const child = spawn(PYTHON, ['main.py', '--sim', '--host', '127.0.0.1', '--port', String(BOAT_PORT)], {
    cwd: path.join(ROOT, 'boat-pi'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  boatAlive = true
  child.on('exit', (code, signal) => {
    boatAlive = false
    const wait = Math.min(30000, 2000 * 2 ** Math.min(boatRestarts, 4))
    boatRestarts += 1
    console.warn(`[boat-sim] exited (${signal || code}); restarting in ${wait / 1000}s`)
    setTimeout(startBoatSim, wait)
  })
  child.on('error', (err) => console.error(`[boat-sim] could not start ${PYTHON}: ${err.message}`))
}

// ---------------------------------------------------------------- data store
const localData = createLocalData({
  dataDir: DATA_DIR,
  seedFile: path.join(ROOT, 'public', 'config', 'rivers.json'),
})
const localServer = http.createServer((req, res) => localData.handle(req, res))
localServer.listen(LOCAL_PORT, '127.0.0.1')

// ---------------------------------------------------------------- public server
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false })

proxy.on('proxyReq', (proxyReq, req) => {
  if (req.__local) {
    // The store's checks: a loopback socket (true: we connect from 127.0.0.1),
    // Host localhost, and Sec-Fetch-Site same-origin, which localCallerAllowed
    // has already established for this request.
    proxyReq.setHeader('host', `localhost:${LOCAL_PORT}`)
    proxyReq.setHeader('sec-fetch-site', 'same-origin')
  }
})

proxy.on('error', (err, req, resOrSocket) => {
  const who = req && req.__local ? 'Data store' : 'Boat simulator'
  if (resOrSocket && typeof resOrSocket.writeHead === 'function') {
    sendText(resOrSocket, 502, `${who} unreachable (${err.code || err.message})`)
  } else if (resOrSocket && typeof resOrSocket.destroy === 'function') {
    resOrSocket.destroy()
  }
})

function stripBoat(req) {
  req.url = req.url.slice(BOAT_PREFIX.length) || '/'
  if (!req.url.startsWith('/')) req.url = '/' + req.url
}

const server = http.createServer((req, res) => {
  const p = pathOf(req.url)

  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ ok: true, boatSim: boatAlive }))
  }

  if (under(p, '/local')) {
    if (!LOCAL_PAGES.test(p) && !localCallerAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ ok: false, code: 'forbidden', error: 'Forbidden' }))
    }
    req.__local = true
    return proxy.web(req, res, { target: `http://127.0.0.1:${LOCAL_PORT}` })
  }

  if (under(p, BOAT_PREFIX)) {
    stripBoat(req)
    if (!DRONE_PREFIXES.some((x) => under(pathOf(req.url), x))) return sendText(res, 404, 'Not found')
    if (!boatAlive) return sendText(res, 502, 'Boat simulator unreachable (starting)')
    return proxy.web(req, res, { target: `http://127.0.0.1:${BOAT_PORT}` })
  }

  if (DRONE_PREFIXES.some((x) => under(p, x))) {
    // Plain text and non-2xx: src/api/client.js reads this as "Pi unreachable".
    if (req.method === 'OPTIONS') {
      return sendText(res, 204, '', {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
    }
    return sendText(res, 503, 'Drone not connected (web demo: only the boat is simulated)')
  }

  if (p === '/') return sendText(res, 200, 'VARUNA GCS web backend. Open the app on its Vercel address.')
  sendText(res, 404, 'Not found')
})

// Live telemetry and drive WebSockets: /boat/api/ws and /boat/api/drive.
server.on('upgrade', (req, socket, head) => {
  const p = pathOf(req.url)
  if (!under(p, BOAT_PREFIX) || !boatAlive) return socket.destroy()
  // Browsers send Origin on the handshake; with no allow-list configured the
  // demo accepts any page (it only reaches the simulator).
  if (ALLOWED.length && !originAllowed(req.headers.origin)) return socket.destroy()
  stripBoat(req)
  if (!under(pathOf(req.url), '/api')) return socket.destroy()
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${BOAT_PORT}` })
})

startBoatSim()
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[web] listening on :${PORT}  boat sim :${BOAT_PORT}  data ${DATA_DIR}`)
  console.log(`[web] allowed origins: ${process.env.ALLOWED_ORIGINS || '(none: same-origin only)'}`)
})
