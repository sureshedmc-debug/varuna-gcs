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
//             the drone backend (drone-pi/main.py) with no Pixhawk and a test
//             camera: screens, missions and video answer; flight commands report
//             that no flight controller is connected. The browser calls it
//             directly too (VITE_API_BASE), for its WebSockets and video.
//
// Nothing here can reach a real vehicle: both backends run inside this container.
//
// The data store is written for the desktop app and only answers loopback
// callers whose Host is localhost. Rather than loosen it, it runs on an internal
// loopback port and this server forwards to it after its own origin check.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const httpProxy = require('http-proxy')
const { createLocalData } = require('../electron/localData.cjs')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT) || 10000
const BOAT_PORT = Number(process.env.BOAT_SIM_PORT) || 8001
const LOCAL_PORT = Number(process.env.LOCAL_DATA_PORT) || 8002
const DRONE_PORT = Number(process.env.DRONE_SIM_PORT) || 8003
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

// ---------------------------------------------------------------- vehicle backends
/** Keep one Python backend running, restarting it with backoff if it exits. */
function supervise(name, dir, args) {
  const state = { alive: false, restarts: 0 }
  const start = () => {
    const child = spawn(PYTHON, ['main.py', ...args], {
      cwd: path.join(ROOT, dir),
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    state.alive = true
    child.on('exit', (code, signal) => {
      state.alive = false
      const wait = Math.min(30000, 2000 * 2 ** Math.min(state.restarts, 4))
      state.restarts += 1
      console.warn(`[${name}] exited (${signal || code}); restarting in ${wait / 1000}s`)
      setTimeout(start, wait)
    })
    child.on('error', (err) => console.error(`[${name}] could not start ${PYTHON}: ${err.message}`))
  }
  return { state, start }
}

const boat = supervise('boat-sim', 'boat-pi', ['--sim', '--host', '127.0.0.1', '--port', String(BOAT_PORT)])
// No --connection: it searches for a Pixhawk, finds none, and says so.
const drone = supervise('drone', 'drone-pi', ['--host', '127.0.0.1', '--port', String(DRONE_PORT), '--camera', 'test'])

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
  const who = req && req.__local ? 'Data store' : req && req.__boat ? 'Boat simulator' : 'Drone backend'
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
    return res.end(JSON.stringify({ ok: true, boatSim: boat.state.alive, drone: drone.state.alive }))
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
    if (!boat.state.alive) return sendText(res, 502, 'Boat simulator unreachable (starting)')
    req.__boat = true
    return proxy.web(req, res, { target: `http://127.0.0.1:${BOAT_PORT}` })
  }

  if (DRONE_PREFIXES.some((x) => under(p, x))) {
    // Plain text and non-2xx: src/api/client.js reads this as "Pi unreachable".
    if (!drone.state.alive) return sendText(res, 502, 'Drone backend unreachable (starting)')
    return proxy.web(req, res, { target: `http://127.0.0.1:${DRONE_PORT}` })
  }

  if (p === '/site/feedback') return feedback(req, res)

  if (p === '/') return sendText(res, 200, 'VARUNA GCS web backend. Open the app on its Vercel address.')
  sendText(res, 404, 'Not found')
})

// ---------------------------------------------------------------- website feedback
// POST /site/feedback  {name, email, role, rating, message} from the Explore page
//   (Vercel rewrites it to us, so it is same-origin). Each entry is appended to
//   feedback.csv in the data dir and printed to the log as one JSON line, so it
//   survives in Render's logs even after the free disk is wiped on a restart.
// GET  /site/feedback  with "Authorization: Bearer $FEEDBACK_KEY" returns the CSV.
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.csv')
const FEEDBACK_COLS = ['time', 'name', 'email', 'role', 'rating', 'message']
const feedbackHits = new Map() // ip -> [timestamps]

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const csvCell = (v) => {
  let s = String(v ?? '').replace(/\r?\n/g, ' ').trim()
  if (/^[=+\-@\t]/.test(s)) s = "'" + s // keep spreadsheet apps from running it as a formula
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function feedback(req, res) {
  if (req.method === 'GET') {
    const key = process.env.FEEDBACK_KEY
    if (!key || req.headers.authorization !== `Bearer ${key}`) return sendJson(res, 403, { ok: false, error: 'Forbidden' })
    let csv = FEEDBACK_COLS.join(',') + '\n'
    try {
      csv = fs.readFileSync(FEEDBACK_FILE, 'utf8')
    } catch {
      /* nothing yet */
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(csv)
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
  if (!localCallerAllowed(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' })

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const now = Date.now()
  const recent = (feedbackHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000)
  if (recent.length >= 5) return sendJson(res, 429, { ok: false, error: 'Too many messages. Please try again in a few minutes.' })

  let body = ''
  let tooBig = false
  req.setEncoding('utf8')
  req.on('data', (c) => {
    body += c
    if (body.length > 16 * 1024) {
      tooBig = true
      req.destroy()
    }
  })
  req.on('end', () => {
    if (tooBig) return
    let f
    try {
      f = JSON.parse(body)
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Bad request' })
    }
    const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
    const entry = {
      time: new Date().toISOString(),
      name: str(f.name, 80),
      email: str(f.email, 120),
      role: str(f.role, 40),
      rating: Math.max(0, Math.min(5, Math.round(Number(f.rating) || 0))),
      message: str(f.message, 2000),
    }
    if (!entry.message) return sendJson(res, 400, { ok: false, error: 'Please write a message.' })
    if (entry.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) return sendJson(res, 400, { ok: false, error: 'That email address does not look right.' })
    recent.push(now)
    feedbackHits.set(ip, recent)
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      if (!fs.existsSync(FEEDBACK_FILE)) fs.writeFileSync(FEEDBACK_FILE, FEEDBACK_COLS.join(',') + '\n')
      fs.appendFileSync(FEEDBACK_FILE, FEEDBACK_COLS.map((k) => csvCell(entry[k])).join(',') + '\n')
    } catch (err) {
      console.error('[feedback] could not save:', err.message)
    }
    console.log('[feedback]', JSON.stringify(entry))
    sendJson(res, 200, { ok: true })
  })
}

// Live WebSockets: the drone's /api/ws and /api/control, the boat's
// /boat/api/ws and /boat/api/drive.
server.on('upgrade', (req, socket, head) => {
  // Browsers send Origin on the handshake; with no allow-list configured the
  // demo accepts any page (it only reaches the simulators).
  if (ALLOWED.length && !originAllowed(req.headers.origin)) return socket.destroy()
  const isBoat = under(pathOf(req.url), BOAT_PREFIX)
  if (isBoat) stripBoat(req)
  const v = isBoat ? boat : drone
  if (!under(pathOf(req.url), '/api') || !v.state.alive) return socket.destroy()
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${isBoat ? BOAT_PORT : DRONE_PORT}` })
})

boat.start()
drone.start()
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[web] listening on :${PORT}  boat sim :${BOAT_PORT}  data ${DATA_DIR}`)
  console.log(`[web] allowed origins: ${process.env.ALLOWED_ORIGINS || '(none: same-origin only)'}`)
})
