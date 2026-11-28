// The drone straight from its phone, with no drone backend running.
//
// The drone carries a phone running VARUNA Cam (drone-pi/phone-link/varuna-cam):
// it streams the camera as H.264 (/h264) and its GPS + attitude
// (/location/stream). The Python backend (drone-pi/main.py, started by
// start_laptop_backend.bat) used to sit in between. This module does the same
// job inside the server that already serves the app (`npm run dev`), so the app
// works with nothing else to start:
//
//   - finds the phone by itself: asks "VARUNA_CAM?" on UDP 47800 at its last
//     addresses, and if none answers, at every address on this computer's
//     networks (an Android hotspot drops broadcasts, and gives the phone a new
//     address now and then). It follows the phone when its address changes.
//     The drone's phone shares this computer's Wi-Fi, and that address is
//     always preferred: the video then crosses the Wi-Fi directly. Tailscale
//     peers (tailscale.cjs) are asked as well and used only when nothing answers
//     locally — for a drone flown somewhere else entirely.
//   - answers the drone API the app uses (/api/ping, /api/health,
//     /api/telemetry, /api/ws, /api/camera/status, /api/camera/h264, /video_feed
//     …) from the phone, in the same formats as drone-pi/main.py.
//
// The phone's video is read once and shared by every viewer; a viewer that
// can't keep up skips to the next keyframe instead of falling behind.

'use strict'

const http = require('node:http')
const dgram = require('node:dgram')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const tailscale = require('./tailscale.cjs')

const DISCOVERY_PORT = 47800
const ASK_EVERY_MS = 1000          // ask the phone's last addresses this often
const SWEEP_EVERY_MS = 3000        // nobody answers there: ask every address on our networks this often
const ANSWER_FRESH_MS = 3500       // an answer older than this doesn't count
const IDLE_STOP_MS = 120000        // nobody used the drone API this long: stop looking for the phone
const LOCATION_STALE_MS = 3000     // no GPS line this long: reconnect
const VIDEO_STALL_MS = 4000        // no frame this long: reconnect
const VIDEO_KEEP_MS = 10000        // keep reading the video this long after the last viewer left
const VIEWER_WAIT_MS = 15000       // a viewer gets no frame this long: end it (the app reconnects)
const VIEWER_BACKLOG = 256 * 1024  // bytes waiting to go to a viewer before it skips to a keyframe
const GOP_MAX = 150                // frames kept from the last keyframe, for a viewer joining
const STAMP = Buffer.from('VARUNA-CAM-TIME!t=')

// ---------------------------------------------------------------- phone GPS (drone-pi/phone_gps.py)
const KEEP_MS = 30000
const STALE_MS = 3000
const FIX_MAX_AGE_S = 5
const NETWORK_MAX_AGE_S = 60
const COARSE_ACC_M = 30
const EXTRAPOLATE_MAX_S = 2
const ATT_MAX_GAP_S = 0.5
const OFFSET_WINDOW_MS = 10000

const r7 = (v) => Math.round(v * 1e7) / 1e7
const r2 = (v) => Math.round(v * 100) / 100
const r1 = (v) => Math.round(v * 10) / 10

function interpAngle(a, b, f) {
  const d = ((b - a + 540) % 360) - 180
  return (a + d * f + 360) % 360
}

function move(lat, lng, northM, eastM) {
  return [lat + northM / 111320, lng + eastM / (111320 * Math.cos((lat * Math.PI) / 180))]
}

function distM(lat1, lng1, lat2, lng2) {
  const n = (lat2 - lat1) * 111320
  const e = (lng2 - lng1) * 111320 * Math.cos((lat1 * Math.PI) / 180)
  return Math.hypot(n, e)
}

function createPhoneGps() {
  let latest = null
  let lastRx = 0
  let offsets = [] // [arrival ms, arrival - phone time (ms)]
  let offset = null // ms: this computer's clock minus the phone's
  let att = [] // [phone s, roll, pitch, hdg]
  let alt = [] // [phone s, rel_alt]
  let fixes = [] // [phone s, lat, lng, spd, crs]
  let fixInfo = {}
  const track = []

  function prune(series, nowS) {
    while (series.length && nowS - series[0][0] > KEEP_MS / 1000) series.shift()
  }

  function ingest(s, arrival = Date.now()) {
    const t = s && s.t
    if (typeof t !== 'number') return
    const ts = t / 1000
    latest = s
    lastRx = arrival
    offsets.push([arrival, arrival - t])
    while (offsets.length && arrival - offsets[0][0] > OFFSET_WINDOW_MS) offsets.shift()
    offset = Math.min(...offsets.map((o) => o[1]))
    if (s.hdg != null && s.pitch != null && s.roll != null) att.push([ts, +s.roll, +s.pitch, +s.hdg])
    if (s.rel_alt != null) alt.push([ts, +s.rel_alt])
    if (s.lat != null && s.lng != null) {
      const fixT = ts - (s.fix_age || 0) / 1000
      fixInfo = { fix: s.fix, acc: s.acc }
      if (!fixes.length || fixT - fixes[fixes.length - 1][0] > 0.05) {
        fixes.push([fixT, +s.lat, +s.lng, s.spd, s.crs])
        const last = track[track.length - 1]
        const at = arrival / 1000
        if (!last || at - last.t >= 0.5 || distM(last.lat, last.lng, s.lat, s.lng) > 1) {
          track.push({ t: r1(at), lat: s.lat, lng: s.lng, alt: r1(s.rel_alt || 0) })
          if (track.length > 900) track.shift()
        }
      }
    }
    prune(att, ts)
    prune(alt, ts)
    prune(fixes, ts)
  }

  const connected = () => latest !== null && Date.now() - lastRx < STALE_MS
  const phoneNowS = () => (Date.now() - (offset || 0)) / 1000
  const coarse = () => fixInfo.fix !== 'gps' || fixInfo.acc == null || +fixInfo.acc > COARSE_ACC_M
  const maxAge = () => (coarse() ? NETWORK_MAX_AGE_S : FIX_MAX_AGE_S)

  function positionAt(ts) {
    const fx = fixes
    if (!fx.length) return null
    const lastF = fx[fx.length - 1]
    if (ts >= lastF[0]) {
      const [t0, lat, lng, spd, crs] = lastF
      let dt = ts - t0
      if (dt > maxAge()) return null
      dt = Math.min(dt, EXTRAPOLATE_MAX_S)
      let vn = 0
      let ve = 0
      if (coarse()) {
        // a coarse fix: no movement to read from it
      } else if (spd != null && crs != null && spd >= 0) {
        vn = spd * Math.cos((crs * Math.PI) / 180)
        ve = spd * Math.sin((crs * Math.PI) / 180)
      } else if (fx.length >= 2 && t0 - fx[fx.length - 2][0] > 0 && t0 - fx[fx.length - 2][0] < 2.5) {
        const p = fx[fx.length - 2]
        const span = t0 - p[0]
        vn = ((lat - p[1]) * 111320) / span
        ve = ((lng - p[2]) * 111320 * Math.cos((lat * Math.PI) / 180)) / span
        if (Math.hypot(vn, ve) < 0.5) vn = ve = 0 // standing still: GPS wander
      }
      return move(lat, lng, vn * dt, ve * dt)
    }
    if (ts <= fx[0][0]) return fx[0][0] - ts < 1 ? [fx[0][1], fx[0][2]] : null
    for (let i = fx.length - 1; i > 0; i--) {
      const a = fx[i - 1]
      const b = fx[i]
      if (a[0] <= ts && ts <= b[0]) {
        const f = b[0] > a[0] ? (ts - a[0]) / (b[0] - a[0]) : 0
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
      }
    }
    return null
  }

  function seriesAt(series, ts, angleIdx = -1) {
    if (!series.length) return null
    const last = series[series.length - 1]
    if (ts >= last[0]) return ts - last[0] <= ATT_MAX_GAP_S ? last.slice(1) : null
    if (ts <= series[0][0]) return series[0][0] - ts <= ATT_MAX_GAP_S ? series[0].slice(1) : null
    for (let i = series.length - 1; i > 0; i--) {
      const a = series[i - 1]
      const b = series[i]
      if (a[0] <= ts && ts <= b[0]) {
        const f = b[0] > a[0] ? (ts - a[0]) / (b[0] - a[0]) : 0
        const out = []
        for (let k = 1; k < a.length; k++) out.push(k === angleIdx ? interpAngle(a[k], b[k], f) : a[k] + (b[k] - a[k]) * f)
        return out
      }
    }
    return null
  }

  /** Where the drone was and where the camera looked at phone time ts (s): a frame's pose. */
  function poseAtPhone(ts) {
    const pos = positionAt(ts)
    const a = seriesAt(att, ts, 3)
    const h = seriesAt(alt, ts)
    const s = latest || {}
    const out = {
      lat: pos ? r7(pos[0]) : null,
      lng: pos ? r7(pos[1]) : null,
      alt: h ? r2(h[0]) : null,
      hdg: a ? r1(a[2]) : null,
      roll: a ? r2(a[0]) : null,
      pitch: a ? r2(a[1]) : null,
      cam: true,
      src: 'phone',
    }
    if (s.fov) out.fov = r2(s.fov)
    const acc = s.acc != null ? s.acc : fixInfo.acc
    if (acc != null) out.acc = acc
    return out
  }

  function snapshot(url = null) {
    const s = latest || {}
    const fresh = connected()
    const pose = fresh ? poseAtPhone(phoneNowS()) : {}
    const hasFix = fresh && pose.lat != null
    return {
      connected: fresh,
      lat: hasFix ? pose.lat : null,
      lng: hasFix ? pose.lng : null,
      rel_alt: fresh ? (s.rel_alt ?? null) : null,
      alt_src: s.alt_src ?? null,
      alt_msl: fresh ? (s.alt_msl ?? null) : null,
      speed: hasFix ? (s.spd ?? null) : null,
      course: hasFix ? (s.crs ?? null) : null,
      heading: pose.hdg ?? null,
      roll: pose.roll ?? null,
      pitch: pose.pitch ?? null,
      accuracy: hasFix ? (s.acc ?? fixInfo.acc ?? null) : null,
      fix: hasFix ? (s.fix ?? fixInfo.fix ?? null) : null,
      satellites: s.sats ?? null,
      satellites_seen: s.sats_seen ?? null,
      home_lat: s.home_lat ?? null,
      home_lng: s.home_lng ?? null,
      fov: s.fov ?? null,
      problem: s.problem || (fresh ? '' : 'No GPS from the phone yet.'),
      url,
      age_s: latest ? r2((Date.now() - lastRx) / 1000) : null,
    }
  }

  function reset() {
    latest = null
    offsets = []
    offset = null
    att = []
    alt = []
    fixes = []
    fixInfo = {}
  }

  return {
    ingest,
    connected,
    snapshot,
    poseAtPhone,
    /** The pose at this computer's time t (s). */
    poseAtLocal: (t) => (offset == null ? null : poseAtPhone(t - offset / 1000)),
    reset,
    track: () => track,
    /** This computer's time (ms) for a phone time (ms). */
    toLocalMs: (phoneMs) => (offset == null ? null : phoneMs + offset),
  }
}

// ---------------------------------------------------------------- H.264 frames
/** Cuts VARUNA Cam's Annex-B stream into frames: each one ends with an access-unit delimiter. */
function createSplitter(onFrame) {
  let buf = Buffer.alloc(0)
  let scan = 0
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      const i = buf.indexOf(0x01, scan) // looking for 00 00 01 09 (an AUD)
      if (i < 0 || i + 1 >= buf.length) {
        scan = Math.max(0, buf.length - 3)
        break
      }
      if (i >= 2 && buf[i - 1] === 0 && buf[i - 2] === 0 && (buf[i + 1] & 0x1f) === 9) {
        let end = i - 2
        if (end > 0 && buf[end - 1] === 0) end-- // 4-byte start code
        if (end > 0) onFrame(buf.subarray(0, end))
        // The AUD is 00 00 00 01 09 F0: skip it.
        buf = buf.subarray(Math.min(buf.length, i + 3))
        scan = 0
        continue
      }
      scan = i + 1
    }
    if (buf.length > 4_000_000) {
      buf = Buffer.alloc(0) // no delimiter in 4 MB: not VARUNA Cam's stream, start over
      scan = 0
    }
  }
}

function isKeyframe(data) {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const t = data[i + 3] & 0x1f
      if (t === 5 || t === 7) return true
      if (t === 1) return false
      i += 2
    }
  }
  return false
}

/** VARUNA Cam's capture time (ms, phone clock) from a frame's SEI, or null. */
function captureStamp(data) {
  const i = data.indexOf(STAMP)
  if (i < 0 || i > 200) return null
  let ms = 0
  let k = i + STAMP.length
  const start = k
  for (; k < data.length && data[k] >= 0x30 && data[k] <= 0x39; k++) ms = ms * 10 + (data[k] - 0x30)
  return k > start ? ms : null
}

// ---------------------------------------------------------------- networks
/**
 * A Tailscale address (100.64.0.0/10, the carrier-grade NAT range Tailscale hands
 * out). Those peers are reached one by one, never by sweeping or broadcasting
 * a /24 — and they are not "the same network" as this computer even when this
 * computer has an address in the same range, because the traffic still goes
 * through Tailscale.
 */
function isTailnetAddress(ip) {
  const p = String(ip).split('.')
  return p[0] === '100' && Number(p[1]) >= 64 && Number(p[1]) <= 127
}

/** True if `ip` is on a real network this computer is on (so: a direct hop). */
function isLocalAddress(ip) {
  if (isTailnetAddress(ip)) return false
  if (String(ip).startsWith('127.')) return true // this computer itself
  return localNetworks().nets.includes(String(ip).split('.').slice(0, 3).join('.'))
}

function localNetworks() {
  const ips = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal || a.address.startsWith('169.254.')) continue
      if (isTailnetAddress(a.address)) continue // asked peer by peer, never swept
      ips.push(a.address)
    }
  }
  const nets = []
  for (const ip of ips) {
    const base = ip.split('.').slice(0, 3).join('.')
    if (!nets.includes(base)) nets.push(base)
  }
  return { ips, nets }
}

function readIpFile(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/[\s,]+/)
      .filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- the link
function createDroneDirect({ ipFile = null, log = console } = {}) {
  const gps = createPhoneGps()
  const answers = new Map() // ip → { at, port, info }
  let phone = null // { ip, port }
  let sock = null
  let timer = null
  let lastSweep = 0
  let lastUsed = 0
  let saved = ipFile ? readIpFile(ipFile) : []
  let lastFileRead = Date.now()
  // The Tailscale peers to ask as well as the local network (tailscale.cjs reads
  // them from Tailscale itself and keeps its own 15 s cache). Asking a peer is a
  // single UDP packet, exactly like asking a Wi-Fi address.
  let tailnetIps = []
  let tailnetAt = 0
  let tailnetSaid = false
  const aiDetections = []

  // ---- finding the phone
  function startFinding() {
    if (timer) return
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: false })
      sock.on('error', () => {})
      sock.on('message', (msg, rinfo) => {
        let info
        try {
          info = JSON.parse(msg.toString('utf8'))
        } catch {
          return
        }
        if (!info || !info.varuna_cam) return
        answers.set(rinfo.address, { at: Date.now(), port: Number(info.port) || 8080, info })
        choose()
      })
      sock.bind(0, () => {
        try {
          sock.setBroadcast(true)
        } catch {
          /* no broadcast on this machine */
        }
      })
    } catch (e) {
      log.warn?.(`  [drone] can't open the phone finder: ${e.message}`)
    }
    timer = setInterval(tick, ASK_EVERY_MS)
    tick()
  }

  function stopFinding() {
    clearInterval(timer)
    timer = null
    try {
      sock?.close()
    } catch {
      /* closed */
    }
    sock = null
    stopLocation()
    stopVideo(true)
  }

  function send(ip) {
    try {
      sock?.send(Buffer.from('VARUNA_CAM?'), DISCOVERY_PORT, ip)
    } catch {
      /* not sendable now */
    }
  }

  function tick() {
    const now = Date.now()
    if (now - lastUsed > IDLE_STOP_MS) {
      stopFinding()
      return
    }
    if (now - tailnetAt > 15000) {
      tailnetAt = now
      tailscale
        .phoneIps()
        .then(async (ips) => {
          tailnetIps = ips
          if (!tailnetSaid && ips.length) {
            tailnetSaid = true
            log.info?.(`  [drone] ${await tailscale.describe()} — asking its peers for VARUNA Cam too`)
          }
        })
        .catch(() => {})
    }
    if (ipFile && now - lastFileRead > 5000) {
      // The file may change under us (the Python backend writes it too, or a person does).
      lastFileRead = now
      const fromFile = readIpFile(ipFile)
      if (fromFile.length) saved = [...new Set([...fromFile, ...saved])].slice(0, 8)
    }
    const { ips: own, nets } = localNetworks()
    const ask = [...new Set([phone?.ip, ...saved, ...tailnetIps].filter(Boolean))]
    for (const ip of ask) send(ip)
    for (const b of nets) send(`${b}.255`)
    send('255.255.255.255')
    const fresh = [...answers.values()].some((a) => now - a.at < ANSWER_FRESH_MS)
    if (!fresh && now - lastSweep >= SWEEP_EVERY_MS) {
      lastSweep = now
      for (const b of nets) {
        for (let n = 1; n < 255; n++) {
          const ip = `${b}.${n}`
          if (!own.includes(ip) && !ask.includes(ip)) send(ip)
        }
      }
    }
    choose()
    keepStreams()
  }

  const isLocal = isLocalAddress

  function choose() {
    const now = Date.now()
    const live = [...answers.entries()].filter(([, a]) => now - a.at < ANSWER_FRESH_MS)
    if (!live.length) return
    if (phone && live.some(([ip]) => ip === phone.ip)) return // still where it was
    // The drone's phone is normally on the SAME Wi-Fi as this computer, and a
    // phone that is also on Tailscale answers over both. Take the local address:
    // the video then goes straight across the Wi-Fi instead of through
    // Tailscale, which is what keeps the picture close to live. Tailscale is used
    // only when no local address answers (the drone somewhere else entirely).
    const rank = ([ip]) => (saved.includes(ip) && isLocal(ip) ? 3 : isLocal(ip) ? 2 : saved.includes(ip) ? 1 : 0)
    const pick = [...live].sort((x, y) => rank(y) - rank(x) || y[1].at - x[1].at)[0]
    const [ip, a] = pick
    const was = phone?.ip
    phone = { ip, port: a.port }
    log.info?.(`  [drone] VARUNA Cam found at ${ip}:${a.port}${isTailnetAddress(ip) ? ' (over Tailscale)' : ''}${was ? `, was ${was}` : ''}`)
    if (ipFile && saved[0] !== ip) {
      saved = [ip, ...saved.filter((s) => s !== ip)]
      try {
        fs.writeFileSync(ipFile, ip + '\n')
      } catch {
        /* read-only: fine, it is found again next time */
      }
    }
    // New address: start over there.
    stopLocation()
    stopVideo(false)
    gps.reset()
    keepStreams()
  }

  /** The phone answered recently (it is running VARUNA Cam and reachable). */
  function phoneUp() {
    if (!phone) return false
    const a = answers.get(phone.ip)
    return !!a && Date.now() - a.at < ANSWER_FRESH_MS
  }

  function use() {
    lastUsed = Date.now()
    startFinding()
  }

  const base = () => (phone ? `http://${phone.ip}:${phone.port}` : null)

  // ---- GPS stream
  let loc = null // { req, lastLine }
  function startLocation() {
    if (loc || !phone) return
    const url = `${base()}/location/stream`
    const state = { req: null, lastLine: Date.now(), url }
    loc = state
    const req = http.get(url, { timeout: 5000, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return endLocation(state)
      }
      res.setEncoding('utf8')
      let pending = ''
      res.on('data', (chunk) => {
        pending += chunk
        let nl
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          if (!line) continue
          try {
            gps.ingest(JSON.parse(line))
            state.lastLine = Date.now()
          } catch {
            /* a broken line */
          }
        }
        if (pending.length > 65536) pending = ''
      })
      res.on('end', () => endLocation(state))
      res.on('error', () => endLocation(state))
    })
    req.on('error', () => endLocation(state))
    req.on('timeout', () => req.destroy())
    state.req = req
  }
  function endLocation(state) {
    if (loc === state) loc = null
    try {
      state.req?.destroy()
    } catch {
      /* gone */
    }
  }
  function stopLocation() {
    if (loc) endLocation(loc)
  }

  // ---- video
  const viewers = new Set() // { res, needKey, withPose, lastSent }
  let video = null // { req, lastFrame, frames: [] }
  let gop = [] // frames from the last keyframe: { data, key, tsUs, stamp }
  let codec = null
  let fpsTimes = []
  let kbpsBytes = []
  let lastViewerLeft = 0

  function startVideo() {
    if (video || !phone) return
    const state = { req: null, lastFrame: Date.now() }
    video = state
    const feed = createSplitter((data) => onFrame(state, data))
    const req = http.get(`${base()}/h264`, { timeout: 5000, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return endVideo(state)
      }
      res.on('data', (chunk) => {
        if (video !== state) return
        feed(chunk)
      })
      res.on('end', () => endVideo(state))
      res.on('error', () => endVideo(state))
    })
    req.on('error', () => endVideo(state))
    req.on('timeout', () => {
      if (Date.now() - state.lastFrame > VIDEO_STALL_MS) req.destroy()
    })
    state.req = req
  }
  function endVideo(state) {
    if (video === state) video = null
    try {
      state.req?.destroy()
    } catch {
      /* gone */
    }
  }
  function stopVideo(forViewersToo) {
    if (video) endVideo(video)
    gop = []
    for (const v of viewers) v.needKey = true
    if (forViewersToo) {
      for (const v of viewers) {
        try {
          v.res.end()
        } catch {
          /* gone */
        }
      }
      viewers.clear()
    }
  }

  function onFrame(state, data) {
    const now = Date.now()
    state.lastFrame = now
    const key = isKeyframe(data)
    const stamp = captureStamp(data)
    const local = stamp != null ? gps.toLocalMs(stamp) : null
    const tsUs = Math.round((local ?? now) * 1000)
    if (key) {
      gop = []
      codec = codecOf(data) || codec
    }
    const f = { data: Buffer.from(data), key, tsUs, stamp }
    if (key || gop.length) {
      gop.push(f)
      if (gop.length > GOP_MAX) gop = []
    }
    fpsTimes.push(now)
    while (fpsTimes.length && now - fpsTimes[0] > 2000) fpsTimes.shift()
    kbpsBytes.push([now, data.length])
    while (kbpsBytes.length && now - kbpsBytes[0][0] > 2000) kbpsBytes.shift()
    for (const v of viewers) deliver(v, f)
  }

  function record(f, withPose) {
    let pose = null
    if (withPose) {
      // By the phone's capture stamp; a frame without one, by when it arrived here.
      const p = f.stamp != null ? gps.poseAtPhone(f.stamp / 1000) : gps.poseAtLocal(f.tsUs / 1e6)
      if (p && (p.lat != null || p.hdg != null)) pose = Buffer.from(JSON.stringify(p))
    }
    const payloadLen = f.data.length + (pose ? 2 + pose.length : 0)
    const head = Buffer.alloc(13 + (pose ? 2 + pose.length : 0))
    head.writeUInt32BE(payloadLen, 0)
    head.writeUInt8((f.key ? 1 : 0) | (pose ? 2 : 0), 4)
    head.writeBigUInt64BE(BigInt(f.tsUs), 5)
    if (pose) {
      head.writeUInt16BE(pose.length, 13)
      pose.copy(head, 15)
    }
    return [head, f.data]
  }

  function deliver(v, f) {
    if (v.res.destroyed || v.res.writableEnded) return
    if (v.res.writableLength > VIEWER_BACKLOG) {
      v.needKey = true // this viewer can't keep up: skip to the next keyframe
      return
    }
    if (v.needKey) {
      if (!f.key) return
      v.needKey = false
    }
    const [head, body] = record(f, v.withPose)
    v.res.write(head)
    v.res.write(body)
    v.lastSent = Date.now()
  }

  function serveH264(req, res, withPose) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    try {
      res.socket?.setNoDelay(true)
    } catch {
      /* no socket */
    }
    const v = { res, needKey: true, withPose, lastSent: Date.now() }
    viewers.add(v)
    keepStreams()
    // Start at once from the last keyframe instead of waiting up to 2 s for the next.
    for (const f of gop) deliver(v, f)
    const watch = setInterval(() => {
      if (Date.now() - v.lastSent > VIEWER_WAIT_MS) res.end() // no pictures: end it, the app reconnects
    }, 1000)
    const done = () => {
      clearInterval(watch)
      viewers.delete(v)
      if (!viewers.size) lastViewerLeft = Date.now()
    }
    res.on('close', done)
    res.on('finish', done)
  }

  function keepStreams() {
    const now = Date.now()
    if (!phone) return
    if (now - lastUsed < IDLE_STOP_MS) startLocation()
    if (loc && now - loc.lastLine > LOCATION_STALE_MS) stopLocation()
    const wanted = viewers.size > 0 || now - lastViewerLeft < VIDEO_KEEP_MS
    if (wanted) {
      if (video && now - video.lastFrame > VIDEO_STALL_MS) endVideo(video)
      startVideo()
    } else if (video) {
      endVideo(video)
      gop = []
    }
  }

  // ---- API (same answers as drone-pi/main.py)
  function telemetry() {
    const p = gps.snapshot(phone ? `${base()}/location/stream` : null)
    const has = p.lat != null
    const rel = p.rel_alt || 0
    const home = p.home_lat != null ? { lat: p.home_lat, lng: p.home_lng } : null
    return {
      vehicle: 'drone',
      lat: p.lat,
      lng: p.lng,
      altitude: r2(rel),
      relative_alt: r2(rel),
      alt_msl: p.alt_msl,
      speed: r2(p.speed || 0),
      groundspeed: r2(p.speed || 0),
      climb: 0,
      heading: p.heading,
      flight_mode: null,
      mode: null,
      armed: false,
      landed_state: null,
      battery_voltage: null,
      battery_current: null,
      battery_remaining: null,
      battery_percent: null,
      satellites: p.satellites,
      gps_fix: has ? (p.fix === 'gps' && (p.accuracy ?? 999) <= 30 ? 3 : 1) : 0,
      hdop: null,
      gps_accuracy: p.accuracy,
      throttle: null,
      roll: p.roll,
      pitch: p.pitch,
      yaw: p.heading,
      home_lat: p.home_lat,
      home_lng: p.home_lng,
      home,
      fc_connected: false,
      link: 'phone',
      link_error: phone ? null : 'Looking for the drone phone (VARUNA Cam) on this network…',
      messages: [],
      mission: { state: 'idle' },
      camera: { connected: !!video && Date.now() - video.lastFrame < VIDEO_STALL_MS, fps: fps() },
      keyboard: null,
      phone_gps: p,
      position_source: 'phone',
      direct: true,
      t: r2(Date.now() / 1000),
    }
  }

  const fps = () => (fpsTimes.length > 1 ? r1(((fpsTimes.length - 1) * 1000) / (fpsTimes[fpsTimes.length - 1] - fpsTimes[0])) : 0)

  function cameraStatus() {
    const streaming = !!video && Date.now() - video.lastFrame < VIDEO_STALL_MS
    const kbps = Math.round((kbpsBytes.reduce((s, x) => s + x[1], 0) * 8) / 2000)
    return {
      camera_connected: phoneUp() || streaming,
      status_text: streaming ? 'STREAMING' : phoneUp() ? 'READY' : 'WAITING',
      standby: false,
      measured_fps: streaming ? fps() : 0,
      resolution: null,
      pipeline: 'phone camera (H.264, straight from the phone)',
      codec: phone ? 'h264' : null,
      h264_codec: codec,
      stream_kbps: streaming ? kbps : 0,
      camera_source: 'phone',
      source: 'phone',
      device: phone ? `${base()}/h264` : null,
      available: { usb: null, csi: false },
      direct: true,
      last_error: phone
        ? null
        : 'Looking for VARUNA Cam on this network… Start it on the drone phone, on the same Wi-Fi or hotspot as this laptop.',
    }
  }

  function json(res, body, status = 200) {
    const b = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
    res.end(b)
  }

  function pipeFrom(path, res, fallbackStatus = 503) {
    if (!phone) return json(res, { success: false, message: 'The drone phone is not found yet.' }, fallbackStatus)
    const up = http.get(`${base()}${path}`, { timeout: 5000, agent: false }, (r) => {
      res.writeHead(r.statusCode || 502, {
        'Content-Type': r.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store',
      })
      r.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) json(res, { success: false, message: 'The drone phone did not answer.' }, 502)
      else res.end()
    })
    up.on('timeout', () => up.destroy())
    res.on('close', () => up.destroy())
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let s = ''
      req.on('data', (c) => {
        s += c
        if (s.length > 1e6) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  /** Handles a drone API request; false if it isn't one. */
  function handle(req, res) {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    if (!(p.startsWith('/api/') || p === '/video_feed')) return false
    use()
    const get = req.method === 'GET' || req.method === 'HEAD'
    if (p === '/api/ping') return json(res, { status: 'ok', vehicle: 'drone' }), true
    if (p === '/api/health' || p === '/api/system/status') {
      const pg = gps.snapshot()
      return (
        json(res, {
          status: 'ok',
          vehicle: 'drone',
          version: 'direct',
          pixhawk_connected: false,
          camera_connected: cameraStatus().camera_connected,
          link: 'phone',
          link_error: null,
          gps_fix: pg.lat != null ? 3 : 0,
          satellites: pg.satellites,
          phone_gps: pg.connected,
          position_source: 'phone',
          phone: phone ? phone.ip : null,
          direct: true,
        }),
        true
      )
    }
    if (p === '/api/system/pi') return json(res, {}), true
    if (p === '/api/camera/status') return json(res, cameraStatus()), true
    if (p === '/api/camera/h264') return serveH264(req, res, u.searchParams.get('pose') === '1' || u.searchParams.get('pose') === 'true'), true
    if (p === '/api/camera/snapshot') return pipeFrom('/shot.jpg', res), true
    if (p === '/video_feed') return pipeFrom('/video', res), true
    if (p === '/api/telemetry') return json(res, telemetry()), true
    if (p === '/api/telemetry/history') {
      const n = Math.max(1, Math.min(900, Number(u.searchParams.get('limit')) || 200))
      return json(res, gps.track().slice(-n)), true
    }
    if (p === '/api/phone/gps') return json(res, { ...gps.snapshot(), in_use: true, position_source: 'phone' }), true
    if (p === '/api/phone/home') {
      if (!phone) return json(res, { success: false, message: 'The drone phone is not found yet.' }), true
      http
        .get(`${base()}/location/home`, { timeout: 4000, agent: false }, (r) => {
          r.resume()
          json(res, { success: r.statusCode === 200, message: 'Take-off point set where the drone is now.' })
        })
        .on('error', (e) => json(res, { success: false, message: `Couldn't reach the phone: ${e.message}` }))
      return true
    }
    if (p === '/api/ai/status') return json(res, { ai_enabled: true, model_loaded: false, runs_on: 'app', confidence_threshold: null, live_boxes: 0 }), true
    if (p === '/api/ai/classes') return json(res, { classes: ['plastic'], runs_on: 'app' }), true
    if (p === '/api/ai/detections') return json(res, { detections: aiDetections.slice(-(Number(u.searchParams.get('limit')) || 50)) }), true
    if (p === '/api/ai/report' && !get) {
      readBody(req).then((b) => {
        const t = telemetry()
        aiDetections.push({
          class: b.debrisType,
          confidence: b.confidence,
          t: r1(Date.now() / 1000),
          lat: b.lat ?? t.lat,
          lng: b.lng ?? t.lng,
          alt: t.relative_alt,
        })
        if (aiDetections.length > 500) aiDetections.shift()
        json(res, { success: true, message: `Debris report '${b.debrisType}' logged.` })
      })
      return true
    }
    if (p === '/api/mission/status') return json(res, { state: 'idle', direct: true }), true
    if (p === '/api/mavlink/status') return json(res, { connected: false, link: 'phone', direct: true }), true
    if (p === '/api/config' && get) return json(res, { position_source: 'phone', direct: true }), true
    const msg = 'The drone has no flight controller link now: only its phone (video and GPS) is connected.'
    if (!get) return json(res, { success: false, message: msg }), true
    return json(res, { detail: 'Not available with the phone only.', message: msg }, 404), true
  }

  // ---- telemetry WebSocket (/api/ws), pushed 5 times a second
  function handleUpgrade(req, socket) {
    const p = new URL(req.url, 'http://x').pathname
    if (p !== '/api/ws' && p !== '/api/control') return false
    use()
    const key = req.headers['sec-websocket-key']
    if (p === '/api/control' || !key) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return true
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)
    const sendText = (text) => {
      const body = Buffer.from(text)
      let head
      if (body.length < 126) head = Buffer.from([0x81, body.length])
      else if (body.length < 65536) {
        head = Buffer.alloc(4)
        head[0] = 0x81
        head[1] = 126
        head.writeUInt16BE(body.length, 2)
      } else {
        head = Buffer.alloc(10)
        head[0] = 0x81
        head[1] = 127
        head.writeBigUInt64BE(BigInt(body.length), 2)
      }
      if (socket.writableLength < 512 * 1024) socket.write(Buffer.concat([head, body]))
    }
    const push = () => {
      use()
      sendText(JSON.stringify(telemetry()))
    }
    push()
    const iv = setInterval(push, 200)
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const op = pending[0] & 0x0f
        let len = pending[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (pending.length < 4) return
          len = pending.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (pending.length < 10) return
          len = Number(pending.readBigUInt64BE(2))
          off = 10
        }
        const masked = pending[1] & 0x80
        const total = off + (masked ? 4 : 0) + len
        if (pending.length < total) return
        let payload = pending.subarray(off + (masked ? 4 : 0), total)
        if (masked) {
          const mask = pending.subarray(off, off + 4)
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
        }
        pending = pending.subarray(total)
        if (op === 0x8) {
          socket.end(Buffer.from([0x88, 0]))
          return
        }
        if (op === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload.subarray(0, 125)]))
      }
    })
    const close = () => clearInterval(iv)
    socket.on('close', close)
    socket.on('error', close)
    return true
  }

  function stop() {
    stopFinding()
  }

  return {
    handle,
    handleUpgrade,
    stop,
    // for tests
    _state: () => ({ phone, answers: [...answers.keys()], viewers: viewers.size, video: !!video, gop: gop.length, fps: fps() }),
    _gps: gps,
  }
}

/** The WebCodecs codec name ("avc1.PPCCLL") from the SPS in a keyframe. */
function codecOf(data) {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [data[i + 4], data[i + 5], data[i + 6]].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    }
  }
  return null
}

module.exports = { createDroneDirect, createSplitter, captureStamp, isKeyframe, createPhoneGps, isLocalAddress, isTailnetAddress }
