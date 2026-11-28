// Prepares a picture for a detector WITHOUT stalling the page.
//
// Every detector letterboxes a (crop of a) video frame into a square and reads
// its pixels back. Done on the page (drawImage + getImageData), the read waits
// for the graphics chip to finish everything else it is drawing first: measured
// in the desktop app on the Intel Iris Xe, 170-600 ms PER DETECTION of a frozen
// page, which is the "sudden pause" the Live and Boat tabs had (2026-11-28).
//
// Here the browser scales the crop on its own (createImageBitmap, async) and a
// worker pads it and reads the pixels on an OffscreenCanvas, so the page's own
// thread is busy for well under a millisecond (measured 0.4 ms). Without
// OffscreenCanvas or workers the old way is used.
//
// letterbox(source, crop, size) -> { data (RGBA bytes, size x size), ratio, padX, padY }
//   crop: { cx1, cy1, cw, ch } in source pixels.

const PAD = 114

const WORKER_SRC = `
let canvas = null, ctx = null
onmessage = (e) => {
  const { id, bitmap, size, padX, padY, pad } = e.data
  try {
    if (!canvas || canvas.width !== size) {
      canvas = new OffscreenCanvas(size, size)
      ctx = canvas.getContext('2d', { willReadFrequently: true })
    }
    ctx.fillStyle = 'rgb(' + pad + ',' + pad + ',' + pad + ')'
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(bitmap, padX, padY)
    bitmap.close()
    const data = ctx.getImageData(0, 0, size, size).data
    postMessage({ id, data }, [data.buffer])
  } catch (err) {
    try { bitmap.close() } catch (_) {}
    postMessage({ id, error: String(err && err.message || err) })
  }
}`

let worker = null
let broken = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined'
let nextId = 0
const waiting = new Map()

function getWorker() {
  if (broken) return null
  if (worker) return worker
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
    worker = new Worker(url)
    worker.onmessage = ({ data: m }) => {
      const w = waiting.get(m.id)
      if (!w) return
      waiting.delete(m.id)
      if (m.error) w.reject(new Error(m.error))
      else w.resolve(m.data)
    }
    worker.onerror = (e) => {
      console.warn('[framePrep] worker failed, preparing pictures on the page:', e?.message ?? e)
      broken = true
      worker = null
      for (const w of waiting.values()) w.reject(new Error('frame worker stopped'))
      waiting.clear()
    }
  } catch (e) {
    console.warn('[framePrep] no worker, preparing pictures on the page:', e?.message ?? e)
    broken = true
    worker = null
  }
  return worker
}

// The old way, on the page: one shared scratch canvas per size.
const scratch = new Map()
function onPage(source, crop, size, fit) {
  let cx = scratch.get(size)
  if (!cx) {
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    cx = cv.getContext('2d', { willReadFrequently: true })
    scratch.set(size, cx)
  }
  cx.fillStyle = `rgb(${PAD},${PAD},${PAD})`
  cx.fillRect(0, 0, size, size)
  cx.drawImage(source, crop.cx1, crop.cy1, crop.cw, crop.ch, fit.padX, fit.padY, fit.nw, fit.nh)
  return cx.getImageData(0, 0, size, size).data
}

function fitOf(crop, size) {
  const ratio = Math.min(size / crop.cw, size / crop.ch)
  const nw = Math.max(1, Math.round(crop.cw * ratio))
  const nh = Math.max(1, Math.round(crop.ch * ratio))
  return { ratio, nw, nh, padX: Math.floor((size - nw) / 2), padY: Math.floor((size - nh) / 2) }
}

/** Letterbox `crop` of `source` into a size x size square: { data, ratio, padX, padY }. */
export async function letterbox(source, crop, size) {
  const fit = fitOf(crop, size)
  const w = getWorker()
  if (w) {
    try {
      // The frame is taken now (the call's moment), scaled off the page's thread.
      const bitmap = await createImageBitmap(source, crop.cx1, crop.cy1, crop.cw, crop.ch,
        { resizeWidth: fit.nw, resizeHeight: fit.nh, resizeQuality: 'low' })
      const id = ++nextId
      const data = await new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        w.postMessage({ id, bitmap, size, padX: fit.padX, padY: fit.padY, pad: PAD }, [bitmap])
      })
      return { data, ratio: fit.ratio, padX: fit.padX, padY: fit.padY }
    } catch (e) {
      // e.g. a cross-origin video the browser won't hand over: try the old way once.
      if (!broken) console.warn('[framePrep] off-page preparation failed, using the page:', e?.message ?? e)
    }
  }
  return { data: onPage(source, crop, size, fit), ratio: fit.ratio, padX: fit.padX, padY: fit.padY }
}
