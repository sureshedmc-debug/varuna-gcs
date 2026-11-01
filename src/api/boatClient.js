// VARUNA boat API client — talks to the boat's Raspberry Pi (boat-pi/ backend).
//
// The boat is a second vehicle with its own Pi and its own Netbird address, so
// it has its own base URL, resolved at runtime like the drone's (client.js):
//   1. localStorage 'varuna.boatBase'  (browser: set from System → Boat connection)
//   2. '/boat'                         (default: same-origin proxy)
//
// The default goes through a proxy that strips the '/boat' prefix: the desktop
// app's built-in server (electron/server.cjs, address saved in its settings)
// and the Vite dev server (VITE_DEV_BOAT_TARGET). So the browser only ever
// talks to its own origin — no CORS, no hardcoded host in the bundle.
//
// Every reply from a real boat carries `vehicle: "boat"`. The app checks it
// before enabling any boat command, so a mistyped address that points at the
// drone's Pi can never receive boat commands.

import { requestUrl, testConnection } from './client'

export const BOAT_PROXY_BASE = '/boat'
const KEY = 'varuna.boatBase'

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '')
}

export function getBoatBase() {
  try {
    const o = localStorage.getItem(KEY)
    if (o) return trimSlash(o)
  } catch {
    /* private mode */
  }
  return BOAT_PROXY_BASE
}

/** '' (or the proxy path) = use the same-origin '/boat' proxy. */
export function setBoatBase(v) {
  try {
    const clean = trimSlash(v)
    if (!clean || clean === BOAT_PROXY_BASE) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, clean)
  } catch {
    /* private mode */
  }
}

function boatUrl(path) {
  return getBoatBase() + path
}

const req = (path, opts) => requestUrl(boatUrl(path), opts)
const post = (path, body, timeout) => req(path, { method: 'POST', body, timeout })

export const boatApi = {
  ping: () => req('/api/ping', { timeout: 8000 }),
  health: () => req('/api/health'),
  info: () => req('/api/boat/info'),
  piMetrics: () => req('/api/system/pi'),
  telemetry: () => req('/api/telemetry'),
  track: (limit = 300) => req(`/api/telemetry/history?limit=${limit}`),

  // Boat control. The backend answers {success, message}; a rejected command
  // (e.g. a Pixhawk pre-arm failure) comes back with success:false + reason.
  arm: (arm) => post('/api/mavlink/arm', { arm }, 15000),
  setMode: (mode) => post('/api/mavlink/mode', { mode }, 15000),
  hold: () => post('/api/mavlink/hold', undefined, 15000),
  rtl: () => post('/api/mavlink/rtl', undefined, 15000),
  emergencyStop: () => post('/api/mavlink/stop', undefined, 20000),
  // Instant brake (L1 + R1): force-disarm first, then roller off and HOLD.
  brake: () => post('/api/mavlink/brake', undefined, 15000),

  // Live collect: the boat goes after the drone's finds as they come, in GUIDED,
  // with no planned mission (boat-pi/live_collect.py).
  liveStatus: () => req('/api/live/status', { timeout: 10000 }),
  liveTargets: (targets) => post('/api/live/targets', { targets }, 15000),
  liveStart: ({ whenEmpty = 'wait', speedMps } = {}) => post('/api/live/start', { when_empty: whenEmpty, speed_mps: speedMps }, 30000),
  livePause: () => post('/api/live/pause', undefined, 15000),
  liveStop: (rtl = false) => post('/api/live/stop', { rtl }, 15000),
  liveSkip: (id) => post('/api/live/skip', { id }, 10000),
  liveClear: () => post('/api/live/clear', undefined, 10000),

  // The intake roller: on = true / false, or no argument to toggle (R1 on the controller).
  collector: (on) => post('/api/collector', on === undefined ? {} : { on }, 10000),

  // Motor matching: spin one thruster at an exact signal (the Pixhawk stops it
  // itself), then save where it starts turning.
  motors: () => req('/api/pixhawk/motors', { timeout: 30000 }),
  motorTest: (motor, pwm, seconds = 2) => post('/api/pixhawk/motor_test', { motor, pwm, seconds }, 15000),
  motorStart: (motor, pwm) => post('/api/pixhawk/motor_start', { motor, pwm }, 30000),

  // Collection missions. Upload runs the MAVLink mission protocol on the Pi,
  // which can take a few seconds over a 57600-baud telemetry link.
  missionUpload: ({ name, waypoints, holdS, speedMps, homing = true, measureAtFirst = false }) =>
    post('/api/mission/upload', {
      name, waypoints, hold_s: holdS, speed_mps: speedMps, rtl: true,
      homing, measure_at_first: measureAtFirst,
    }, 45000),
  missionStart: () => post('/api/mission/start', undefined, 25000),
  missionPause: () => post('/api/mission/pause', undefined, 15000),
  missionClear: () => post('/api/mission/clear', undefined, 10000),
  missionStatus: () => req('/api/mission/status'),
  missionList: () => req('/api/mission/list'),

  // Boat camera. The AI runs in this app; the boat decides what to do with it.
  cameraStatus: () => req('/api/camera/status'),
  visionStatus: () => req('/api/vision/status'),
  visionConfig: () => req('/api/vision/config'),
  setVisionConfig: (patch) => post('/api/vision/config', patch, 10000),
  observe: (body) => req('/api/vision/observe', { method: 'POST', body, timeout: 3000 }),

  // Catch counter
  catchSummary: (limit = 40) => req(`/api/catch?limit=${limit}`),
  catchItem: (item) => post('/api/catch/item', item, 8000),
  emptyBin: () => post('/api/catch/empty', undefined, 8000),

  // Wildlife-safe mode
  wildlife: (limit = 30) => req(`/api/wildlife?limit=${limit}`),
  wildlifeAction: (action) => post('/api/wildlife/action', { action }, 15000),

  // Water quality (turbidity)
  waterStatus: () => req('/api/water/status'),
  waterTrack: (limit = 4000) => req(`/api/water/track?limit=${limit}`),
  waterReadings: (limit = 100) => req(`/api/water/readings?limit=${limit}`),
  waterMeasure: () => post('/api/water/measure', undefined, 15000),
  waterCalibrate: (action, ntu) => post('/api/water/calibrate', { action, ntu }, 10000),

  // Driving by game controller: the Pixhawk's radio failsafe (what stops the
  // boat if its Pi dies, with no RC transmitter).
  failsafe: () => req('/api/pixhawk/failsafe', { timeout: 15000 }),
  fixFailsafe: () => post('/api/pixhawk/failsafe/fix', undefined, 20000),

  // Simulator only
  simDetections: (frameTime) => req(`/api/sim/detections?frame_time=${frameTime}`, { timeout: 3000 }),
  simDuck: (aheadM = 9) => post(`/api/sim/duck?ahead_m=${aheadM}`, undefined, 5000),
}

/** URLs the browser loads directly (stream, photos). */
export const boatUrls = {
  video: () => boatUrl('/video_feed'),
  snapshot: () => boatUrl(`/api/camera/snapshot?t=${Date.now()}`),
  catchPhoto: (id) => boatUrl(`/api/catch/photo/${encodeURIComponent(id)}`),
  wildlifePhoto: (id) => boatUrl(`/api/wildlife/photo/${encodeURIComponent(id)}`),
}

/** WebSocket URL for live boat telemetry, following the configured base. */
export function boatWsUrl() {
  const base = getBoatBase()
  if (/^https?:\/\//i.test(base)) return base.replace(/^http/i, 'ws') + '/api/ws'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${base}/api/ws`
}

/** The game controller's socket (sticks → boat), next to the telemetry one. */
export function boatDriveUrl() {
  return boatWsUrl().replace(/\/api\/ws$/, '/api/drive')
}

/** True only when a reply really came from a VARUNA boat backend. */
export function isBoatReply(res) {
  return !!res && !res._httpError && res.vehicle === 'boat'
}

/**
 * Diagnose the boat link for System → Boat connection (browser mode; the
 * desktop app tests through its own IPC). Reuses the drone link diagnosis,
 * then also checks that the address really is the boat and not the drone.
 */
export async function testBoatConnection(base) {
  const b = trimSlash(base) || BOAT_PROXY_BASE
  const r = await testConnection(b)
  if (!r.ok) return r
  try {
    const ping = await requestUrl(b + '/api/ping', { timeout: 8000 })
    if (!isBoatReply(ping)) {
      return {
        ok: false,
        ms: r.ms,
        title: 'That address is not the boat',
        detail: 'A VARUNA backend answered, but it is not the boat backend (it may be the drone\'s Pi). Enter the boat Pi\'s Netbird address.',
      }
    }
  } catch {
    /* testConnection already proved it answers; keep its verdict */
  }
  return { ...r, detail: `The boat answered /api/ping in ${r.ms} ms.` }
}
