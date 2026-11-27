// Builds the Android app (android/): the same frontend as the desktop app in a
// WebView, with the desktop app's own server running on the phone.
//
//   npm run android:build            release APK (signed if android/keystore.properties exists)
//   node scripts/build-android.mjs --debug [--x86] [--skip-web] [--no-gradle]
//
// --debug     debug APK (WebView inspectable from chrome://inspect)
// --x86       also package the emulator's ABI (x86_64)
// --skip-web  reuse dist/ as it is instead of running `vite build`
// --no-gradle only prepare android/app/src/main/assets
//
// What goes into the APK's assets:
//   www/             dist/, minus files the phone never loads, with the Home video
//                    re-encoded from 4K to 1080p (phones stutter on 4K at 46 Mbit/s)
//                    and android/web/android-bridge.js added to index.html
//   nodejs-project/  android/nodejs-project/main.js + electron/server.cjs,
//                    proxyGuard.cjs, localData.cjs and http-proxy

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const android = path.join(root, 'android')
const assets = path.join(android, 'app', 'src', 'main', 'assets')
const cache = path.join(android, '.cache')
const args = new Set(process.argv.slice(2))
const debug = args.has('--debug')

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) {
    console.error(`\n[android] ${cmd} ${argv.join(' ')} failed (${r.status ?? r.error?.message})`)
    process.exit(1)
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return
  // Files copied from public/ can be read-only, which stops Windows deleting them.
  for (const e of fs.readdirSync(p, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) fs.chmodSync(path.join(e.parentPath ?? e.path, e.name), 0o666)
  }
  fs.rmSync(p, { recursive: true, force: true })
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  fs.chmodSync(to, 0o666)
}

function copyDir(from, to, skip = () => false) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const rel = path.relative(from, src)
    if (skip(src)) continue
    if (e.isDirectory()) copyDir(src, path.join(to, rel), skip)
    else copyFile(src, path.join(to, rel))
  }
}

// ---------------------------------------------------------------- 1. frontend
// Built into its own folder, so the desktop app's dist/ is left alone.
const dist = path.join(cache, 'dist')
if (!args.has('--skip-web')) {
  rmrf(dist)
  run('npx', ['vite', 'build', '--outDir', 'android/.cache/dist', '--emptyOutDir'])
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('[android] the web build is missing: run without --skip-web')
  process.exit(1)
}

// The Node runtime for Android is a 186 MB download, not kept in git.
const libnode = path.join(android, 'app', 'libnode')
if (!fs.existsSync(path.join(libnode, 'bin', 'arm64-v8a', 'libnode.so')) || !fs.existsSync(path.join(libnode, 'include', 'node', 'node.h'))) {
  console.error('[android] android/app/libnode is missing. Download nodejs-mobile-v18.20.4-android.zip from\n' +
    '          https://github.com/nodejs-mobile/nodejs-mobile/releases/tag/v18.20.4\n' +
    '          and unzip it there, so that android/app/libnode/bin/<abi>/libnode.so and android/app/libnode/include/node exist.')
  process.exit(1)
}

rmrf(assets)
const www = path.join(assets, 'www')
const rel = (p) => path.relative(dist, p).replace(/\\/g, '/')
copyDir(dist, www, (p) => {
  const r = rel(p)
  // Vite also emits hashed copies of the ONNX Runtime .wasm files; the app loads
  // them from /ort/ (env.wasm.wasmPaths), so those 33 MB are never requested.
  if (/^assets\/ort-wasm-.*\.wasm$/.test(r)) return true
  // One Home video is enough (H.264 plays on every Android WebView), and it is
  // re-encoded below.
  if (r === 'ecosystem-day.webm' || r === 'ecosystem-day.mp4') return true
  return false
})

// The Home video for phones: 1080p instead of 4K.
const videoSrc = path.join(dist, 'ecosystem-day.mp4')
if (fs.existsSync(videoSrc)) {
  const st = fs.statSync(videoSrc)
  const small = path.join(cache, `ecosystem-day-1080-${st.size}-${Math.round(st.mtimeMs)}.mp4`)
  if (!fs.existsSync(small)) {
    fs.mkdirSync(cache, { recursive: true })
    const tmp = small + '.tmp.mp4'
    console.log('[android] re-encoding the Home video to 1080p…')
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoSrc, '-an',
      '-vf', 'scale=1920:-2:flags=lanczos', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
      '-preset', 'slow', '-crf', '25', '-movflags', '+faststart', tmp], { stdio: 'inherit' })
    if (r.status === 0) fs.renameSync(tmp, small)
    else console.warn('[android] WARNING: ffmpeg failed or is not installed: packaging the original 4K video (+75 MB, and it stutters on phones)')
  }
  copyFile(fs.existsSync(small) ? small : videoSrc, path.join(www, 'ecosystem-day.mp4'))
}

// The shell bridge (window.varuna + file saving) runs before the app's own script.
copyFile(path.join(android, 'web', 'android-bridge.js'), path.join(www, 'android-bridge.js'))
const indexFile = path.join(www, 'index.html')
let html = fs.readFileSync(indexFile, 'utf8')
// It goes right after the viewport <meta>, which it rewrites before anything is
// laid out (the page is laid out 1200 px wide on a phone, see android-bridge.js).
const viewportMeta = /<meta\s+name="viewport"[^>]*>/i
if (!viewportMeta.test(html) || !html.includes('</head>')) {
  console.error('[android] index.html has no viewport <meta> / </head> to add the bridge to')
  process.exit(1)
}
copyFile(path.join(android, 'web', 'android.css'), path.join(www, 'android.css'))
html = html.replace(viewportMeta, (m) => `${m}\n    <script src="/android-bridge.js"></script>`)
// After the app's own stylesheet, so the phone-width fixes win.
html = html.replace('</head>', '  <link rel="stylesheet" href="/android.css" />\n  </head>')
fs.writeFileSync(indexFile, html)

// ---------------------------------------------------------------- 2. server
const proj = path.join(assets, 'nodejs-project')
copyFile(path.join(android, 'nodejs-project', 'main.js'), path.join(proj, 'main.js'))
for (const f of ['server.cjs', 'proxyGuard.cjs', 'localData.cjs']) copyFile(path.join(root, 'electron', f), path.join(proj, f))
copyFile(path.join(root, 'public', 'config', 'rivers.json'), path.join(proj, 'rivers.json'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(proj, 'version.json'), JSON.stringify({ version: pkg.version }))
// http-proxy and what it needs, code only.
const keep = /\.(js|cjs|json)$/
for (const mod of ['http-proxy', 'eventemitter3', 'requires-port', 'follow-redirects']) {
  const from = path.join(root, 'node_modules', mod)
  if (!fs.existsSync(from)) {
    console.error(`[android] node_modules/${mod} is missing: run npm install`)
    process.exit(1)
  }
  copyDir(from, path.join(proj, 'node_modules', mod), (p) => {
    const name = path.basename(p)
    if (fs.statSync(p).isDirectory()) return name === 'node_modules' || name === 'umd' || name === 'test' || name === 'examples'
    return !keep.test(name) || name === 'test.js' || name === 'renovate.json'
  })
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .reduce((n, e) => (e.isFile() ? n + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size : n), 0)
console.log(`[android] assets ready: www ${(size(www) / 1e6).toFixed(0)} MB, server ${(size(proj) / 1e3).toFixed(0)} kB`)
if (args.has('--no-gradle')) process.exit(0)

// ---------------------------------------------------------------- 3. APK
// Android Studio's own JDK and the SDK it installed, unless the environment says otherwise.
const env = { ...process.env }
const studioJdk = 'C:\\Program Files\\Android\\Android Studio\\jbr'
if (!env.JAVA_HOME && fs.existsSync(studioJdk)) env.JAVA_HOME = studioJdk
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
if (!fs.existsSync(sdk)) {
  console.error(`[android] Android SDK not found at ${sdk}: install Android Studio or set ANDROID_HOME`)
  process.exit(1)
}
const localProps = path.join(android, 'local.properties')
if (!fs.existsSync(localProps)) fs.writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, '/')}\n`)

const win = process.platform === 'win32'
const gradlew = path.join(android, win ? 'gradlew.bat' : 'gradlew')
const task = debug ? 'assembleDebug' : 'assembleRelease'
const gargs = [task, '--console=plain', '-q']
if (args.has('--x86')) gargs.push('-PwithX86')
const kind = debug ? 'debug' : 'release'
const outDir = path.join(android, 'app', 'build', 'outputs', 'apk', kind)
rmrf(outDir) // so an APK from an earlier build can never be picked up below
// .bat files need a shell on Windows (and quotes for a path with spaces); elsewhere run it directly.
run(win ? `"${gradlew}"` : gradlew, gargs, { cwd: android, env, shell: win })

// What Gradle says it built (not just "the first .apk in the folder").
let apk = null
try {
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'output-metadata.json'), 'utf8'))
  apk = meta.elements?.[0]?.outputFile || null
} catch {
  apk = fs.existsSync(outDir) ? fs.readdirSync(outDir).find((f) => f.endsWith('.apk')) : null
}
if (!apk || !fs.existsSync(path.join(outDir, apk))) {
  console.error('[android] Gradle finished but no APK was written to ' + outDir)
  process.exit(1)
}
const signed = !apk.includes('unsigned')
const release = path.join(root, 'release')
fs.mkdirSync(release, { recursive: true })
const final = path.join(release, `VARUNA-AI-${pkg.version}${debug ? '-debug' : ''}${args.has('--x86') ? '-x86' : ''}.apk`)
fs.copyFileSync(path.join(outDir, apk), final)
console.log(`[android] ${final} (${(fs.statSync(final).size / 1e6).toFixed(0)} MB${signed ? '' : ', UNSIGNED: add android/keystore.properties'})`)
