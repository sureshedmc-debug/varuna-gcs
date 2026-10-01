// Launches the desktop app from npm scripts.
//
//   node electron/launch.cjs           → run the built app (serves dist/)
//   node electron/launch.cjs --dev     → start Vite, then open Electron on it
//   node electron/launch.cjs --local   → open Electron on an already-running
//                                        Vite dev server (localhost:5173).
//                                        Run `npm run dev` first in another
//                                        terminal, then run this.
//
// It exists for one reason: VS Code-family IDEs (VS Code, Kiro, Cursor) set
// ELECTRON_RUN_AS_NODE=1 in their integrated terminals. Electron then runs as
// plain Node and never opens a window, with no error. We clear it here.

const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')
const electronBinary = require('electron') // resolves to the binary path under Node

const root = path.join(__dirname, '..')
const dev   = process.argv.includes('--dev')
const local = process.argv.includes('--local')

// The port Vite uses when you run `npm run dev`. If you've changed it in
// vite.config.js, change it here too.
const LOCAL_PORT = 5173
const LOCAL_URL  = `http://localhost:${LOCAL_PORT}/`

function runElectron(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(electronBinary, [root], { stdio: 'inherit', env, windowsHide: false })
}

// Polls the Vite dev server until it responds, so we don't open Electron
// against a URL that isn't ready yet.
function waitForVite(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function attempt() {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() >= deadline) {
          return reject(new Error(
            `Vite dev server not reachable at ${url} after ${timeout / 1000}s.\n` +
            `Make sure "npm run dev" is running in another terminal first.`
          ))
        }
        setTimeout(attempt, 500)
      })
      req.end()
    }
    attempt()
  })
}

async function main() {
  // --local: attach to an already-running Vite dev server on localhost:5173
  if (local) {
    console.log(`[varuna] --local mode: waiting for Vite dev server at ${LOCAL_URL} ...`)
    await waitForVite(LOCAL_URL)
    console.log(`[varuna] Vite is up — opening the desktop window on ${LOCAL_URL}`)
    const child = runElectron({ VITE_DEV_SERVER_URL: LOCAL_URL })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

  // --dev: start Vite ourselves, then open Electron
  if (dev) {
    const { createServer } = await import('vite')
    const server = await createServer({ root })
    await server.listen()
    const url = server.resolvedUrls.local[0]
    console.log(`[varuna] Vite dev server on ${url} — opening the desktop window`)
    const child = runElectron({ VITE_DEV_SERVER_URL: url })
    child.on('exit', async (code) => {
      await server.close()
      process.exit(code ?? 0)
    })
    return
  }

  // default: serve built dist/ via the loopback server
  const child = runElectron()
  child.on('exit', (code) => process.exit(code ?? 0))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
