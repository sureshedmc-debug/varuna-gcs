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
  const proxy = Object.fromEntries(
    proxyPaths.map((p) => [
      p,
      { target, changeOrigin: true, ws: true, secure: false },
    ])
  )

  return {
    plugins: [react()],
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
      }
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
