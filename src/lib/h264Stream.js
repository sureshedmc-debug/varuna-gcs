/**
 * Plays the drone camera's H.264 stream (/api/camera/h264) into a <canvas>,
 * decoded in the browser with WebCodecs. About a third of the bandwidth of
 * the MJPEG stream (/video_feed), so it stays smooth and live on weaker Wi-Fi.
 *
 * The stream is one record per frame: payload length (u32), flags (u8: 1 =
 * keyframe, 2 = pose included), capture time (u64, µs since 1970), then the
 * payload: with a pose, its JSON length (u16) and the JSON — the drone's
 * position and attitude when the frame was taken (?pose=1) — then the frame
 * as Annex-B H.264. It starts at a keyframe, and the Pi skips a slow viewer
 * ahead to the newest keyframe instead of letting delay pile up.
 */

const HEADER = 13
const MAX_QUEUE = 3           // frames waiting in the decoder before skipping to the next keyframe
// Smooth playback: pictures are shown on the camera's own rhythm (the capture
// times VARUNA Cam stamps on them), a little behind the quickest arrival, so the
// Wi-Fi's uneven delivery doesn't show as stutter. A picture that comes later
// than that is shown at once. How far behind follows the Wi-Fi: enough to cover
// 97% of the last 10 s of pictures (measured on the drone phone's hotspot: a
// fixed 80 ms left 9% of pictures late, i.e. a hitch every couple of seconds),
// between SMOOTH_MIN_MS and SMOOTH_MAX_MS, changing gradually.
// localStorage 'varuna.videoBufferMs' fixes it instead (0 = show at once).
const SMOOTH_FIXED_MS = (() => {
  try { const v = Number(localStorage.getItem('varuna.videoBufferMs')); if (v >= 0 && v <= 1000 && localStorage.getItem('varuna.videoBufferMs') !== null) return v } catch { /* private mode */ }
  return null
})()
const SMOOTH_START_MS = 150
const SMOOTH_MIN_MS = 60
const SMOOTH_MAX_MS = 250
const SMOOTH_WINDOW_MS = 10000
const SMOOTH_COVER = 0.97
const LEAD_WINDOW_MS = 3000   // the quickest arrival is looked for over this long
const MAX_WAITING = 30        // pictures decoded but not yet shown, at most
const STAMP = [0x56, 0x41, 0x52, 0x55, 0x4e, 0x41, 0x2d, 0x43, 0x41, 0x4d, 0x2d, 0x54, 0x49, 0x4d, 0x45, 0x21, 0x74, 0x3d]  // "VARUNA-CAM-TIME!t="

/** VARUNA Cam's capture time (ms, phone clock) from a frame's SEI, or null. */
export function captureStamp(data) {
  const end = Math.min(data.length - STAMP.length, 160)
  outer: for (let i = 0; i < end; i++) {
    for (let j = 0; j < STAMP.length; j++) if (data[i + j] !== STAMP[j]) continue outer
    let ms = 0
    let k = i + STAMP.length
    for (; k < data.length && data[k] >= 0x30 && data[k] <= 0x39; k++) ms = ms * 10 + (data[k] - 0x30)
    return k > i + STAMP.length ? ms : null
  }
  return null
}
const BEHIND_MS = 1000        // further behind than this…
const BEHIND_FOR_MS = 2000    // …for this long: reconnect, dropping whatever is queued on the way

/** WebCodecs needs a secure context: https, localhost / 127.0.0.1, or the desktop app. */
export function h264Supported() {
  return typeof window !== 'undefined' && !!window.isSecureContext && typeof window.VideoDecoder === 'function'
}

/** The codec name ("avc1.PPCCLL") from the SPS at the start of a keyframe. */
export function codecFromKeyframe(data) {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0')
      return 'avc1.' + hex(data[i + 4]) + hex(data[i + 5]) + hex(data[i + 6])
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const utf8 = new TextDecoder()

/*
 * One connection per stream URL, shared by every player on it: the Live tab's
 * detector and its small video tile watch the same picture, and two
 * connections would send every frame over the link twice. Each player keeps
 * its own decoder and canvas. The connection closes with its last player.
 */
const sources = new Map()   // url -> { url, subs: Set, closed, ctrl }

function subscribe(url, sub) {
  let src = sources.get(url)
  if (!src) {
    src = { url, subs: new Set(), closed: false, ctrl: null }
    sources.set(url, src)
    runSource(src)
  }
  src.subs.add(sub)
  return () => {
    src.subs.delete(sub)
    if (src.subs.size) return
    src.closed = true
    sources.delete(url)
    try { src.ctrl?.abort() } catch { /* done */ }
  }
}

async function runSource(src) {
  let backoff = 500
  while (!src.closed) {
    src.ctrl = new AbortController()
    let gotData = false
    let baseline = Infinity     // smallest frame age seen: network delay + the Pi/laptop clock difference
    let behindSince = 0
    for (const sub of src.subs) sub.reset()
    try {
      const res = await fetch(src.url, { signal: src.ctrl.signal, cache: 'no-store' })
      if (res.status === 409 || res.status === 404) {
        for (const sub of [...src.subs]) sub.fatal('mjpeg')
        return
      }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
      const reader = res.body.getReader()
      let buf = new Uint8Array(0)
      for (;;) {
        const { value, done } = await reader.read()
        if (done || src.closed) break
        gotData = true
        backoff = 500
        const joined = new Uint8Array(buf.length + value.length)
        joined.set(buf)
        joined.set(value, buf.length)
        buf = joined
        let off = 0
        while (buf.length - off >= HEADER) {
          const dv = new DataView(buf.buffer, buf.byteOffset + off, HEADER)
          const len = dv.getUint32(0)
          if (buf.length - off < HEADER + len) break
          const flags = dv.getUint8(4)
          const tsUs = Number(dv.getBigUint64(5))
          let data = buf.subarray(off + HEADER, off + HEADER + len)
          let pose = null
          if (flags & 2) {
            const n = (data[0] << 8) | data[1]
            try { pose = JSON.parse(utf8.decode(data.subarray(2, 2 + n))) } catch { /* no pose */ }
            data = data.subarray(2 + n)
          }
          // Falling behind (the link can't carry the stream): reconnect, which
          // drops whatever is queued on the way and starts at the newest keyframe.
          const age = Date.now() - tsUs / 1000
          baseline = Math.min(baseline, age)
          if (age - baseline > BEHIND_MS) {
            const now = performance.now()
            if (!behindSince) behindSince = now
            else if (now - behindSince > BEHIND_FOR_MS) throw new Error('lagging')
          } else behindSince = 0
          for (const sub of src.subs) sub.frame(data, (flags & 1) === 1, tsUs, pose)
          if (src.closed) return
          off += HEADER + len
        }
        if (off) buf = buf.slice(off)
      }
    } catch (e) {
      if (src.closed) return
      if (e?.message === 'lagging') console.info('[h264] video fell behind — reconnecting')
    }
    try { src.ctrl.abort() } catch { /* done */ }
    if (src.closed) return
    if (!gotData) {
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 5000)
    }
  }
}

/**
 * Start playing. onFirstFrame() runs when the first picture is drawn.
 * onFatal(reason) means this can't work and the caller should show MJPEG:
 * 'mjpeg' (the camera isn't sending H.264, or camera_codec = mjpeg) or
 * 'decode' (this browser can't decode the stream). Network drops are retried
 * here. Returns { close(), frame() }: frame() is the picture now on the
 * canvas, { tsUs, pose } (pose null unless the URL asked for ?pose=1 and the
 * drone's Pixhawk is connected). Players on the same URL share one connection.
 */
export function playH264({ url, canvas, onFirstFrame, onFatal }) {
  const ctx = canvas.getContext('2d', { alpha: false })
  let closed = false
  let decoder = null
  let codec = null
  let needKey = true
  let frames = 0
  let decodeErrors = 0
  const poses = new Map()     // capture time → pose, for frames in the decoder
  const stamps = new Map()    // decoder timestamp → VARUNA Cam capture time (ms)
  let shown = null            // { tsUs, pose } of the picture on the canvas
  let unsubscribe = null
  const waiting = []          // decoded pictures not shown yet: { frame, showAt, tsUs, pose }
  const leads = []            // [arrived (performance.now), arrived − capture time]
  const lates = []            // [arrived, how much later than the quickest picture]
  let smooth = SMOOTH_FIXED_MS ?? SMOOTH_START_MS   // ms behind the quickest that pictures are shown
  let timer = 0

  function draw(item) {
    const f = item.frame
    if (canvas.width !== f.width || canvas.height !== f.height) {
      canvas.width = f.width
      canvas.height = f.height
    }
    ctx.drawImage(f, 0, 0)
    shown = { tsUs: item.tsUs, pose: item.pose }
    f.close()
  }

  // A timer to each picture's moment, not requestAnimationFrame: that one stops
  // in a window that's covered or minimised, and the detector reads this canvas.
  function render() {
    timer = 0
    if (closed) return
    const now = performance.now()
    let pick = -1
    for (let i = 0; i < waiting.length && waiting[i].showAt <= now + 2; i++) pick = i
    if (pick >= 0) {
      for (let i = 0; i < pick; i++) waiting[i].frame.close()   // missed their moment: skip
      draw(waiting[pick])
      waiting.splice(0, pick + 1)
    }
    wake()
  }

  function wake() {
    if (timer || closed || !waiting.length) return
    timer = setTimeout(render, Math.max(0, waiting[0].showAt - performance.now()))
  }

  /** A decoded picture: when to show it, on the camera's rhythm. */
  function schedule(frame) {
    const now = performance.now()
    const cap = stamps.get(frame.timestamp) ?? frame.timestamp / 1000
    stamps.delete(frame.timestamp)
    for (const ts of stamps.keys()) { if (ts > frame.timestamp) break; stamps.delete(ts) }
    leads.push([now, now - cap])
    while (leads.length && leads[0][0] < now - LEAD_WINDOW_MS) leads.shift()
    let lead = Infinity
    for (const l of leads) if (l[1] < lead) lead = l[1]
    // How late this picture came against the quickest: the Wi-Fi's unevenness.
    lates.push([now, now - cap - lead])
    while (lates.length && lates[0][0] < now - SMOOTH_WINDOW_MS) lates.shift()
    if (SMOOTH_FIXED_MS === null && lates.length >= 40) {
      const sorted = lates.map((l) => l[1]).sort((a, b) => a - b)
      const need = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * SMOOTH_COVER))] + 15
      const target = Math.min(SMOOTH_MAX_MS, Math.max(SMOOTH_MIN_MS, need))
      // Gradually: up a little quicker than down, so a bad patch is covered soon
      // and a good one doesn't make pictures skip.
      smooth += Math.max(-1, Math.min(3, target - smooth))
    }
    const tsUs = frame.timestamp
    const item = { frame: null, showAt: cap + lead + smooth, tsUs, pose: poses.get(tsUs) ?? null }
    for (const ts of poses.keys()) { if (ts > tsUs) break; poses.delete(ts) }
    const first = frames === 0 || smooth === 0
    // Hardware decoders have only a few picture buffers: copy the picture out
    // (a GPU bitmap) and give the buffer back at once, rather than holding it
    // while it waits its turn.
    createImageBitmap(frame).then((bmp) => {
      if (closed) { bmp.close(); return }
      item.frame = bmp
      if (first) { draw(item); return }   // the first picture straight away
      waiting.push(item)
      while (waiting.length > MAX_WAITING) waiting.shift().frame.close()
      wake()
    }, () => { /* the picture is gone: skip it */ }).finally(() => frame.close())
  }

  function dropWaiting() {
    while (waiting.length) waiting.shift().frame.close()
    leads.length = 0
    stamps.clear()
  }

  function fatal(reason) {
    if (closed) return
    close()
    onFatal?.(reason)
  }

  function configure(c) {
    try { if (decoder && decoder.state !== 'closed') decoder.close() } catch { /* already closed */ }
    decoder = new VideoDecoder({
      output: (frame) => {
        if (closed) { frame.close(); return }
        schedule(frame)   // closes it
        decodeErrors = 0
        if (++frames === 1) onFirstFrame?.()
      },
      error: (e) => {
        // The decoder closes itself: a new one starts at the next keyframe.
        console.warn('[h264]', e)
        needKey = true
        poses.clear()
        if (++decodeErrors >= 3 && frames === 0) fatal('decode')
      },
    })
    try {
      decoder.configure({ codec: c, optimizeForLatency: true })
      codec = c
    } catch (e) {
      console.warn('[h264] cannot decode', c, e)
      fatal('decode')
    }
  }

  function frame(data, key, tsUs, pose) {
    if (closed) return
    if (key) {
      const c = codecFromKeyframe(data)
      if (c && (c !== codec || !decoder || decoder.state === 'closed')) configure(c)
      if (closed) return
      needKey = false
    }
    if (needKey || !decoder || decoder.state !== 'configured') return
    if (!key && decoder.decodeQueueSize > MAX_QUEUE) { needKey = true; return } // can't keep up: skip ahead
    if (pose) poses.set(tsUs, pose)
    const cap = captureStamp(data)
    if (cap !== null) stamps.set(tsUs, cap)
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: tsUs, data }))  // copies data
  }

  function close() {
    if (closed) return
    closed = true
    unsubscribe?.()
    if (timer) clearTimeout(timer)
    timer = 0
    dropWaiting()
    try { if (decoder && decoder.state !== 'closed') decoder.close() } catch { /* done */ }
  }

  unsubscribe = subscribe(url, {
    frame,
    reset: () => { needKey = true; dropWaiting() },
    fatal,
  })
  return { close, frame: () => shown, bufferMs: () => Math.round(smooth) }
}
