// Tiny persistent settings store for the desktop app, kept as JSON in Electron's
// per-user data folder. Three keys don't justify a dependency.
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

// A fixed, uncommon port. It must stay the same across launches: the app keeps
// its Groq keys, detection log, mission and settings in localStorage, which is
// scoped to the origin (http://127.0.0.1:<port>). A new port = a new origin =
// all of that appears wiped.
// boatAddress: the boat's own Pi (a second vehicle), proxied under /boat.
// Both default to the vehicles' Netbird addresses so a fresh install connects
// without typing them in; an address saved from System still wins.
const DEFAULT_PI_ADDRESS = 'http://100.99.158.25:8000'
const DEFAULT_BOAT_ADDRESS = 'http://100.99.71.176:8000'
const DEFAULTS = { piAddress: DEFAULT_PI_ADDRESS, boatAddress: DEFAULT_BOAT_ADDRESS, port: 47621, windowBounds: null }

let cache = null

function file() {
  return path.join(app.getPath('userData'), 'varuna-settings.json')
}

function load() {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }
  } catch {
    cache = { ...DEFAULTS }
  }
  // A blank saved address means "not set", so fall back to the default rather
  // than leaving the vehicle unreachable.
  if (!cache.piAddress) cache.piAddress = DEFAULT_PI_ADDRESS
  if (!cache.boatAddress) cache.boatAddress = DEFAULT_BOAT_ADDRESS
  return cache
}

function save(patch) {
  cache = { ...load(), ...patch }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    const tmp = file() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2))
    fs.renameSync(tmp, file())
  } catch (e) {
    console.error('[settings] save failed:', e.message)
  }
  return cache
}

module.exports = { load, save }
