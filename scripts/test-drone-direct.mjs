// Tests electron/droneDirect.cjs (the drone straight from its phone, no
// backend) against a fake VARUNA Cam: finding it, the H.264 records the app's
// player reads, frame poses, telemetry, the WebSocket, a slow viewer, and the
// phone moving to a new address.
//   node scripts/test-drone-direct.mjs
import { createRequire } from 'node:module'
import http from 'node:http'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createDroneDirect, createSplitter, captureStamp, isLocalAddress, isTailnetAddress } = require('../electron/droneDirect.cjs')

let failed = 0
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 100) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

// ------------------------------------------------------------ fake VARUNA Cam
const PORT = 18080
function fakePhone(host) {
  const sc = Buffer.from([0, 0, 0, 1])
  const SPS = Buffer.concat([sc, Buffer.from([0x67, 0x42, 0x00, 0x1f, 0xaa, 0xbb])])
  const PPS = Buffer.concat([sc, Buffer.from([0x68, 0xce, 0x3c, 0x80])])
  const AUD = Buffer.concat([sc, Buffer.from([0x09, 0xf0])])
  const frame = (c) => {
    const key = c.n % 24 === 0
    c.n++
    const sei = Buffer.concat([sc, Buffer.from([0x06, 0x05]), Buffer.from('VARUNA-CAM-TIME!t=' + Date.now()), Buffer.from([0x80])])
    const slice = Buffer.concat([sc, Buffer.from([key ? 0x65 : 0x41, 0x88]), Buffer.alloc(key ? 6000 : 1500, 0xaa)])
    return Buffer.concat([...(key ? [SPS, PPS] : []), sei, slice, AUD])
  }
  const timers = new Set()
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0]
    if (u === '/h264') {
      res.writeHead(200, { 'Content-Type': 'video/h264' })
      const c = { n: 0 } // each viewer starts at a keyframe, as VARUNA Cam does
      const iv = setInterval(() => res.write(frame(c)), 1000 / 24)
      timers.add(iv)
      res.on('close', () => clearInterval(iv))
    } else if (u === '/location/stream') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      const t0 = Date.now()
      const iv = setInterval(() => {
        const s = (Date.now() - t0) / 1000
        res.write(JSON.stringify({ t: Date.now(), lat: 28.6 + s * 1e-6, lng: 77.3, fix: 'gps', acc: 4, spd: 0.1, crs: 0, sats: 12, sats_seen: 20, hdg: 90, pitch: 1, roll: 2, rel_alt: 30, fov: 62.6 }) + '\n')
      }, 50)
      timers.add(iv)
      res.on('close', () => clearInterval(iv))
    } else if (u === '/status') {
      res.end(JSON.stringify({ state: 'Streaming', h264: { fps: 24 } }))
    } else if (u === '/location/home') {
      res.end('{}')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  srv.listen(PORT, host)
  const udp = dgram.createSocket('udp4')
  udp.on('message', (m, r) => {
    if (m.toString() === 'VARUNA_CAM?') udp.send(JSON.stringify({ varuna_cam: 1, port: PORT, state: 'Streaming', h264: true }), r.port, r.address)
  })
  udp.bind(47800, host)
  return {
    close() {
      for (const t of timers) clearInterval(t)
      srv.closeAllConnections?.()
      srv.close()
      udp.close()
    },
  }
}

// ------------------------------------------------------------ the server under test
const ipFile = path.join(os.tmpdir(), `varuna-test-phone-${process.pid}.txt`)
fs.writeFileSync(ipFile, '127.0.0.2 127.0.0.1\n') // .2 not running yet: the one that answers wins
const link = createDroneDirect({ ipFile, log: { info: (m) => console.log('      ' + m.trim()), warn: () => {} } })
const app = http.createServer((req, res) => {
  if (!link.handle(req, res)) {
    res.writeHead(404)
    res.end()
  }
})
app.on('upgrade', (req, socket) => {
  if (!link.handleUpgrade(req, socket)) socket.destroy()
})
await new Promise((r) => app.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${app.address().port}`
const getJson = async (p) => (await fetch(base + p)).json()

/** Reads /api/camera/h264 records for `ms`; pauseMs: stop reading that long first (a slow viewer). */
async function readRecords(ms, { pauseMs = 0 } = {}) {
  return new Promise((resolve) => {
    const recs = []
    let buf = Buffer.alloc(0)
    const req = http.get(base + '/api/camera/h264?pose=1', (res) => {
      if (pauseMs) {
        res.pause()
        setTimeout(() => {
          buf = Buffer.alloc(0)
          recs.length = 0
          res.on('data', onData)
          res.resume()
        }, pauseMs)
      } else res.on('data', onData)
      function onData(c) {
        if (pauseMs && !recs.resumed) {
          // drop what the kernel buffered while paused: count from the first whole record we can find after
          recs.resumed = true
        }
        buf = Buffer.concat([buf, c])
        while (buf.length >= 13) {
          const len = buf.readUInt32BE(0)
          if (buf.length < 13 + len) break
          const flags = buf[4]
          const tsUs = Number(buf.readBigUInt64BE(5))
          let payload = buf.subarray(13, 13 + len)
          let pose = null
          if (flags & 2) {
            const pl = payload.readUInt16BE(0)
            pose = JSON.parse(payload.subarray(2, 2 + pl).toString())
            payload = payload.subarray(2 + pl)
          }
          recs.push({ key: !!(flags & 1), tsUs, pose, at: Date.now(), size: payload.length, startsOk: payload[0] === 0 && payload[1] === 0 })
          buf = buf.subarray(13 + len)
        }
      }
    })
    setTimeout(() => {
      req.destroy()
      resolve(recs)
    }, ms + pauseMs)
  })
}

try {
  // ---- splitter on odd chunk boundaries
  {
    const frames = []
    const feed = createSplitter((d) => frames.push(Buffer.from(d)))
    const sc = [0, 0, 0, 1]
    const f = (t) => Buffer.from([...sc, 0x06, ...Buffer.from('VARUNA-CAM-TIME!t=' + t), 0x80, ...sc, 0x41, 0x88, 1, 2, 3, ...sc, 0x09, 0xf0])
    const all = Buffer.concat([f(111), f(222), f(333)])
    for (let i = 0; i < all.length; i += 3) feed(all.subarray(i, i + 3))
    ok(frames.length === 3 && frames.map(captureStamp).join() === '111,222,333', `splitter: 3 frames from 3-byte chunks (${frames.map(captureStamp)})`)
  }

  let phone1 = fakePhone('127.0.0.1')
  ok((await getJson('/api/ping')).status === 'ok', 'ping answers')
  const found = await until(async () => (await getJson('/api/camera/status')).device?.includes('127.0.0.1'), 5000)
  ok(!!found, 'finds the fake VARUNA Cam at 127.0.0.1 (the saved .2 does not answer)')
  ok(fs.readFileSync(ipFile, 'utf8').trim() === '127.0.0.1', 'saves the address it found')

  await until(async () => (await getJson('/api/telemetry')).lat != null, 4000)
  const tel = await getJson('/api/telemetry')
  ok(tel.lat != null && Math.abs(tel.lat - 28.6) < 0.01 && tel.gps_fix === 3 && tel.relative_alt === 30, `telemetry from the phone's GPS (lat ${tel.lat}, fix ${tel.gps_fix}, alt ${tel.relative_alt})`)

  const recs = await readRecords(3000)
  const span = (recs.at(-1)?.at - recs[0]?.at) / 1000
  const fps = (recs.length - 1) / span
  ok(recs.length > 0 && recs[0].key, `video starts at a keyframe (${recs.length} records)`)
  ok(fps > 18 && fps < 30, `video at the phone's rate: ${fps.toFixed(1)} fps`)
  ok(recs.every((r) => r.startsOk), 'every record holds Annex-B H.264')
  ok(recs.every((r, i) => i === 0 || r.tsUs >= recs[i - 1].tsUs), 'frame times only go forward')
  const withPose = recs.filter((r) => r.pose && r.pose.lat != null && r.pose.hdg === 90)
  ok(withPose.length >= recs.length - 2, `frames carry the drone's pose (${withPose.length}/${recs.length}, e.g. ${JSON.stringify(recs.at(-1)?.pose)})`)
  const lagMs = recs.slice(5).map((r) => r.at - r.tsUs / 1000)
  ok(lagMs.length && Math.max(...lagMs) < 120, `delay added here is small: max ${Math.max(...lagMs).toFixed(0)} ms from capture to delivery`)

  // ---- WebSocket
  {
    const msgs = []
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/ws')
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data))
    await sleep(1100)
    ws.close()
    ok(msgs.length >= 4 && msgs.at(-1).lat != null && msgs.at(-1).position_source === 'phone', `WebSocket pushes telemetry (${msgs.length} in 1.1 s)`)
  }

  // ---- a viewer that stops reading for 3 s, then reads again
  {
    const recs2 = await readRecords(1500, { pauseMs: 3000 })
    const st = link._state()
    ok(recs2.length > 10, `a viewer that stalled 3 s gets live video again (${recs2.length} records in 1.5 s)`)
    const late = recs2.slice(-5).map((r) => r.at - r.tsUs / 1000)
    ok(Math.max(...late) < 400, `…and is not left behind: last frames ${Math.max(...late).toFixed(0)} ms old`)
    void st
  }

  // ---- the phone gets a new address
  phone1.close()
  await sleep(300)
  const phone2 = fakePhone('127.0.0.2')
  const moved = await until(async () => (await getJson('/api/camera/status')).device?.includes('127.0.0.2'), 8000)
  ok(!!moved, 'follows the phone to its new address (127.0.0.2)')
  const recs3 = await readRecords(1500)
  ok(recs3.length > 20 && recs3[0].key, `video from the new address (${recs3.length} records)`)
  ok(fs.readFileSync(ipFile, 'utf8').trim() === '127.0.0.2', 'saves the new address')
  phone2.close()

  // ---- no phone at all
  await sleep(4500)
  const cs = await getJson('/api/camera/status')
  ok(cs.status_text !== 'STREAMING', `with the phone gone the camera says so (${cs.status_text})`)
  const other = await fetch(base + '/api/mavlink/arm', { method: 'POST' }).then((r) => r.json())
  ok(other.success === false && /flight controller/.test(other.message), 'flight commands answer "no flight controller", not an error')
} finally {
  link.stop()
  app.closeAllConnections?.()
  app.close()
  try {
    fs.unlinkSync(ipFile)
  } catch {
    /* gone */
  }
}

// ---- same network beats Tailscale -------------------------------------------
// The drone's phone is on this computer's Wi-Fi. If it is ALSO on Tailscale it
// answers on both, and taking the Tailscale address would send the video the long
// way round. The local address has to win.
{
  const lan = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal
          && !a.address.startsWith('169.254.') && !isTailnetAddress(a.address)) lan.push(a.address)
    }
  }
  for (const ip of ['100.64.0.1', '100.99.45.205', '100.127.255.254']) {
    ok(isTailnetAddress(ip) && !isLocalAddress(ip), `${ip} is a Tailscale peer, not the same network`)
  }
  for (const ip of ['100.63.0.1', '100.128.0.1', '192.168.1.5']) {
    ok(!isTailnetAddress(ip), `${ip} is outside Tailscale's range`)
  }
  if (lan.length) {
    const sameNet = lan[0].split('.').slice(0, 3).join('.') + '.123'
    ok(isLocalAddress(sameNet), `${sameNet} counts as this computer's own network (${lan[0]})`)
  } else {
    console.log('SKIP  no ordinary network on this computer to check against')
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && isTailnetAddress(a.address)) {
        const peer = a.address.split('.').slice(0, 3).join('.') + '.200'
        ok(!isLocalAddress(peer), `a Tailscale peer next to our own ${a.address} still counts as Tailscale`)
      }
    }
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nDRONE DIRECT TESTS PASSED')
process.exit(failed ? 1 : 0)
