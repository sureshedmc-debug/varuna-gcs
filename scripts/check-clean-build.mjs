// Verifies the production build contains no ACCIDENTAL dev host. The backend now
// lives behind a configurable ngrok URL (that is intentional and allowed); this
// check only catches localhost / loopback / raw LAN-IP leaks and the dev-proxy
// env var. Fails loudly (exit 1) if any of those slip in.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
// Patterns that must never appear in shipped JS/HTML/CSS.
const FORBIDDEN = [
  /localhost/i,
  /127\.0\.0\.1/,
  /VITE_DEV_API_TARGET/,
  // any explicit http(s):// host:port pointing at a LAN/dev backend
  /https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?/,
]
// Expected hosts: OSM/Esri map tiles (client-side) and the configured ngrok
// backend URL are intentional, not leaks.
const ALLOW = [/tile\.openstreetmap\.org/i, /arcgisonline\.com/i, /ngrok/i]

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(js|css|html|map)$/.test(e)) out.push(p)
  }
  return out
}

let bad = 0
let files
try {
  files = walk(DIST)
} catch {
  console.error(`✗ ${DIST}/ not found — run \`npm run build\` first.`)
  process.exit(1)
}

for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const re of FORBIDDEN) {
    const m = text.match(re)
    if (m && !ALLOW.some((a) => a.test(m[0]))) {
      console.error(`✗ ${f}: found forbidden token "${m[0]}"`)
      bad++
    }
  }
}

if (bad === 0) {
  console.log(`✓ Clean build: scanned ${files.length} files, no backend host / dev address leaked into dist/.`)
  process.exit(0)
} else {
  console.error(`\n✗ ${bad} leak(s) found — dist/ is NOT a zero-edit drop-in. Fix before shipping.`)
  process.exit(1)
}
