// Fail fast when a Pi is off. Used by the desktop server (server.cjs) and the
// dev server (vite.config.js) on their http-proxy instances.
//
// Without this, a call to a Pi that is switched off waits for Windows to give
// up on the TCP connect (about 21 s). The app polls several Pi endpoints every
// few seconds, and Chromium allows only 6 connections to one origin, so those
// hanging calls take every slot and the app's own requests (sign-in, saving
// records, loading a screen) queue behind them. Two parts:
//  - a connect timeout, so a dead address fails in CONNECT_MS, not 21 s;
//  - after a failed connect the target is marked down for DOWN_MS, and calls
//    to it fail at once. Then one call is let through to check it again.

const CONNECT_MS = 4000 // DNS + TCP connect; a relayed Netbird handshake can take a few seconds
const DOWN_MS = 5000

// Errors that mean "nothing reachable there", not "the Pi answered badly".
const DOWN_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'])

function createProxyGuard() {
  const state = new Map() // target origin → { until, probing: when the check call started, or 0 }

  const keyOf = (target) => {
    try {
      return new URL(String(target)).origin
    } catch {
      return String(target || '')
    }
  }

  /** true → let this call through to the target; false → fail it now. */
  function allow(target) {
    const s = state.get(keyOf(target))
    if (!s) return true
    const now = Date.now()
    // A probe that ended without a verdict (the page gave up on it) stops
    // counting once its connect would have timed out anyway.
    if (now < s.until || (s.probing && now - s.probing < CONNECT_MS + 1000)) return false
    s.probing = now // one call checks whether it's back; the rest keep failing fast
    return true
  }

  function up(target) {
    state.delete(keyOf(target))
  }

  function failed(target, err) {
    if (!DOWN_CODES.has(err && err.code)) {
      const s = state.get(keyOf(target))
      if (s) s.probing = 0
      return
    }
    state.set(keyOf(target), { until: Date.now() + DOWN_MS, probing: 0 })
  }

  function downError() {
    return Object.assign(new Error('not reachable (checked moments ago)'), { code: 'EHOSTDOWN' })
  }

  /** Time out the connect of an outgoing proxy request. */
  function connectTimeout(proxyReq, target) {
    // http-proxy emits 'proxyReq' from the request's own 'socket' event (the
    // socket is already there), but 'proxyReqWs' before it has one.
    if (proxyReq.socket) watch(proxyReq.socket)
    else proxyReq.once('socket', watch)
    function watch(sock) {
      if (!sock.connecting) return // a kept-alive socket: already connected
      const t = setTimeout(() => {
        proxyReq.destroy(Object.assign(new Error(`no answer within ${CONNECT_MS / 1000} s`), { code: 'ETIMEDOUT' }))
      }, CONNECT_MS)
      sock.once('connect', () => {
        clearTimeout(t)
        up(target)
      })
      sock.once('close', () => clearTimeout(t))
    }
  }

  /**
   * Wire the guard into an http-proxy server.
   * @param {import('http-proxy')} proxy
   * @param {(req) => string} targetOf  the target this request is going to
   */
  function attach(proxy, targetOf) {
    const outgoing = (proxyReq, req) => {
      const target = targetOf(req)
      req.__guardTarget = target
      // __guardChecked: the caller already asked allow() for this request.
      if (!req.__guardChecked && !allow(target)) return proxyReq.destroy(downError())
      connectTimeout(proxyReq, target)
    }
    proxy.on('proxyReq', outgoing)
    proxy.on('proxyReqWs', outgoing)
    proxy.on('proxyRes', (_res, req) => up(req.__guardTarget || targetOf(req)))
    const onError = (err, req) => failed(req.__guardTarget || targetOf(req), err)
    proxy.on('error', onError)
    return onError
  }

  return { attach, allow, up, failed }
}

module.exports = { createProxyGuard, CONNECT_MS, DOWN_MS }
