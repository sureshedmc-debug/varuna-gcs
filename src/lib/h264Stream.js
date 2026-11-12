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
  let shown = null            // { tsUs, pose } of the picture on the canvas
  let unsubscribe = null

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
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        ctx.drawImage(frame, 0, 0)
        shown = { tsUs: frame.timestamp, pose: poses.get(frame.timestamp) ?? null }
        for (const ts of poses.keys()) { if (ts > frame.timestamp) break; poses.delete(ts) }
        frame.close()
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
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: tsUs, data }))  // copies data
  }

  function close() {
    if (closed) return
    closed = true
    unsubscribe?.()
    try { if (decoder && decoder.state !== 'closed') decoder.close() } catch { /* done */ }
  }

  unsubscribe = subscribe(url, {
    frame,
    reset: () => { needKey = true },
    fatal,
  })
  return { close, frame: () => shown }
}
