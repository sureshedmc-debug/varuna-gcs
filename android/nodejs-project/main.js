// VARUNA GCS on Android: the same loopback server the desktop app runs
// (electron/server.cjs + localData.cjs + proxyGuard.cjs, copied next to this
// file by scripts/build-android.mjs), started inside the app by nodejs-mobile.
//
// The Android shell (MainActivity.java) serves the built frontend straight from
// the APK and sends everything else here: the Pi proxy (/api, /video_feed,
// /stream, /tune, /boat) and the local store (/local/*: CSV records, sign-in).
//
//   node main.js <filesDir> <token>
//
// Settings live in <filesDir>/varuna-settings.json, records in <filesDir>/data
// (both survive app updates). The port actually bound is written to
// <filesDir>/varuna-port so the shell knows where to point the WebView.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { startServer } = require('./server.cjs')
const { createLocalData } = require('./localData.cjs')

const crypto = require('node:crypto')

const filesDir = process.argv[2]
// A random secret the shell makes for each run and gives to its own WebView as a
// cookie (see "only this app" below).
const TOKEN = process.argv[3] || ''
if (!filesDir) {
  console.error('[varuna] usage: main.js <filesDir> <token>')
  process.exit(2)
}
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version
  } catch {
    return ''
  }
})()

// Nothing here may take the whole app down: a stray socket error is logged.
process.on('uncaughtException', (err) => console.error('[varuna] uncaught', err && err.stack))
process.on('unhandledRejection', (err) => console.error('[varuna] unhandled', err && err.stack))

// ---------------------------------------------------------------- settings
// Same keys and defaults as electron/settings.cjs.
const DEFAULT_PI_ADDRESS = 'http://100.99.158.25:8000'
const DEFAULT_BOAT_ADDRESS = 'http://100.99.71.176:8000'
const DEFAULTS = { piAddress: DEFAULT_PI_ADDRESS, boatAddress: DEFAULT_BOAT_ADDRESS, port: 47621 }
const settingsFile = path.join(filesDir, 'varuna-settings.json')
let cache = null

function loadSettings() {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }
  } catch {
    cache = { ...DEFAULTS }
  }
  if (!cache.piAddress) cache.piAddress = DEFAULT_PI_ADDRESS
  if (!cache.boatAddress) cache.boatAddress = DEFAULT_BOAT_ADDRESS
  return cache
}

function saveSettings(patch) {
  cache = { ...loadSettings(), ...patch }
  try {
    const tmp = settingsFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2))
    fs.renameSync(tmp, settingsFile)
  } catch (e) {
    console.error('[varuna] settings save failed:', e.message)
  }
  return cache
}

// ---------------------------------------------------------------- Pi address checks
// Same behaviour as the desktop app's System → Connection (electron/main.cjs).

/** '' clears it; otherwise returns scheme://host[:port], or null if invalid. */
function normalizeAddress(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

function explainError(err, ms) {
  const code = (err && err.code) || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      ok: false, ms,
      title: 'Address not found',
      detail: "That name doesn't resolve. If it's a Netbird name, check the NetBird app on this phone shows Connected — or use the Pi's 100.x.x.x Netbird IP instead.",
    }
  }
  if (code === 'ECONNREFUSED') {
    return {
      ok: false, ms,
      title: 'The Pi answered, but nothing is listening on that port',
      detail: 'Check the FastAPI service is running, the port is right, and it is bound to 0.0.0.0 (not loopback only).',
    }
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return {
      ok: false, ms,
      title: 'Timed out',
      detail: 'The Pi is offline, or it and this phone are not both connected to the same Netbird network (open the NetBird app and connect).',
    }
  }
  return { ok: false, ms, title: 'Could not reach the Pi', detail: `${code || (err && err.message) || 'Unknown error'}` }
}

function testPi(base) {
  return new Promise((resolve) => {
    if (!base) {
      return resolve({ ok: false, title: 'No address entered', detail: "Enter the Pi's Netbird address, e.g. http://100.92.14.7:8000" })
    }
    const t0 = Date.now()
    let settled = false
    let hard = null
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      resolve(r)
    }
    let req
    try {
      const u = new URL('/api/ping', base)
      req = (u.protocol === 'https:' ? https : http).get(u, (res) => {
        res.resume()
        const ms = Date.now() - t0
        if (res.statusCode >= 200 && res.statusCode < 300) {
          done({ ok: true, ms, title: 'Connected', detail: `/api/ping answered in ${ms} ms.` })
        } else {
          done({
            ok: false, ms,
            title: `Backend answered HTTP ${res.statusCode}`,
            detail: 'The Pi was reached, but /api/ping did not return 200 — check the FastAPI service.',
          })
        }
      })
    } catch (err) {
      return done(explainError(err, 0))
    }
    req.on('error', (err) => done(explainError(err, Date.now() - t0)))
    hard = setTimeout(() => {
      req.destroy()
      done(explainError({ code: 'ETIMEDOUT' }, Date.now() - t0))
    }, 8000)
  })
}

/** Like testPi, then also checks the address really is the boat (not the drone's Pi). */
async function testBoat(base) {
  if (!base) {
    return { ok: false, title: 'No address entered', detail: "Enter the boat Pi's Netbird address, e.g. http://100.92.14.8:8000" }
  }
  const r = await testPi(base)
  if (!r.ok) return r
  const body = await new Promise((resolve) => {
    const u = new URL('/api/ping', base)
    const req = (u.protocol === 'https:' ? https : http).get(u, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { if (text.length < 4096) text += c })
      res.on('end', () => resolve(text))
    })
    req.on('error', () => resolve(''))
    req.setTimeout(8000, () => { req.destroy(); resolve('') })
  })
  let vehicle = null
  try {
    vehicle = JSON.parse(body).vehicle
  } catch {
    /* not JSON */
  }
  if (vehicle !== 'boat') {
    return {
      ok: false, ms: r.ms,
      title: 'That address is not the boat',
      detail: "A backend answered, but it is not the VARUNA boat backend (it may be the drone's Pi). Enter the boat Pi's Netbird address.",
    }
  }
  return { ...r, detail: `The boat answered /api/ping in ${r.ms} ms.` }
}

// ---------------------------------------------------------------- shell bridge
// What the desktop app does over Electron IPC (preload.cjs), the page does here
// over same-origin HTTP: /local/android/* (see the bridge script the build adds
// to index.html). These sit under /local/ because that is the prefix server.cjs
// hands to the local store; this wrapper answers its own routes first.

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(obj))
}

/** The request's JSON object, or null if it is missing, too big or not JSON. */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 16 * 1024) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(v && typeof v === 'object' ? v : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
    req.on('close', () => resolve(null)) // after 'end' this is a no-op
  })
}

// Only the app's own page: same rule as the Pi proxy (server.cjs allowedCaller).
function fromOwnPage(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  return req.headers['sec-fetch-site'] === 'same-origin'
}

async function bridge(req, res, p) {
  if (!fromOwnPage(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
  const s = loadSettings()
  if (req.method === 'GET' && p === '/local/android/config') {
    return sendJson(res, 200, { piAddress: s.piAddress, boatAddress: s.boatAddress, usesBuiltInProxy: true, version: VERSION, platform: 'android' })
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
  const body = await readJson(req)
  // A broken request must not be read as "clear the address".
  if (!body || typeof body.address !== 'string') return sendJson(res, 400, { ok: false, error: 'Bad request' })
  const clean = normalizeAddress(body.address)
  if (p === '/local/android/pi/set') {
    if (clean === null) return sendJson(res, 200, { ok: false, error: 'Enter an http:// address, e.g. http://100.92.14.7:8000' })
    saveSettings({ piAddress: clean })
    return sendJson(res, 200, { ok: true, piAddress: clean })
  }
  if (p === '/local/android/boat/set') {
    if (clean === null) return sendJson(res, 200, { ok: false, error: 'Enter an http:// address, e.g. http://100.92.14.8:8000' })
    saveSettings({ boatAddress: clean })
    return sendJson(res, 200, { ok: true, boatAddress: clean })
  }
  if (p === '/local/android/pi/test' || p === '/local/android/boat/test') {
    if (clean === null) {
      return sendJson(res, 200, { ok: false, title: 'Invalid address', detail: 'Enter an http:// address, e.g. http://100.92.14.7:8000' })
    }
    return sendJson(res, 200, await (p.includes('/boat/') ? testBoat(clean) : testPi(clean)))
  }
  return sendJson(res, 404, { ok: false, error: 'Not found' })
}

// ---------------------------------------------------------------- only this app
// On a PC, a program that can reach 127.0.0.1 already has the user's own
// rights. On a phone it does not: every installed app can connect to this port
// and send whatever Host / Origin / Sec-Fetch-Site headers it likes, which are
// all server.cjs and localData.cjs check. So here every request must also carry
// the shell's per-run token, which only the app's own WebView has (an HttpOnly
// cookie set by MainActivity). Without it: 403, before any handler runs.
//
// The exception is the two sign-in pages that open in the phone's browser
// (Google refuses to sign in inside an app's WebView), and the calls those
// pages make. They run on http://localhost and are tied to a one-time nonce /
// request id that only the app's own page can create.
const BROWSER_GET = new Set(['/local/auth/google/page', '/local/auth/google/page.js', '/local/auth/fingerprint/page', '/local/auth/fingerprint/page.js'])
const BROWSER_POST = new Set(['/local/auth/google/complete', '/local/auth/fingerprint/options', '/local/auth/fingerprint/answer', '/local/auth/fingerprint/cancel'])

function hasToken(req) {
  if (!TOKEN) return false
  const want = Buffer.from(TOKEN)
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 1 || part.slice(0, i).trim() !== 'varuna_token') continue
    const got = Buffer.from(part.slice(i + 1).trim())
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }
  return false
}

function fromBrowserSignIn(req) {
  if (!/^localhost(:\d+)?$/i.test(String(req.headers.host || ''))) return false
  const p = String(req.url || '').split('?')[0]
  return req.method === 'GET' ? BROWSER_GET.has(p) : req.method === 'POST' ? BROWSER_POST.has(p) : false
}

/** Put the token check in front of everything the server does. */
function requireToken(server) {
  const onRequest = server.listeners('request')
  const onUpgrade = server.listeners('upgrade')
  server.removeAllListeners('request')
  server.removeAllListeners('upgrade')
  server.on('request', (req, res) => {
    if (!hasToken(req) && !fromBrowserSignIn(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end('Forbidden')
    }
    for (const fn of onRequest) fn.call(server, req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    if (!hasToken(req)) return socket.destroy()
    for (const fn of onUpgrade) fn.call(server, req, socket, head)
  })
}

// ---------------------------------------------------------------- start
async function main() {
  const store = createLocalData({
    dataDir: path.join(filesDir, 'data'),
    seedFile: path.join(__dirname, 'rivers.json'),
  })
  const localData = {
    handle(req, res) {
      const p = String(req.url || '').split('?')[0]
      if (p.startsWith('/local/android/')) {
        return bridge(req, res, p).catch((err) => {
          console.error('[varuna] bridge', err && err.stack)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error' })
        })
      }
      return store.handle(req, res)
    },
  }
  const s = loadSettings()
  if (TOKEN.length < 32) throw new Error('no access token from the app shell')
  const { port, server } = await startServer({
    // The shell serves the frontend from the APK; nothing static is served here.
    root: path.join(__dirname, 'no-static'),
    preferredPort: s.port,
    getTarget: () => loadSettings().piAddress,
    getBoatTarget: () => loadSettings().boatAddress,
    localData,
  })
  requireToken(server)
  const portFile = path.join(filesDir, 'varuna-port')
  fs.writeFileSync(portFile + '.tmp', String(port))
  fs.renameSync(portFile + '.tmp', portFile)
  console.log(`[varuna] server on 127.0.0.1:${port}`)
}

main().catch((err) => {
  console.error('[varuna] could not start', err && err.stack)
  try {
    fs.writeFileSync(path.join(filesDir, 'varuna-port'), 'error: ' + String(err && err.message))
  } catch {
    /* nothing more to do */
  }
})
