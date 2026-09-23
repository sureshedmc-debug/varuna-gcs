import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The production bundle NEVER contains a backend host: the app calls the API via
// relative paths (see src/api/client.js), resolved against window.location.origin
// at runtime. The dev proxy below exists ONLY for `npm run dev` on the laptop and
// is never emitted into `dist/`.
//
// Point dev at the real Pi by setting VITE_DEV_API_TARGET in .env.local, e.g.
//   VITE_DEV_API_TARGET=http://192.168.1.42:8000
//   VITE_DEV_API_TARGET=https://your-tunnel.ngrok-free.app
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
