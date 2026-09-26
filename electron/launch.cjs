// Launches the desktop app from npm scripts.
//
//   node electron/launch.cjs         → run the built app (serves dist/)
//   node electron/launch.cjs --dev   → start Vite, then open Electron on it
//
// It exists for one reason: VS Code-family IDEs (VS Code, Kiro, Cursor) set
// ELECTRON_RUN_AS_NODE=1 in their integrated terminals. Electron then runs as
// plain Node and never opens a window, with no error. We clear it here.

const { spawn } = require('node:child_process')
const path = require('node:path')
const electronBinary = require('electron') // resolves to the binary path under Node

const root = path.join(__dirname, '..')
const dev = process.argv.includes('--dev')

function runElectron(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(electronBinary, [root], { stdio: 'inherit', env, windowsHide: false })
}

async function main() {
  if (!dev) {
    const child = runElectron()
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }
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
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
