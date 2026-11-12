// VARUNA GCS desktop app (Electron main process).
//
// Packaged: starts the loopback server (server.cjs) and opens a window on it.
// Dev (`npm run electron:dev`): opens a window on the Vite dev server instead,
// so hot reload and Vite's own proxy work exactly as in the browser.

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const settings = require('./settings.cjs')
const { startServer } = require('./server.cjs')
const { createLocalData } = require('./localData.cjs')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''

const BG = '#0e1116' // --base in src/index.css, so there's no white flash on open

let win = null
let appOrigin = ''
let portChangedFrom = null

app.setAppUserModelId('com.varuna.gcs')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('VARUNA GCS could not start', String(err && err.stack ? err.stack : err))
    app.quit()
  })
}

app.on('window-all-closed', () => app.quit())

// Surface renderer/GPU crashes instead of the window just vanishing.
app.on('render-process-gone', (_e, _wc, d) => console.error('[renderer gone]', JSON.stringify(d)))
app.on('child-process-gone', (_e, d) => console.error('[child gone]', JSON.stringify(d)))
process.on('uncaughtException', (err) => console.error('[main uncaught]', err && err.stack))

function distRoot() {
  const root = path.join(app.getAppPath(), 'dist')
  // electron-builder unpacks dist/ (asarUnpack) so the 64MB of models and wasm
  // are streamed from real files rather than through the archive.
  const unpacked = root.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')
  return fs.existsSync(unpacked) ? unpacked : root
}

async function boot() {
  let url = DEV_URL
  if (!url) {
    const s = settings.load()
    const { port } = await startServer({
      root: distRoot(),
      preferredPort: s.port,
      getTarget: () => settings.load().piAddress,
      getBoatTarget: () => settings.load().boatAddress,
      // Operator records (CSV) and sign-in live in the per-user folder, which
      // survives app updates: %APPDATA%\VARUNA GCS\data on Windows.
      localData: createLocalData({
        dataDir: path.join(app.getPath('userData'), 'data'),
        seedFile: path.join(distRoot(), 'config', 'rivers.json'),
      }),
    })
    if (port !== s.port) {
      // The app's settings, saved Groq key and detection log live in
      // localStorage, which the browser scopes to the origin — and the port is
      // part of that origin. Landing on a different port therefore looks exactly
      // like "all my data is gone", so tell the operator instead of letting them
      // discover it. The fallback port is deliberately NOT saved: next launch
      // tries the preferred one again and the old data comes back with it.
      portChangedFrom = s.port
    }
    url = `http://127.0.0.1:${port}/`
  }
  appOrigin = new URL(url).origin
  setupSecurity()
  setupIpc()
  buildMenu()
  createWindow(url)
}

// Everything the app legitimately talks to from the page. The Pi itself is not
// listed because it's reached same-origin, through the built-in proxy.
const CONNECT_HOSTS = [
  'https://api.groq.com', // voice assistant (Whisper + chat)
  'https://generativelanguage.googleapis.com', // assistant: Google Gemini
  'https://openrouter.ai', // assistant: OpenRouter
  // assistant: "Custom (OpenAI-compatible)" — the operator types any endpoint,
  // so it can't be listed up front. Scripts stay 'self'-only either way.
  'https:',
  'https://detect.roboflow.com', // optional cloud detector
  'https://api.emailjs.com', // email alerts
  'https://nominatim.openstreetmap.org', // place lookup
  'https://overpass-api.de', // water-body geometry
  'https://overpass.kumi.systems',
  'https://overpass.private.coffee',
  'https://server.arcgisonline.com', // satellite tiles
]

function applyCsp(ses) {
  // 'wasm-unsafe-eval' is required: ONNX Runtime compiles the .wasm detector.
  // blob: covers its worker and the recorded mission video. No 'unsafe-eval',
  // so plain JS eval stays blocked.
  //
  // In --local / --dev mode the page comes from the Vite dev server on
  // localhost:5173. Vite injects its HMR client via a <script> tag whose src
  // is a localhost URL, so we must also allow that origin in connect-src (for
  // the HMR WebSocket) and img-src / media-src (Vite's error overlay).
  // In production (dist/) these extras are absent, so they don't broaden the
  // attack surface for deployed builds.
  const devOrigin = DEV_URL ? new URL(DEV_URL).origin : null   // e.g. http://localhost:5173
  const devConnectExtra = devOrigin
    ? `${devOrigin} ${devOrigin.replace('http://', 'ws://')}` // http + ws for HMR
    : ''

  const csp = [
    "default-src 'self'",
    // Vite's HMR client is injected as an inline <script> in dev; allow that.
    `script-src 'self' 'wasm-unsafe-eval' blob:${devOrigin ? " 'unsafe-inline'" : ''}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", // Tailwind + Framer Motion inject styles
    "font-src 'self' data:",
    // googleusercontent: the signed-in operator's Google profile picture.
    `img-src 'self' data: blob: https://server.arcgisonline.com https://*.googleusercontent.com${devOrigin ? ` ${devOrigin}` : ''}`,
    `media-src 'self' blob: data:${devOrigin ? ` ${devOrigin}` : ''}`,
    `connect-src 'self' ${CONNECT_HOSTS.join(' ')}${devConnectExtra ? ` ${devConnectExtra}` : ''}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')

  ses.webRequest.onHeadersReceived((details, cb) => {
    // Only our own pages; proxied Pi responses (video/JSON) are untouched.
    if (!isOwnUrl(details.url) || details.resourceType !== 'mainFrame') {
      return cb({ responseHeaders: details.responseHeaders })
    }
    const headers = { ...details.responseHeaders }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-security-policy') delete headers[k]
    }
    headers['Content-Security-Policy'] = [csp]
    cb({ responseHeaders: headers })
  })
}

function isOwnUrl(u) {
  try {
    const origin = new URL(u).origin
    // In --local / --dev mode appOrigin is the Vite dev server origin
    // (e.g. http://localhost:5173). In production it is the loopback server
    // origin (e.g. http://127.0.0.1:47621). Both are considered "own".
    return origin === appOrigin
  } catch {
    return false
  }
}

function isGoogleSignInPage(u) {
  try {
    const x = new URL(u)
    return x.hostname === 'localhost' && x.pathname === '/local/auth/google/page'
  } catch {
    return false
  }
}

// The Windows Hello page (localData.cjs). WebAuthn refuses the window's
// 127.0.0.1 address, so it runs at localhost on the same port, in a small window
// of its own inside the app.
function isFingerprintPage(u) {
  try {
    const x = new URL(u)
    return x.protocol === 'http:' && x.hostname === 'localhost' && x.port === new URL(appOrigin).port &&
      x.pathname === '/local/auth/fingerprint/page'
  } catch {
    return false
  }
}

function openExternal(u) {
  if (/^(https?:|mailto:)/i.test(u)) shell.openExternal(u).catch(() => {})
}

function setupSecurity() {
  // Camera + mic (webcam detection, voice assistant) and location. Nothing else,
  // and only for this app's own pages.
  const ALLOWED = new Set(['media', 'geolocation', 'clipboard-sanitized-write', 'fullscreen'])
  const ses = session.defaultSession

  if (!DEV_URL) applyCsp(ses)
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(ALLOWED.has(permission) && isOwnUrl(details.requestingUrl || wc.getURL()))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED.has(permission) && isOwnUrl(requestingOrigin)
  })

  app.on('web-contents-created', (_e, contents) => {

    contents.setWindowOpenHandler(({ url }) => {
      if (isFingerprintPage(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 380,
            height: 400,
            resizable: false,
            minimizable: false,
            maximizable: false,
            autoHideMenuBar: true,
            title: 'VARUNA AI — Fingerprint',
            parent: BrowserWindow.fromWebContents(contents) || undefined,
            modal: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        }
      }
      // Google refuses to sign in inside an embedded app window, so its sign-in
      // page (served by localData.cjs) always opens in the system browser.
      if (isGoogleSignInPage(url)) {
        openExternal(url)
        return { action: 'deny' }
      }
      // The certificate print view (lib/certificate.js) opens a blank window and
      // writes into it; the camera snapshot opens a same-origin URL. Both stay
      // in-app. Everything else (Google Maps, WhatsApp) goes to the system browser.
      if (!url || url === 'about:blank' || isOwnUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1000,
            height: 800,
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        }
      }
      openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isOwnUrl(url)) return
      event.preventDefault()
      openExternal(url)
    })
  })
}

// ---------- Pi address (System → Connection) ----------

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
      detail:
        "That name doesn't resolve. If it's a Netbird name, check this PC shows Connected in " +
        '`netbird status` — or use the Pi\'s 100.x.x.x Netbird IP instead.',
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
      detail: 'The Pi is offline, or it and this PC are not both connected to the same Netbird network.',
    }
  }
  return { ok: false, ms, title: 'Could not reach the Pi', detail: `${code || (err && err.message) || 'Unknown error'}` }
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

function testPi(base) {
  return new Promise((resolve) => {
    if (!base) {
      return resolve({
        ok: false,
        title: 'No address entered',
        detail: "Enter the Pi's Netbird address, e.g. http://varuna-pi.netbird.cloud:8000",
      })
    }
    const t0 = Date.now()
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      resolve(r)
    }
    const u = new URL('/api/ping', base)
    const req = (u.protocol === 'https:' ? https : http).get(u, (res) => {
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
    req.on('error', (err) => done(explainError(err, Date.now() - t0)))
    // Hard cap covers DNS + connect + response; a relayed Netbird handshake can be slow.
    const hard = setTimeout(() => {
      req.destroy()
      done(explainError({ code: 'ETIMEDOUT' }, Date.now() - t0))
    }, 8000)
  })
}

function setupIpc() {
  // `senderFrame` throws if the frame was disposed mid-call (a reload while an
  // invoke is in flight), so treat that as "not from the app" rather than
  // letting it reject the call with an opaque error.
  const fromApp = (event) => {
    try {
      return isOwnUrl(event.senderFrame && event.senderFrame.url)
    } catch {
      return false
    }
  }

  ipcMain.handle('varuna:getConfig', (event) => {
    if (!fromApp(event)) throw new Error('forbidden')
    return {
      piAddress: settings.load().piAddress,
      boatAddress: settings.load().boatAddress,
      // In dev the page comes from Vite, whose proxy (VITE_DEV_API_TARGET) is in
      // charge, so the renderer should keep its normal browser behaviour.
      usesBuiltInProxy: !DEV_URL,
      version: app.getVersion(),
    }
  })

  ipcMain.handle('varuna:setPiAddress', (event, raw) => {
    if (!fromApp(event)) throw new Error('forbidden')
    const clean = normalizeAddress(raw)
    if (clean === null) return { ok: false, error: 'Enter an http:// address, e.g. http://100.92.14.7:8000' }
    settings.save({ piAddress: clean })
    return { ok: true, piAddress: clean }
  })

  ipcMain.handle('varuna:testPiAddress', (event, raw) => {
    if (!fromApp(event)) throw new Error('forbidden')
    const clean = normalizeAddress(raw)
    if (clean === null) {
      return { ok: false, title: 'Invalid address', detail: 'Enter an http:// address, e.g. http://100.92.14.7:8000' }
    }
    return testPi(clean)
  })

  ipcMain.handle('varuna:setBoatAddress', (event, raw) => {
    if (!fromApp(event)) throw new Error('forbidden')
    const clean = normalizeAddress(raw)
    if (clean === null) return { ok: false, error: 'Enter an http:// address, e.g. http://100.92.14.8:8000' }
    settings.save({ boatAddress: clean })
    return { ok: true, boatAddress: clean }
  })

  ipcMain.handle('varuna:testBoatAddress', (event, raw) => {
    if (!fromApp(event)) throw new Error('forbidden')
    const clean = normalizeAddress(raw)
    if (clean === null) {
      return { ok: false, title: 'Invalid address', detail: 'Enter an http:// address, e.g. http://100.92.14.8:8000' }
    }
    return testBoat(clean)
  })
}

// ---------- window + menu ----------

function onScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x + 100 > w.x && b.y + 50 > w.y && b.x < w.x + w.width - 100 && b.y < w.y + w.height - 50,
  )
}

function createWindow(url) {
  const saved = settings.load().windowBounds
  const bounds = onScreen(saved) ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}
  // .ico on Windows: it carries hand-made 16–32 px sizes for the title bar and taskbar.
  const iconPath = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    ...bounds,
    show: false,
    backgroundColor: BG,
    title: 'VARUNA AI · Ground Control',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // A ground station must not slow down when another window covers it
      // (screen recording, a second app on top): Chromium otherwise throttles
      // timers and animation frames, so video, AI and telemetry fall behind
      // and catch up in a burst when the window comes back.
      backgroundThrottling: false,
    },
  })
  if (saved && saved.maximized) win.maximize()
  win.once('ready-to-show', () => {
    win.show()
    if (portChangedFrom == null) return
    const was = portChangedFrom
    portChangedFrom = null
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Settings did not carry over',
      message: `VARUNA normally runs on port ${was}, but another program was using it.`,
      detail:
        'The app works, but because it had to move to a different port, your saved settings, ' +
        'API key and detection log from previous sessions are not visible in this one. They are ' +
        'not deleted — close whatever is using the old port, then restart VARUNA to get them back.',
    })
  })

  let t = null
  const persist = () => {
    clearTimeout(t)
    t = setTimeout(saveBounds, 400)
  }
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    settings.save({ windowBounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('close', saveBounds)
  win.on('closed', () => {
    win = null
  })

  loadWithRetry(url)
}

// In dev the Vite server may still be starting; keep retrying instead of
// showing a blank error page.
function loadWithRetry(url, attempt = 0) {
  if (!win) return
  win.loadURL(url).catch(() => {
    if (!win) return
    if (DEV_URL && attempt < 120) return setTimeout(() => loadWithRetry(url, attempt + 1), 500)
    dialog.showErrorBox('VARUNA GCS', `Could not load the app from ${url}`)
  })
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'VARUNA',
        submenu: [
          {
            label: 'About VARUNA GCS',
            click: () =>
              dialog.showMessageBox(win, {
                type: 'info',
                title: 'About',
                message: 'VARUNA AI · Ground Control',
                detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}`,
              }),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  )
}
