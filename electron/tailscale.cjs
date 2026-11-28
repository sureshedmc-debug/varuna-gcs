// The devices on Tailscale (the Node twin of boat-pi/tailscale.py).
//
// Over Wi-Fi the drone's phone is found by shouting on the local network.
// Tailscale has no local network to shout on: every device has its own 100.x
// address (and a MagicDNS name like varuna-drone) and reaches the others
// straight through, so the way to find the phone is to ask Tailscale which
// peers this computer knows and try each.
//
// Nothing here throws: without Tailscale installed, or logged out, the list is
// empty and the caller carries on with Wi-Fi exactly as before.

'use strict'

const { execFile } = require('node:child_process')
const fs = require('node:fs')

const CACHE_MS = 15000 // `tailscale status` asks the daemon: not once per attempt
const TIMEOUT_MS = 6000
// Peers whose name says they are one of ours (or that are Android phones) are tried first.
const PHONE_WORDS = ['varuna', 'drone', 'boat', 'phone', 'cam', 'android', 'mobile']
const EXES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

let cache = { at: 0, peers: [], myIp: null, running: null }

function exe() {
  for (const p of EXES) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* not readable */
    }
  }
  return 'tailscale' // on PATH, or not installed (the call then just fails)
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

function ipv4(list) {
  for (const v of list || []) {
    const ip = cleanIp(v)
    if (ip) return ip
  }
  return null
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
        const peers = []
        for (const node of Object.values(data?.Peer || {})) {
          const ip = ipv4(node?.TailscaleIPs)
          if (!ip) continue
          peers.push({
            ip,
            name: String(node?.DNSName || '').split('.')[0] || String(node?.HostName || ''),
            os: String(node?.OS || ''),
            connected: !!node?.Online,
          })
        }
        finish(peers, ipv4(data?.Self?.TailscaleIPs))
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

/** Peer addresses to try, likeliest phones first. Empty when Tailscale is off. */
async function phoneIps(extra = []) {
  const out = []
  const add = (v) => {
    const ip = cleanIp(v)
    if (ip && !out.includes(ip)) out.push(ip)
  }
  for (const ip of extra) add(ip)
  for (const ip of String(process.env.VARUNA_TAILSCALE_PHONES || '').split(/[\s,]+/)) add(ip)
  const { peers } = await refresh()
  const ours = []
  const others = []
  const down = []
  for (const p of peers) {
    const name = p.name.toLowerCase()
    const mine = PHONE_WORDS.some((w) => name.includes(w)) || p.os.toLowerCase() === 'android'
    const bucket = !p.connected ? down : mine ? ours : others
    bucket.push(p.ip)
  }
  for (const ip of [...ours, ...others, ...down]) add(ip)
  return out
}

/** What Tailscale can see here, in one line for the log. */
async function describe() {
  const { peers, myIp } = await refresh()
  if (!myIp) return 'Tailscale not connected here'
  const live = peers.filter((p) => p.connected)
  return `Tailscale ${myIp}: ${live.length}/${peers.length} devices online` +
    (live.length ? ` (${live.slice(0, 4).map((p) => `${p.name} ${p.ip}`).join(', ')})` : '')
}

/** The last peer list read, without asking again (never blocks). */
function cached() {
  return { peers: cache.peers, myIp: cache.myIp }
}

module.exports = { phoneIps, describe, refresh, cached }
