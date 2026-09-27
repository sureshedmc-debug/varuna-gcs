// Minimal ZIP writer — enough to package a training dataset, and nothing more.
//
// Entries are STORED, not deflated. The dataset is almost entirely JPEGs,
// which are already compressed, so deflate would cost CPU and save nothing;
// the handful of text files it also holds are tiny. Writing this by hand
// keeps a ~150KB dependency out of a bundle that already ships 64MB of models.

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const UTF8_FLAG = 0x0800 // names are UTF-8, not the legacy codepage

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// MS-DOS packed date/time. One timestamp for the whole archive.
function dosStamp(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

const enc = new TextEncoder()
function toBytes(data) {
  if (typeof data === 'string') return enc.encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return enc.encode(String(data))
}

/** Decode a `data:...;base64,...` URL to raw bytes. */
export function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(',')
  if (comma < 0) return new Uint8Array(0)
  const b64 = dataUrl.slice(comma + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Build a ZIP from `[{ name, data }]` where data is a string, Uint8Array or
 * ArrayBuffer. Returns a Blob ready to download.
 */
export function createZip(files) {
  const { time, date } = dosStamp(new Date())
  const parts = []
  const central = []
  let offset = 0

  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const body = toBytes(f.data)
    const crc = crc32(body)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, SIG_LOCAL, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, UTF8_FLAG, true)
    lv.setUint16(8, 0, true) // method: stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, body.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra field length
    local.set(nameBytes, 30)

    parts.push(local, body)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, SIG_CENTRAL, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, UTF8_FLAG, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, body.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true)
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length + body.length
  }

  const cdSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' })
}
