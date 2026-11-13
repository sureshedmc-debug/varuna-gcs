// Reads an MJPEG stream (multipart/x-mixed-replace) with fetch instead of an
// <img>, because the boat stamps every frame with headers the app needs:
// X-Frame-Time (when the boat captured it, boat clock) and X-Frame-Seq. The
// app sends X-Frame-Time back with its detections, so the boat can look up
// where it was at that moment — network delay doesn't skew the steering.

const CRLFCRLF = [13, 10, 13, 10]
const MAX_BUFFER = 4 * 1024 * 1024 // a stream that never yields a frame is resynced

function indexOf(buf, pat, from = 0) {
  outer: for (let i = from; i <= buf.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer
    return i
  }
  return -1
}

function concat(a, b) {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const decoder = new TextDecoder()

/**
 * Pull complete parts out of `buf`. Returns { frames, rest } where each frame is
 * { jpeg: Uint8Array, frameTime: number|null, seq: number|null }.
 */
export function parseParts(buf) {
  const frames = []
  let pos = 0
  for (;;) {
    const hdrEnd = indexOf(buf, CRLFCRLF, pos)
    if (hdrEnd < 0) break
    const head = decoder.decode(buf.subarray(pos, hdrEnd))
    const len = /Content-Length:\s*(\d+)/i.exec(head)
    if (!len) {
      pos = hdrEnd + 4 // not a frame header (preamble / stray line): skip it
      continue
    }
    const start = hdrEnd + 4
    const end = start + Number(len[1])
    if (buf.length < end) break
    const t = /X-Frame-Time:\s*([\d.]+)/i.exec(head)
    const s = /X-Frame-Seq:\s*(\d+)/i.exec(head)
    frames.push({ jpeg: buf.slice(start, end), frameTime: t ? Number(t[1]) : null, seq: s ? Number(s[1]) : null })
    pos = end
  }
  return { frames, rest: buf.slice(pos) }
}

/**
 * Stream `url` until it ends, `signal` aborts, or an error. Calls
 * onFrame(frame) for every complete JPEG.
 */
export async function readMjpeg(url, onFrame, { signal } = {}) {
  const res = await fetch(url, { signal, cache: 'no-store' })
  if (!res.ok || !res.body) throw new Error(`Camera stream: HTTP ${res.status}`)
  const reader = res.body.getReader()
  let buf = new Uint8Array(0)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf = concat(buf, value)
      const { frames, rest } = parseParts(buf)
      buf = rest.length > MAX_BUFFER ? new Uint8Array(0) : rest
      for (const f of frames) onFrame(f)
    }
  } finally {
    try {
      reader.cancel()
    } catch {
      /* already closed */
    }
  }
}
