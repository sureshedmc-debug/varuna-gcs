// Loopback HTTP server for the desktop app: serves the built frontend (dist/)
// and proxies the backend paths to the Pi's Netbird address.
//
// Why loopback http instead of file:// or a custom protocol:
//  - the detectors load /models/*.onnx and ONNX Runtime loads /ort/*.wasm by
//    absolute path, which only resolves against a real http origin;
//  - getUserMedia (webcam + mic) needs a secure context, and Chromium treats
//    127.0.0.1 as secure even over plain http;
//  - the Pi is plain http over Netbird, and an http page calling http is not
//    mixed content (a secure custom scheme would get those calls blocked).
// Proxying keeps every Pi call same-origin, so no CORS is needed on the Pi —
// the same job vite.config.js's proxy does in `npm run dev`.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const httpProxy = require('http-proxy')

// Same prefixes vite.config.js proxies.
const PROXY_PREFIXES = ['/api', '/video_feed', '/stream', '/tune']

// .wasm MUST be application/wasm or ONNX Runtime refuses to instantiate it.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
}

function isProxied(pathname) {
  return PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

function pathOf(url) {
  return String(url || '/').split('?')[0]
}

/**
 * Only this app's own pages may drive the Pi through the proxy. Without this,
 * any website open in the operator's normal browser could POST to
 * http://127.0.0.1:<port>/api/mavlink/land (a "simple" cross-site request needs
 * no CORS preflight) and command the real aircraft.
 *
 * `Sec-Fetch-Site: same-origin` is REQUIRED, not merely checked when present:
 * the renderer always sends it, so demanding it also turns away callers that
 * send no browser headers at all (a script poking at localhost ports).
 * Note this cannot be used for WebSocket upgrades — browsers don't send
 * Sec-Fetch-* on the handshake — so those are checked by Origin instead.
 */
function allowedCaller(req, ownOrigins) {
  // DNS-rebinding guard: a hostile domain resolving to 127.0.0.1 still carries
  // its own name in Host.
  if (!ownOrigins.hosts.has(String(req.headers.host || '').toLowerCase())) return false
  const origin = req.headers.origin
  if (origin && !ownOrigins.origins.has(origin.toLowerCase())) return false
  return req.headers['sec-fetch-site'] === 'same-origin'
}

/** WebSocket handshakes carry Origin but no Sec-Fetch-* headers. */
function allowedUpgrade(req, ownOrigins) {
  if (!ownOrigins.hosts.has(String(req.headers.host || '').toLowerCase())) return false
  return ownOrigins.origins.has(String(req.headers.origin || '').toLowerCase())
}

function sendText(res, status, text) {
  if (res.headersSent) return res.end()
  // Plain text, no `success` key, non-2xx: the client (src/api/client.js) turns
  // this into `_httpError`, which is exactly how "Pi unreachable" is detected
  // (SystemContext.jsx) and how commands know they failed (commands.js). A JSON
  // body with a `success` field would make a dead Pi look reachable.
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

function serveStatic(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed')

  let pathname
  try {
    pathname = decodeURIComponent(pathOf(req.url))
  } catch {
    return sendText(res, 400, 'Bad request')
  }
  // A NUL makes fs.stat throw *synchronously* even in callback form, which would
  // escape this handler and leave the socket open forever — a page could leak
  // sockets until the app stops serving by looping fetch('/%00').
  if (pathname.includes('\0')) return sendText(res, 400, 'Bad request')

  let file = path.join(root, pathname)
  if (file !== root && !file.startsWith(root + path.sep)) return sendText(res, 403, 'Forbidden')

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html')
      return fs.stat(file, (e2, st2) => (e2 || !st2.isFile() ? fallback() : send(st2)))
    }
    if (err || !st.isFile()) return fallback()
    send(st)
  })

  // Unknown extension-less paths get the app shell; a missing asset stays a 404
  // so a broken model/wasm URL fails loudly instead of returning HTML.
  function fallback() {
    if (path.extname(pathname)) return sendText(res, 404, 'Not found')
    file = path.join(root, 'index.html')
    fs.stat(file, (e, st) => (e ? sendText(res, 404, 'Not found') : send(st)))
  }

  function send(st) {
    const ext = path.extname(file).toLowerCase()
    const hashedAsset = pathname.startsWith('/assets/')
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      // Electron injects a CSP with frame-ancestors, but that only covers this
      // app's own window. Without this header a page in the operator's ordinary
      // browser could iframe the GCS and bait clicks onto ARM / LAND (the
      // clicks would then be same-origin and pass allowedCaller).
      'X-Frame-Options': 'DENY',
      // Vite fingerprints /assets/*, so those never change. Everything else
      // (index.html, models, wasm) revalidates, so an app update is picked up.
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    }
    const since = req.headers['if-modified-since']
    if (!hashedAsset && since && new Date(since).getTime() >= Math.floor(st.mtimeMs / 1000) * 1000) {
      res.writeHead(304, { 'Last-Modified': headers['Last-Modified'], 'Cache-Control': headers['Cache-Control'] })
      return res.end()
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    const stream = fs.createReadStream(file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}

/**
 * @param {object} o
 * @param {string} o.root  absolute path to the built frontend (dist/)
 * @param {number} o.preferredPort
 * @param {() => string} o.getTarget  current Pi base URL ('' = not configured);
 *   read per request so a new address applies without restarting.
 * @returns {Promise<{server: import('http').Server, port: number}>}
 */
function startServer({ root, preferredPort, getTarget }) {
  root = path.resolve(root)
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true })
  let ownOrigins = { hosts: new Set(), origins: new Set() }

  proxy.on('error', (err, _req, resOrSocket) => {
    if (resOrSocket && typeof resOrSocket.writeHead === 'function') {
      sendText(resOrSocket, 502, `Pi unreachable (${err.code || err.message})`)
    } else if (resOrSocket && typeof resOrSocket.destroy === 'function') {
      resOrSocket.destroy()
    }
  })

  const server = http.createServer((req, res) => {
    const pathname = pathOf(req.url)
    if (!ownOrigins.hosts.has(String(req.headers.host || '').toLowerCase())) {
      return sendText(res, 403, 'Forbidden')
    }
    if (isProxied(pathname)) {
      if (!allowedCaller(req, ownOrigins)) return sendText(res, 403, 'Forbidden')
      const target = getTarget()
      if (!target) return sendText(res, 503, 'Pi address not set (System → Connection)')
      return proxy.web(req, res, { target })
    }
    serveStatic(root, req, res)
  })

  // The telemetry WebSocket (/api/ws).
  server.on('upgrade', (req, socket, head) => {
    const target = getTarget()
    if (!isProxied(pathOf(req.url)) || !target || !allowedUpgrade(req, ownOrigins)) {
      return socket.destroy()
    }
    proxy.ws(req, socket, head, { target })
  })

  return new Promise((resolve, reject) => {
    let port = preferredPort
    const maxPort = preferredPort + 20
    server.on('error', (err) => {
      // Any unrelated process can hold the port. Falling back keeps the app
      // usable, but it changes the origin — main.cjs warns the operator,
      // because settings and logs live in origin-scoped localStorage.
      if (err.code === 'EADDRINUSE' && port < maxPort) {
        port += 1
        server.listen(port, '127.0.0.1')
      } else {
        reject(err)
      }
    })
    server.on('listening', () => {
      const actual = server.address().port
      ownOrigins = {
        hosts: new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]),
        origins: new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]),
      }
      resolve({ server, port: actual })
    })
    // 127.0.0.1 only — never reachable from the LAN.
    server.listen(port, '127.0.0.1')
  })
}

module.exports = { startServer }
