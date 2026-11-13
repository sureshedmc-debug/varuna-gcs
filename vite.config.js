import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import path from 'node:path'

// The production bundle NEVER contains a backend host: the app calls the API via
// relative paths (see src/api/client.js), resolved against window.location.origin
// at runtime. The dev proxy below exists ONLY for `npm run dev` on the laptop and
// is never emitted into `dist/`.
//
// Point dev at the real Pi by setting VITE_DEV_API_TARGET in .env.local. Over
// Netbird that is the Pi's private mesh address (plain http — WireGuard already
// encrypts the link):
//   VITE_DEV_API_TARGET=http://varuna-pi.netbird.cloud:8000
//   VITE_DEV_API_TARGET=http://100.92.14.7:8000
// Proxying server-side is what keeps the browser on http://localhost, so there
// is no CORS and no mixed-content blocking to deal with.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_DEV_API_TARGET || 'http://localhost:8000'
  // The boat's own Pi (second vehicle). The app calls it under /boat/*; the
  // prefix is stripped here. Default = the boat backend's simulator running on
  // this laptop:  cd boat-pi && python main.py --sim --port 8001
  const boatTarget = env.VITE_DEV_BOAT_TARGET || 'http://localhost:8001'

  // Everything the frontend calls at runtime lives under these prefixes.
  const proxyPaths = ['/api', '/video_feed', '/stream', '/tune']

  // The app polls eight endpoints every few seconds and opens a WebSocket, so
  // when the Pi is off (or Netbird is down) the default proxy logging prints
  // hundreds of identical stack traces a minute and the terminal becomes
  // unusable. The Pi being unreachable is a normal state during UI work, not a
  // crash — so it gets ONE actionable line every 15s per error kind instead.
  const lastLogged = new Map()
  function onProxyError(err, req, res) {
    const code = err?.code || 'PROXY_ERROR'
    const now = Date.now()
    const boat = String(req?.url || '').startsWith('/boat') || req?.__varunaBoat
    const key = (boat ? 'boat:' : 'pi:') + code
    if (now - (lastLogged.get(key) || 0) > 15000) {
      lastLogged.set(key, now)
      const hint =
        code === 'ENOTFOUND'
          ? `cannot resolve it — is Netbird connected? (\`netbird status\`)`
          : code === 'ECONNREFUSED'
            ? 'nothing is listening there — is the Pi backend running?'
            : err?.message || code
      console.warn(boat ? `
  [boat] ${boatTarget} unreachable: ${hint}
  The boat tabs show "offline"; set VITE_DEV_BOAT_TARGET in .env.local, or start the simulator (boat-pi: python main.py --sim --port 8001).
` : `
  [pi] ${target} unreachable: ${hint}
  The UI still works; set VITE_DEV_API_TARGET in .env.local to change the target.
`)
    }
    // Fail the request fast. A WebSocket upgrade hands us a raw socket, which
    // has no writeHead — ending it is all that's needed there. Plain text, as
    // electron/server.cjs sends: a JSON body with a `success` key would make
    // src/api/client.js read a dead Pi as reachable.
    try {
      if (res && typeof res.writeHead === 'function') {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(`${boat ? 'Boat' : 'Pi'} unreachable (${code})`)
      } else if (res && typeof res.end === 'function') {
        res.end()
      }
    } catch {
      /* socket already gone */
    }
  }

  // Vite registers its OWN 'error' listener immediately after `configure`
  // returns - one full stack trace per failed request. It cannot be removed
  // from in here because it does not exist yet, so drop it on the next tick,
  // by which time it is registered. Doing it this way rather than through a
  // customLogger matters: a customLogger built with createLogger() hardcodes
  // level 'info', which silently overrode --logLevel and clearScreen for
  // builds too.
  // A Pi that is off fails in seconds, then at once, instead of holding the
  // page's few connections for ~21 s each (electron/proxyGuard.cjs).
  const guard = createRequire(import.meta.url)('./electron/proxyGuard.cjs').createProxyGuard()

  const quietErrors = (px, to = target) => {
    const onGuardError = guard.attach(px, () => to)
    px.on('error', onProxyError)
    setTimeout(() => {
      for (const l of px.listeners('error')) {
        if (l !== onProxyError && l !== onGuardError) px.removeListener('error', l)
      }
    }, 0)
  }

  const proxy = Object.fromEntries(
    proxyPaths.map((p) => [
      p,
      { target, changeOrigin: true, ws: true, secure: false, configure: (px) => quietErrors(px) },
    ])
  )
  // Keyed as a regex so it matches /boat and /boat/... only (not /boatsomething).
  proxy['^/boat(/|$)'] = {
    target: boatTarget,
    changeOrigin: true,
    ws: true,
    secure: false,
    rewrite: (p) => p.replace(/^\/boat/, '') || '/',
    configure: (px) => {
      quietErrors(px, boatTarget)
      // The rewrite has already dropped /boat by the time an error fires.
      px.on('proxyReq', (_pr, req) => { req.__varunaBoat = true })
      px.on('proxyReqWs', (_pr, req) => { req.__varunaBoat = true })
    },
  }

  return {
    plugins: [react(), watcherResilience(), localDataStore(env), siteOnlyAssets(mode), siteSeo(mode)],
    // `preview` gets the same proxy as `server`: without it, npm run preview
    // serves the built bundle with no route to the Pi, so a production-shaped
    // smoke test would look broken for the wrong reason.
    preview: { proxy, host: true },
    server: {
      proxy,
      host: true,
      // Optimize HMR and loading speed
      hmr: { overlay: true },
      watch: {
        usePolling: false,
        // Vite only ignores node_modules and .git by default — NOT the rest of
        // the project. Without this it walks the electron-builder output, which
        // holds a whole Electron runtime and is actively written to during a
        // build: watching a file that electron-builder has open throws EBUSY,
        // chokidar emits 'error', and Node kills the dev server outright.
        // Being gitignored does not exclude a directory from the watcher.
        ignored: [
          '**/release/**',
          '**/.kilo/**', // a stray worktree here holds a second full copy of src/
          '**/dist/**',
          '**/android/**',
          '**/training-data/**',
          '**/varuna photos and video/**',
          '**/data/**', // the local CSV store, rewritten on every save
        ],
      },
    },
    // The AI runs in a module worker (src/lib/ortWorker.js) that imports onnxruntime.
    worker: { format: 'es' },
    build: { 
      outDir: 'dist', 
      sourcemap: false,
      // Optimize chunk sizes
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-animation': ['framer-motion'],
            'vendor-3d': ['three'],
            'vendor-ai': ['onnxruntime-web'],
            'vendor-map': ['leaflet', 'react-leaflet'],
          }
        }
      },
      // Increase chunk size warning limit for AI models
      chunkSizeWarningLimit: 1000,
    },
    optimizeDeps: {
      // Pre-bundle every dependency up front. Anything left out is only discovered
      // when a lazy screen first imports it; Vite then re-optimizes mid-session and
      // pages already open get "504 Outdated Optimize Dep" → "Failed to fetch
      // dynamically imported module" (this hit the Detections tab via leaflet.heat).
      include: [
        'react', 'react-dom', 'react-dom/client', 'framer-motion', 'leaflet', 'react-leaflet', 'leaflet.heat',
        '@emailjs/browser', '@vladmandic/face-api',
        '@turf/helpers', '@turf/circle', '@turf/boolean-point-in-polygon', '@turf/area',
        '@turf/length', '@turf/intersect', '@turf/buffer', '@turf/along',
        'three',
        'three/addons/postprocessing/EffectComposer.js',
        'three/addons/postprocessing/RenderPass.js',
        'three/addons/postprocessing/ShaderPass.js',
        'three/addons/postprocessing/UnrealBloomPass.js',
        'three/addons/postprocessing/OutputPass.js',
        'three/addons/environments/RoomEnvironment.js',
        'three/addons/geometries/RoundedBoxGeometry.js',
      ],
      // Exclude WASM/large binaries from optimization
      exclude: ['onnxruntime-web']
    },
  }
})

// The same /local/* store the desktop app's server mounts (electron/localData.cjs):
// CSV records, the state/river catalog and sign-in. In dev the files go to
// <project>/data (gitignored), or VARUNA_DATA_DIR.
function localDataStore(env) {
  let store
  const middleware = (req, res, next) => {
    if (!String(req.url || '').startsWith('/local/')) return next()
    store ||= createRequire(import.meta.url)('./electron/localData.cjs').createLocalData({
      dataDir: path.resolve(env.VARUNA_DATA_DIR || 'data'),
      seedFile: path.resolve('public/config/rivers.json'),
    })
    store.handle(req, res)
  }
  return {
    name: 'varuna:local-data',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

// Belt and braces for the watcher. The ignore list above covers the directories
// we know about, but antivirus, OneDrive or a stray build can lock any file at
// any moment. chokidar surfaces that as an 'error' event, and an unhandled
// 'error' event terminates Node — so one momentarily-locked file would kill
// `npm run dev`. Logging it keeps the server alive instead.
function watcherResilience() {
  return {
    name: 'varuna:watcher-resilience',
    apply: 'serve',
    configureServer(server) {
      server.watcher.on('error', (err) => {
        server.config.logger.warn(
          `  [watch] skipped ${err?.code || 'error'} on ${err?.path || err?.message || err}`,
        )
      })
    },
  }
}

// The website's media (public/site, ~15 MB) and its service worker belong to the
// Vercel build only (`--mode site`); the desktop and Android builds drop them.
function siteOnlyAssets(mode) {
  let outDir = 'dist'
  return {
    name: 'varuna-site-only-assets',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir)
    },
    async closeBundle() {
      if (mode === 'site') return
      const { rm } = await import('node:fs/promises')
      await rm(path.join(outDir, 'site'), { recursive: true, force: true })
      await rm(path.join(outDir, 'sw.js'), { force: true })
    },
  }
}

// Search and link-preview tags for the public website (`--mode site` only), so
// Google shows the project and its creator for "VARUNA AI" / "VARUNA GCS". The
// <noscript> copy gives crawlers the key facts even before the app's script runs.
function siteSeo(mode) {
  const URL_ = 'https://varuna-gcs.vercel.app/'
  const TITLE = 'VARUNA GCS by Aditya Gautam & Samar Garg · VARUNA AI drone and river-cleaning boat'
  const DESC = 'VARUNA AI, created by Aditya Gautam and Samar Garg: an AI drone that finds floating plastic and Nirmal Dhara Jalyan, a solar autonomous boat that collects it, run from the VARUNA GCS ground-control app.'
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        '@id': `${URL_}#aditya-gautam`,
        name: 'Aditya Gautam',
        jobTitle: 'Creator of VARUNA AI',
        affiliation: { '@type': 'EducationalOrganization', name: 'Bhai Parmanand Vidya Mandir' },
        url: URL_,
      },
      {
        '@type': 'Person',
        '@id': `${URL_}#samar-garg`,
        name: 'Samar Garg',
        jobTitle: 'Co-creator of VARUNA AI',
        affiliation: { '@type': 'EducationalOrganization', name: 'Bhai Parmanand Vidya Mandir' },
        url: URL_,
      },
      {
        '@type': 'WebSite',
        '@id': `${URL_}#site`,
        name: 'VARUNA AI',
        alternateName: ['VARUNA GCS', 'Varuna GCS', 'Varuna AI GCS', 'VARUNA AI Ground Control'],
        url: URL_,
        author: [{ '@id': `${URL_}#aditya-gautam` }, { '@id': `${URL_}#samar-garg` }],
        creator: [{ '@id': `${URL_}#aditya-gautam` }, { '@id': `${URL_}#samar-garg` }],
      },
      {
        '@type': 'SoftwareApplication',
        name: 'VARUNA GCS',
        alternateName: 'VARUNA AI Ground Control Station',
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web, Windows, Android',
        url: `${URL_}app`,
        description: DESC,
        author: [{ '@id': `${URL_}#aditya-gautam` }, { '@id': `${URL_}#samar-garg` }],
        creator: [{ '@id': `${URL_}#aditya-gautam` }, { '@id': `${URL_}#samar-garg` }],
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
      },
    ],
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const head = [
    `<meta name="description" content="${esc(DESC)}" />`,
    '<meta name="author" content="Aditya Gautam, Samar Garg" />',
    '<meta name="keywords" content="VARUNA AI, VARUNA GCS, Varuna AI GCS, Aditya Gautam, Samar Garg, Nirmal Dhara Jalyan, river cleaning drone, autonomous boat, plastic detection, ground control station" />',
    '<meta name="robots" content="index, follow" />',
    `<link rel="canonical" href="${URL_}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="VARUNA AI" />',
    `<meta property="og:title" content="${esc(TITLE)}" />`,
    `<meta property="og:description" content="${esc(DESC)}" />`,
    `<meta property="og:url" content="${URL_}" />`,
    `<meta property="og:image" content="${URL_}site/p-poster.jpg" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${esc(TITLE)}" />`,
    `<meta name="twitter:description" content="${esc(DESC)}" />`,
    `<meta name="twitter:image" content="${URL_}site/p-poster.jpg" />`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\u003c')}</script>`,
  ].join('\n    ')
  const body = `<noscript>
      <h1>VARUNA GCS · VARUNA AI by Aditya Gautam &amp; Samar Garg</h1>
      <p>${esc(DESC)}</p>
      <p>VARUNA AI and the VARUNA GCS ground-control app were created by Aditya Gautam and Samar Garg, Bhai Parmanand Vidya Mandir (theme: Environment &amp; Sustainability).</p>
    </noscript>`
  return {
    name: 'varuna-site-seo',
    transformIndexHtml(html) {
      if (mode !== 'site') return html
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(TITLE)}</title>\n    ${head}`)
        .replace('<div id="root"></div>', `<div id="root"></div>\n    ${body}`)
    },
  }
}
