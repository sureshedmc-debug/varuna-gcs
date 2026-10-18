import { defineConfig } from 'vite'

// Standalone sandbox for the river intro experiment (port 5174), separate from the app on 5173.
export default defineConfig({ root: __dirname, server: { port: 5174, strictPort: true } })
