// VARUNA API client.
//
// The backend now lives behind an ngrok tunnel (the Raspberry Pi runs only the
// FastAPI backend). The API base URL is CONFIGURABLE and resolved at runtime, so
// the same build can point anywhere without a rebuild:
//   1. localStorage 'varuna.apiBase'  (set from System → Connection, or console)
//   2. build-time VITE_API_BASE       (optional)
//   3. DEFAULT_API_BASE below         (the ngrok URL)
//   An empty value ('') means same-origin (relative paths) — use that if you
//   ever serve the frontend from the same host as the backend.
//
// NOTE: talking to a different origin (ngrok) requires CORS on the backend and,
// for ngrok's free tier, the 'ngrok-skip-browser-warning' header (added below).

export const DEFAULT_API_BASE = 'https://palatable-polka-trespass.ngrok-free.dev'

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '')
}

export function getApiBase() {
  try {
    const o = localStorage.getItem('varuna.apiBase')
    if (o !== null) return trimSlash(o) // '' allowed → same-origin
  } catch {
    /* private mode */
  }
  if (import.meta.env && import.meta.env.VITE_API_BASE !== undefined) {
    return trimSlash(import.meta.env.VITE_API_BASE)
  }
  return trimSlash(DEFAULT_API_BASE)
}

export function setApiBase(v) {
  try {
    localStorage.setItem('varuna.apiBase', trimSlash(v))
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
async function request(path, { method = 'GET', body, signal, timeout = 12000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  const onAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onAbort)
  try {
    const headers = { 'ngrok-skip-browser-warning': 'true' }
    if (body) headers['Content-Type'] = 'application/json'
    const res = await fetch(url(path), {
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
  ping: () => request('/api/ping', { timeout: 5000 }),
  health: () => request('/api/health'),
  systemStatus: () => request('/api/system/status'),
  piMetrics: () => request('/api/system/pi?processes=true'),

  // --- Camera ---
  cameraStatus: () => request('/api/camera/status'),
  // snapshot & stream are <img> URLs, not fetched here (absolute, so the browser
  // loads them cross-origin directly from the configured backend):
  streamUrl: () => url('/video_feed'),
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

  // --- Flight control (mavlink) ---
  arm: (arm) =>
    request('/api/mavlink/arm', { method: 'POST', body: arm === undefined ? {} : { arm } }),
  setMode: (mode) => request('/api/mavlink/mode', { method: 'POST', body: { mode } }),
  takeoff: (altitude) =>
    request('/api/mavlink/takeoff', { method: 'POST', body: { altitude } }),
  rtl: () => request('/api/mavlink/rtl', { method: 'POST' }),
  land: () => request('/api/mavlink/land', { method: 'POST' }),
  mavlinkStatus: () => request('/api/mavlink/status'),
  getPrefer: () => request('/api/mavlink/prefer'),
  setPrefer: (mode) => request('/api/mavlink/prefer', { method: 'POST', body: { mode } }),

  // --- Missions ---
  missionUpload: (name, waypoints) =>
    request('/api/mission/upload', { method: 'POST', body: { name, waypoints } }),
  missionStart: () => request('/api/mission/start', { method: 'POST' }),
  missionList: () => request('/api/mission/list'),

  // --- Live config / tuning ---
  getConfig: () => request('/api/config'),
  setConfig: (patch) => request('/api/config', { method: 'POST', body: patch }),
  saveConfig: () => request('/api/config/save', { method: 'POST' }),

  // --- Auth ---
  verifyPin: (password) =>
    request('/api/auth/verify_pin', { method: 'POST', body: { password } }),
}

// WebSocket URL for live push. Follows the configured API base (wss:// for the
// https ngrok tunnel); falls back to same-origin when no base is configured.
export function wsUrl() {
  const base = getApiBase()
  if (base) return base.replace(/^http/i, 'ws') + '/api/ws'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/ws`
}
