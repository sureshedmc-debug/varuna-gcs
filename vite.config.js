import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

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
    if (now - (lastLogged.get(code) || 0) > 15000) {
      lastLogged.set(code, now)
      const hint =
        code === 'ENOTFOUND'
          ? `cannot resolve it — is Netbird connected? (\`netbird status\`)`
          : code === 'ECONNREFUSED'
            ? 'nothing is listening there — is the Pi backend running?'
            : err?.message || code
      console.warn(`
  [pi] ${target} unreachable: ${hint}
  The UI still works; set VITE_DEV_API_TARGET in .env.local to change the target.
`)
    }
    // Fail the request fast. A WebSocket upgrade hands us a raw socket, which
    // has no writeHead — ending it is all that's needed there.
    try {
      if (res && typeof res.writeHead === 'function') {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: `Backend unreachable (${code})` }))
      } else if (res && typeof res.end === 'function') {
        res.end()
      }
    } catch {
      /* socket already gone */
    }
  }

  const proxy = Object.fromEntries(
    proxyPaths.map((p) => [
      p,
      {
        target,
        changeOrigin: true,
        ws: true,
        secure: false,
        configure: (px) => {
          px.on('error', onProxyError)
          // Vite registers its OWN 'error' listener immediately after this
          // hook returns - one full stack trace per failed request. It cannot
          // be removed from in here because it does not exist yet, so drop it
          // on the next tick, by which time it is registered. Doing it this
          // way rather than through a customLogger matters: a customLogger
          // built with createLogger() hardcodes level 'info', which silently
          // overrode --logLevel and clearScreen for builds too.
          setTimeout(() => {
            for (const l of px.listeners('error')) {
              if (l !== onProxyError) px.removeListener('error', l)
            }
          }, 0)
        },
      },
    ])
  )

  return {
    plugins: [react(), watcherResilience()],
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
        ],
      },
    },
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
      // Pre-bundle heavy dependencies
      include: ['react', 'react-dom', 'framer-motion', 'three', 'leaflet', 'react-leaflet'],
      // Exclude WASM/large binaries from optimization
      exclude: ['onnxruntime-web']
    },
  }
})

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
