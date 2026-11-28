// VARUNA API client.
//
// The drone's Raspberry Pi (FastAPI backend) is reached over Tailscale — a
// private WireGuard mesh. The Pi has a stable private address on it, e.g.
// http://varuna-drone:8000 (MagicDNS name) or http://100.x.x.x:8000, reachable
// only from devices logged in to the same Tailscale account. WireGuard encrypts the link
// itself, so plain http:// is expected here; there is no TLS cert to manage.
//
// The API base URL is CONFIGURABLE and resolved at runtime, so the same build
// can point anywhere without a rebuild:
//   1. localStorage 'varuna.apiBase'  (set from System → Connection, or console)
//   2. build-time VITE_API_BASE       (optional)
//   3. DEFAULT_API_BASE below         ('' = same-origin)
//
// DEFAULT is same-origin on purpose: in dev/preview the Vite proxy forwards
// /api, /video_feed, /stream and /tune to VITE_DEV_API_TARGET (the Tailscale
// address) server-side, so the browser only ever talks to http://localhost.
// That means no CORS, and no mixed-content blocking. Pointing the base straight
// at the Pi also works, but then the backend must send CORS headers.

export const DEFAULT_API_BASE = ''

function trimSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '')
}

/**
 * A typed or saved backend address made usable: spaces and trailing slashes
 * removed, "host:port" given http://. '' means same-origin (the Vite proxy).
 * null means it can't be an address at all, and is ignored. A stray space in a
 * saved " http://localhost:8000 " used to break every request, the video too.
 */
export function cleanBase(s) {
  let b = trimSlash(s)
  if (!b) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(b)) b = 'http://' + b
  try {
    const u = new URL(b)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null
    return trimSlash(u.origin + u.pathname)
  } catch {
    return null
  }
}

// Repair a saved address once, on load: cleaned in place, or dropped when it
// can't be one (then the page's own server, the Vite proxy, is used).
try {
  const raw = localStorage.getItem('varuna.apiBase')
  if (raw !== null) {
    const c = cleanBase(raw)
    if (c === null) {
      localStorage.removeItem('varuna.apiBase')
      console.warn('[api] the saved backend address was not a valid address; using this page\'s server')
    } else if (c !== raw) {
      localStorage.setItem('varuna.apiBase', c)
    }
  }
} catch {
  /* private mode */
}

// The link used to be an ngrok tunnel, whose URL was cached in localStorage.
// localStorage outranks every other source below, so a stale ngrok base would
// silently keep the app pointed at a dead tunnel. Drop it once, on load.
try {
  if (/ngrok/i.test(localStorage.getItem('varuna.apiBase') || '')) {
    localStorage.removeItem('varuna.apiBase')
  }
} catch {
  /* private mode */
}

// A saved address can outlive the machine it named (the drone's Pi, before the
// backend moved to the laptop). When it stops answering but the page's own
// server reaches a backend (the Vite proxy, the desktop app), use that for the
// rest of this visit, so the live video doesn't hang on a dead address.
let savedBaseDead = false
let sameOriginCheck = null
// A Pi on weak Wi-Fi answers some calls only after a few seconds (TCP waits
// 1, 2, 4 s to resend a lost packet). That is slow, not dead: it takes this
// many unanswered pings in a row, each given PING_TIMEOUT_MS, before the saved
// address is given up — and while given up, it is pinged now and then and
// used again the moment it answers.
const PING_TIMEOUT_MS = 6000
const DEAD_AFTER_PINGS = 3
const RECHECK_DEAD_MS = 10000
let pingStrikes = 0
let recheckTimer = null

function pingAnswers(base) {
  return fetch(`${base}/api/ping`, { cache: 'no-store', signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
    .then((r) => r.ok)
    .catch(() => false)
}

/** Ping the saved address; true once it has failed DEAD_AFTER_PINGS times in a row. */
async function savedBaseGone(base) {
  if (await pingAnswers(base)) {
    pingStrikes = 0
    return false
  }
  return ++pingStrikes >= DEAD_AFTER_PINGS
}

function watchSavedBase(base) {
  if (recheckTimer) return
  recheckTimer = setInterval(async () => {
    if (!savedBaseDead) { clearInterval(recheckTimer); recheckTimer = null; return }
    if (await pingAnswers(base)) {
      savedBaseDead = false
      sameOriginCheck = null
      pingStrikes = 0
      clearInterval(recheckTimer)
      recheckTimer = null
      console.info('[api] the saved backend address answers again; using it')
    }
  }, RECHECK_DEAD_MS)
}

function sameOriginAnswers() {
  if (!sameOriginCheck) {
    sameOriginCheck = fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!r.ok) return false
        const j = JSON.parse(await r.text()) // a web page here is not the API
        return !!j && typeof j === 'object'
      })
      .catch(() => false)
      .then((ok) => {
        if (ok) {
          savedBaseDead = true
          console.warn('[api] the saved backend address is not answering; using this page\'s server instead')
        } else {
          sameOriginCheck = null // try again on a later failure
        }
        return ok
      })
  }
  return sameOriginCheck
}

export function getApiBase() {
  try {
    const raw = localStorage.getItem('varuna.apiBase')
    const o = raw === null ? null : cleanBase(raw)
    if (o !== null && !(savedBaseDead && o)) return o // '' allowed → same-origin
  } catch {
    /* private mode */
  }
  if (savedBaseDead) return ''
  if (import.meta.env && import.meta.env.VITE_API_BASE !== undefined) {
    return trimSlash(import.meta.env.VITE_API_BASE)
  }
  return trimSlash(DEFAULT_API_BASE)
}

export function setApiBase(v) {
  try {
    const c = cleanBase(v)
    if (c === null) localStorage.removeItem('varuna.apiBase')
    else localStorage.setItem('varuna.apiBase', c)
  } catch {
    /* private mode */
  }
}

function url(path) {
  return getApiBase() + path
}

/**
 * Low-level JSON fetch. Returns parsed JSON.
 * Note: the backend returns HTTP 200 with {success:false, message} on logical
 * failure for mutating calls — callers MUST inspect `success`, not HTTP status.
 */
async function request(path, opts) {
  const base = getApiBase()
  try {
    return await requestUrl(base + path, opts)
  } catch (e) {
    // Only a saved cross-origin address that can't be reached falls back; a
    // caller cancelling its own request does not.
    if (!/^https?:\/\//i.test(base) || opts?.signal?.aborted) throw e
    // One slow or failed call doesn't make the address dead: only when its
    // ping goes unanswered several times in a row (savedBaseGone).
    if (savedBaseDead === false && !(await savedBaseGone(base))) throw e
    if (!(await sameOriginAnswers())) throw e
    watchSavedBase(base)
    return requestUrl(path, opts)
  }
}

/** Same as request(), for a full URL — the boat client (boatClient.js) uses it. */
export async function requestUrl(fullUrl, { method = 'GET', body, signal, timeout = 12000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  const onAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onAbort)
  try {
    // No custom headers on reads: a custom header forces a CORS preflight
    // (OPTIONS) before every single request. Content-Type on a body is enough.
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    const res = await fetch(fullUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { _raw: text }
    }
    if (!res.ok && data && typeof data === 'object' && !('success' in data)) {
      data._httpError = res.status
    } else if (res.ok && data && data._raw !== undefined && /^\s*<(!doctype|html)/i.test(text)) {
      // A web page came back where the Pi sends JSON, so something other than
      // the Pi answered — e.g. the address points at a router admin page, or at
      // a server that returns its index page with a 200 for unknown paths.
      // Without this, a wrong address reads as "reachable" and flight commands
      // report success.
      data._httpError = 'html'
      // Consumers render `message` in a toast; without this they'd show the
      // literal "HTTP html" (see commands.js).
      data.message = 'That address answered with a web page, not the VARUNA API.'
    }
    return data
  } finally {
    clearTimeout(t)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

export const api = {
  raw: request,

  // --- Liveness / health ---
  // 8s, not 5s: Tailscale's first WireGuard handshake can be slow when it falls
  // back to a DERP relay instead of direct P2P. A ping failure before any successful
  // contact drops the whole app into the simulator (SystemContext.jsx), i.e.
  // fake telemetry for a real, connected drone.
  ping: () => request('/api/ping', { timeout: 8000 }),
  health: () => request('/api/health'),
  systemStatus: () => request('/api/system/status'),
  piMetrics: () => request('/api/system/pi?processes=true'),

  // --- Camera ---
  cameraStatus: () => request('/api/camera/status'),
  // snapshot & stream are <img> URLs, not fetched here (absolute, so the browser
  // loads them cross-origin directly from the configured backend):
  streamUrl: () => url('/video_feed'),
  // H.264 frames for the WebCodecs player (lib/h264Stream.js), when the camera module sends them:
  h264Url: () => url('/api/camera/h264'),
  snapshotUrl: () => url(`/api/camera/snapshot?t=${Date.now()}`),

  // --- AI ---
  aiStatus: () => request('/api/ai/status'),
  aiToggle: (enabled) =>
    request('/api/ai/toggle', { method: 'POST', body: { enabled } }),
  aiDetections: (limit = 50) => request(`/api/ai/detections?limit=${limit}`),
  aiClasses: () => request('/api/ai/classes'),
  aiReport: (debrisType) =>
    request('/api/ai/report', { method: 'POST', body: { debrisType } }),

  // --- Telemetry ---
  telemetry: () => request('/api/telemetry'),
  telemetryHistory: (limit = 200) =>
    request(`/api/telemetry/history?limit=${limit}`),
  // The phone on the drone (VARUNA Cam) as its GPS: make where it is now the take-off point.
  phoneSetHome: () => request('/api/phone/home', { method: 'POST' }),

  // --- Flight control (mavlink) ---
  arm: (arm) =>
    request('/api/mavlink/arm', { method: 'POST', body: arm === undefined ? {} : { arm } }),
  setMode: (mode) => request('/api/mavlink/mode', { method: 'POST', body: { mode } }),
  takeoff: (altitude) =>
    request('/api/mavlink/takeoff', { method: 'POST', body: { altitude } }),
  rtl: () => request('/api/mavlink/rtl', { method: 'POST' }),
  // Keyboard flight (Control tab): GUIDED, holding position / back to LOITER.
  controlTake: () => request('/api/control/take', { method: 'POST', timeout: 15000 }),
  controlRelease: () => request('/api/control/release', { method: 'POST', timeout: 15000 }),
  land: () => request('/api/mavlink/land', { method: 'POST' }),
  // Emergency stop: abort any running mission and land at the current position.
  // Switching the flight controller into LAND overrides AUTO/mission mode. Tries
  // the land command first; if it errors or is rejected, forces LAND via a mode
  // change (ArduPilot mode name). Uses only the existing land + mode endpoints.
  emergencyStop: async () => {
    try {
      const r = await request('/api/mavlink/land', { method: 'POST' })
      if (r && r.success !== false && !r._httpError) return r
    } catch {
      /* fall through to the mode change */
    }
    return request('/api/mavlink/mode', { method: 'POST', body: { mode: 'LAND' } })
  },
  mavlinkStatus: () => request('/api/mavlink/status'),
  getPrefer: () => request('/api/mavlink/prefer'),
  setPrefer: (mode) => request('/api/mavlink/prefer', { method: 'POST', body: { mode } }),

  // --- Missions ---
  // Upload waits for every item over the telemetry link (the Pi allows 30 s);
  // Start switches to GUIDED, arms, then switches to AUTO, each waiting for the
  // Pixhawk to confirm. A shorter timeout here would report "failed" while the
  // drone is in fact taking off.
  missionUpload: (name, waypoints) =>
    request('/api/mission/upload', { method: 'POST', body: { name, waypoints }, timeout: 40000 }),
  missionStart: () => request('/api/mission/start', { method: 'POST', timeout: 25000 }),
  missionList: () => request('/api/mission/list'),

  // --- Live config / tuning ---
  getConfig: () => request('/api/config'),
  setConfig: (patch) => request('/api/config', { method: 'POST', body: patch }),
  saveConfig: () => request('/api/config/save', { method: 'POST' }),

  // --- Auth ---
  verifyPin: (password) =>
    request('/api/auth/verify_pin', { method: 'POST', body: { password } }),
}

// WebSocket URL for live push. Follows the configured API base — ws:// for a
// plain-http Tailscale address, wss:// if the base is ever https — and falls back
// to same-origin (the Vite proxy in dev/preview) when no base is configured.
export function wsUrl() {
  const base = getApiBase()
  if (base) return base.replace(/^http/i, 'ws') + '/api/ws'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/ws`
}

/** The Control tab's keyboard socket (keys → drone), next to the telemetry one. */
export function controlWsUrl() {
  return wsUrl().replace(/\/api\/ws$/, '/api/control')
}

/**
 * Diagnose the link, for System → Connection. Tailscale has more distinct failure
 * modes than a public tunnel did (peer offline, laptop not joined to the mesh,
 * FastAPI bound to loopback) and the browser collapses nearly all of them into
 * one opaque "Failed to fetch". This narrows it down: a `no-cors` retry that
 * succeeds proves the Pi IS reachable and the real problem is missing CORS.
 *
 * @param base optional base to test before saving it; omit to test the live one.
 * @returns {Promise<{ok: boolean, ms?: number, title: string, detail: string}>}
 */
export async function testConnection(base) {
  const b = base === undefined ? getApiBase() : (cleanBase(base) ?? trimSlash(base))
  const target = (b || '') + '/api/ping'
  const crossOrigin = /^https?:\/\//i.test(b)

  if (crossOrigin && window.location.protocol === 'https:' && /^http:\/\//i.test(b)) {
    return {
      ok: false,
      title: 'Blocked by the browser',
      detail:
        'This page is served over https, so it may not call a plain http:// address. ' +
        'Open the GCS over plain http instead (npm run dev), or clear this field to go through the Vite proxy.',
    }
  }

  const t0 = Date.now()
  try {
    const res = await fetch(target, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    const ms = Date.now() - t0
    if (!res.ok) {
      return {
        ok: false,
        ms,
        title: `Backend answered HTTP ${res.status}`,
        detail: 'The Pi was reached, but /api/ping did not return 200 — check the FastAPI service.',
      }
    }
    if (/^\s*<(!doctype|html)/i.test(await res.text())) {
      return {
        ok: false,
        ms,
        title: 'That address is not the Pi',
        detail: "A web page answered instead of the Pi's API. Enter the drone Pi's Tailscale address, e.g. http://varuna-drone:8000",
      }
    }
    return { ok: true, ms, title: 'Connected', detail: `/api/ping answered in ${ms} ms.` }
  } catch (err) {
    const ms = Date.now() - t0
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')

    if (!timedOut && crossOrigin) {
      try {
        await fetch(target, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) })
        return {
          ok: false,
          ms,
          title: 'Reachable, but CORS is blocking it',
          detail:
            'The Pi answered, but without CORS headers the browser throws the response away. ' +
            'Either enable CORS for this origin in FastAPI, or clear this field to go through the Vite proxy.',
        }
      } catch {
        /* genuinely unreachable — fall through to the message below */
      }
    }

    return {
      ok: false,
      ms,
      title: timedOut ? 'Timed out' : 'Could not reach the Pi',
      detail:
        'Check that the Pi shows as Connected in Tailscale (`tailscale status`), that this laptop is ' +
        'logged in to the same Tailscale account, that the address is correct, and that FastAPI is bound to all ' +
        'interfaces (0.0.0.0:8000) rather than loopback only.',
    }
  }
}
