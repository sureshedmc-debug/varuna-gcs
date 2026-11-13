import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import path from 'node:path'
import { FAQ, TEAM } from './src/site/content.js'

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
    `<script type="application/ld+json">${jsonLd(ld)}</script>`,
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
    // /about: a plain HTML page (no JavaScript needed to read it) that answers
    // "who created VARUNA AI?" for search engines and AI answer tools.
    generateBundle() {
      if (mode !== 'site') return
      this.emitFile({ type: 'asset', fileName: 'about/index.html', source: aboutPage(URL_, esc) })
    },
  }
}

// JSON for a <script> tag: "<" escaped so text can never close the tag early.
function jsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c')
}

function aboutPage(URL_, esc) {
  const PAGE = `${URL_}about`
  const [who, ...rest] = FAQ
  const title = 'Who created VARUNA AI? Aditya Gautam & Samar Garg'
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'AboutPage',
        '@id': `${PAGE}#page`,
        url: PAGE,
        name: title,
        description: who.a,
        isPartOf: { '@id': `${URL_}#site` },
        about: TEAM.makers.map((p) => ({ '@id': `${URL_}#${p.name.toLowerCase().replace(/\s+/g, '-')}` })),
      },
      ...TEAM.makers.map((p) => ({
        '@type': 'Person',
        '@id': `${URL_}#${p.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: p.name,
        jobTitle: p.role.split(' · ')[0],
        affiliation: { '@type': 'EducationalOrganization', name: TEAM.school },
        url: PAGE,
      })),
      {
        '@type': 'FAQPage',
        '@id': `${PAGE}#faq`,
        mainEntity: FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  }
  const makers = TEAM.makers.map((p) => `
        <div class="maker"><span class="av">${esc(p.initials)}</span><div><b>${esc(p.name)}</b><span>${esc(p.role)}</span></div></div>`).join('')
  const qa = rest.map((f) => `
      <h3>${esc(f.q)}</h3>
      <p>${esc(f.a)}</p>`).join('')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} · VARUNA AI</title>
    <meta name="description" content="${esc(who.a)}" />
    <meta name="author" content="${esc(TEAM.makers.map((p) => p.name).join(', '))}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${PAGE}" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <meta property="og:type" content="profile" />
    <meta property="og:site_name" content="VARUNA AI" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(who.a)}" />
    <meta property="og:url" content="${PAGE}" />
    <meta property="og:image" content="${URL_}site/p-poster.jpg" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">${jsonLd(ld)}</script>
    <style>
      :root { color-scheme: dark; --ink: #f4f7fb; --ink2: rgba(236,242,250,.74); --ink3: rgba(236,242,250,.5); --line: rgba(255,255,255,.1); }
      * { box-sizing: border-box; }
      body { margin: 0; background: #04060a; color: var(--ink); font: 16px/1.7 Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; }
      a { color: #7dd3fc; }
      .wrap { max-width: 820px; margin: 0 auto; padding: 0 20px; }
      header { padding: 22px 0; border-bottom: 1px solid var(--line); }
      header a { color: var(--ink); text-decoration: none; font-weight: 900; letter-spacing: .02em; }
      header a span, .grad { background: linear-gradient(100deg, #67e8f9, #7dd3fc 35%, #a78bfa); -webkit-background-clip: text; background-clip: text; color: transparent; }
      main { padding: 56px 0 40px; }
      .kicker { font-size: 12px; letter-spacing: .22em; text-transform: uppercase; color: #67e8f9; font-weight: 700; }
      h1 { font-size: clamp(34px, 6vw, 56px); line-height: 1.05; letter-spacing: -.035em; margin: 12px 0 18px; }
      .lead { font-size: clamp(17px, 2vw, 20px); color: var(--ink2); margin: 0; }
      .makers { margin: 34px 0; border: 1px solid rgba(255,255,255,.16); border-radius: 24px; padding: 8px 24px; background: linear-gradient(160deg, rgba(103,232,249,.1), rgba(139,92,246,.08) 60%, rgba(255,255,255,.02)); }
      .maker { display: flex; align-items: center; gap: 16px; padding: 16px 0; }
      .maker + .maker { border-top: 1px solid var(--line); }
      .av { flex: none; width: 54px; height: 54px; border-radius: 17px; display: grid; place-items: center; font-weight: 900; font-size: 21px; color: #05070a; background: linear-gradient(100deg, #67e8f9, #7dd3fc 35%, #a78bfa); }
      .maker b { display: block; font-size: 20px; letter-spacing: -.02em; }
      .maker span { font-size: 14px; color: var(--ink2); }
      .facts { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px 24px; margin: 0 0 40px; }
      .facts small { display: block; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--ink3); }
      figure { margin: 0 0 44px; }
      figure img { display: block; width: 100%; height: auto; border-radius: 20px; border: 1px solid var(--line); }
      figcaption { font-size: 13px; color: var(--ink3); margin-top: 10px; }
      h2 { font-size: 28px; letter-spacing: -.025em; margin: 0 0 8px; }
      h3 { font-size: 19px; margin: 28px 0 6px; letter-spacing: -.01em; }
      p { color: var(--ink2); margin: 0; }
      .links { display: flex; flex-wrap: wrap; gap: 10px; margin: 44px 0 0; padding: 0; list-style: none; }
      .links a { display: inline-block; padding: 11px 18px; border-radius: 999px; border: 1px solid rgba(255,255,255,.16); color: var(--ink); text-decoration: none; font-weight: 600; font-size: 15px; }
      .links a:hover { border-color: #7dd3fc; }
      footer { border-top: 1px solid var(--line); padding: 26px 0 40px; font-size: 13px; color: var(--ink3); }
      @media (max-width: 560px) { .facts { grid-template-columns: 1fr; } .makers { padding: 4px 18px; } }
    </style>
  </head>
  <body>
    <header><div class="wrap"><a href="/">VARUNA <span>AI</span></a></div></header>
    <main class="wrap">
      <div class="kicker">About VARUNA AI</div>
      <h1>${esc(who.q.replace(/\?$/, ''))}<span class="grad">?</span></h1>
      <p class="lead">${esc(who.a)}</p>
      <div class="makers">${makers}
      </div>
      <div class="facts">
        <div><small>School</small>${esc(TEAM.school)}</div>
        <div><small>Theme</small>${esc(TEAM.theme)}</div>
        <div><small>Drone</small>Varuna, the AI aerial scout</div>
        <div><small>Boat</small>Nirmal Dhara Jalyan</div>
      </div>
      <figure>
        <img src="/site/p-poster.jpg" alt="VARUNA AI, the river-cleaning drone and boat by ${esc(TEAM.makers.map((p) => p.name).join(' and '))}" loading="lazy" />
        <figcaption>VARUNA AI by ${esc(TEAM.makers.map((p) => p.name).join(' and '))}.</figcaption>
      </figure>
      <h2>About the project</h2>${qa}
      <ul class="links">
        <li><a href="/">Explore VARUNA AI</a></li>
        <li><a href="/try">Try the AI on your webcam</a></li>
        <li><a href="/app">Open the VARUNA GCS app</a></li>
      </ul>
    </main>
    <footer><div class="wrap">© ${new Date().getFullYear()} VARUNA AI · Nirmal Dhara Jalyan · Created by ${esc(TEAM.makers.map((p) => p.name).join(' & '))}</div></footer>
  </body>
</html>
`
}
