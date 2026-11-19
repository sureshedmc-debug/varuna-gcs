// The phones on NetBird (the Node twin of boat-pi/netbird.py).
//
// Over Wi-Fi the drone's phone is found by shouting on the local network.
// NetBird has no local network to shout on: every device has its own 100.x
// address and reaches the others straight through, so the way to find the
// phone is to ask NetBird which peers this computer knows and try each.
//
// Nothing here throws: without NetBird installed, or with it logged out, the
// list is empty and the caller carries on with Wi-Fi exactly as before.

'use strict'

const { execFile } = require('node:child_process')
const fs = require('node:fs')

const CACHE_MS = 15000 // `netbird status` is a daemon call: not once per attempt
const TIMEOUT_MS = 6000
// Peers whose name says they are one of ours are tried first.
const PHONE_WORDS = ['phone', 'drone', 'boat', 'varuna', 'android', 'cam', 'mobile']
const EXES = [
  'netbird',
  'C:\\Program Files\\Netbird\\netbird.exe',
  'C:\\Program Files\\NetBird\\netbird.exe',
  '/usr/bin/netbird',
  '/usr/local/bin/netbird',
  '/opt/homebrew/bin/netbird',
]

let cache = { at: 0, peers: [], myIp: null, running: null }

function exe() {
  for (const p of EXES) {
    if (p === 'netbird') continue
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* not readable */
    }
  }
  return 'netbird' // on PATH, or not installed (the call then just fails)
}

function cleanIp(value) {
  const ip = String(value || '').split('/')[0].trim()
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  for (const p of parts) {
    if (!/^\d+$/.test(p) || Number(p) > 255) return null
  }
  return ip
}

function read() {
  return new Promise((resolve) => {
    let done = false
    const finish = (peers, myIp) => {
      if (done) return
      done = true
      resolve({ peers, myIp })
    }
    try {
      execFile(exe(), ['status', '--json'], { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) return finish([], null)
        let data
        try {
          data = JSON.parse(stdout || '{}')
        } catch {
          return finish([], null)
        }
        const details = (data?.peers?.details) || []
        const peers = []
        for (const p of details) {
          const ip = cleanIp(p?.netbirdIp || p?.ip)
          if (!ip) continue
          peers.push({
            ip,
            name: String(p?.fqdn || p?.name || '').split('.')[0],
            connected: String(p?.status || '').toLowerCase() === 'connected',
          })
        }
        finish(peers, cleanIp(data?.netbirdIp))
      })
    } catch {
      finish([], null)
    }
  })
}

/** Refresh at most every CACHE_MS; one call at a time. */
async function refresh(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache
  if (cache.running) return cache.running
  cache.running = read().then(({ peers, myIp }) => {
    cache = { at: Date.now(), peers, myIp, running: null }
    return cache
  })
  return cache.running
}

/** Peer addresses to try, likeliest phones first. Empty when NetBird is off. */
async function phoneIps(extra = []) {
  const out = []
  const add = (v) => {
    const ip = cleanIp(v)
    if (ip && !out.includes(ip)) out.push(ip)
  }
  for (const ip of extra) add(ip)
  for (const ip of String(process.env.VARUNA_NETBIRD_PHONES || '').split(/[\s,]+/)) add(ip)
  const { peers } = await refresh()
  const ours = []
  const others = []
  const down = []
  for (const p of peers) {
    const name = p.name.toLowerCase()
    const bucket = !p.connected ? down : PHONE_WORDS.some((w) => name.includes(w)) ? ours : others
    bucket.push(p.ip)
  }
  for (const ip of [...ours, ...others, ...down]) add(ip)
  return out
}

/** What NetBird can see here, in one line for the log. */
async function describe() {
  const { peers, myIp } = await refresh()
  if (!myIp) return 'NetBird not connected here'
  const live = peers.filter((p) => p.connected)
  return `NetBird ${myIp}: ${live.length}/${peers.length} peers up` +
    (live.length ? ` (${live.slice(0, 4).map((p) => `${p.name} ${p.ip}`).join(', ')})` : '')
}

/** The last peer list read, without asking again (never blocks). */
function cached() {
  return { peers: cache.peers, myIp: cache.myIp }
}

module.exports = { phoneIps, describe, refresh, cached }
