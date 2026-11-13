// Rough real-world size + weight estimate for a detection.
//
// Size: pinhole-camera math from the drone's altitude and the camera's field
// of view — 2 * altitude * tan(fov/2) is the width of ground the camera sees,
// so the box's width in pixels maps to metres by (boxW / frameW) * ground.
//
// Weight: number of items × an average weight per class. Deliberately NOT an
// area-to-mass guess — floating debris varies too much per unit area for that
// to be honest, but "we saw N bottles at ~18 g each" is a defensible estimate
// the report can label clearly as rough.

import { useEffect, useState } from 'react'

const KEY = 'varuna.fovSettings'
const EVT = 'varuna:fovSettings'

// Raspberry Pi Camera Module v2 (a common default on this class of drone)
// gives ~62.2° horizontal, ~48.8° vertical. Adjustable on the System tab.
export const DEFAULT_FOV_DEG = { horizontal: 62, vertical: 46 }
export const DEFAULT_AVG_WEIGHT_G = { 'plastic bottle': 18, trash: 40, 'river trash': 35 }

function defaults() {
  return {
    fovHorizontalDeg: DEFAULT_FOV_DEG.horizontal,
    fovVerticalDeg: DEFAULT_FOV_DEG.vertical,
    avgWeightG: { ...DEFAULT_AVG_WEIGHT_G },
    // How the straight-down camera is mounted (used to place each item on the map):
    cameraRotationDeg: 0, // which way the TOP of the picture faces: 0 front, 90 right, 180 back, 270 left
    cameraGimbal: false, // on a stabilising gimbal: the picture stays level when the drone tilts
  }
}

export function getFovSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return defaults()
    return {
      fovHorizontalDeg: Number(raw.fovHorizontalDeg) || DEFAULT_FOV_DEG.horizontal,
      fovVerticalDeg: Number(raw.fovVerticalDeg) || DEFAULT_FOV_DEG.vertical,
      avgWeightG: { ...DEFAULT_AVG_WEIGHT_G, ...(raw.avgWeightG || {}) },
      cameraRotationDeg: [0, 90, 180, 270].includes(Number(raw.cameraRotationDeg)) ? Number(raw.cameraRotationDeg) : 0,
      cameraGimbal: raw.cameraGimbal === true,
    }
  } catch {
    return defaults()
  }
}

export function setFovSettings(patch) {
  const next = { ...getFovSettings(), ...(patch || {}) }
  next.avgWeightG = { ...DEFAULT_AVG_WEIGHT_G, ...(next.avgWeightG || {}) }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }))
  } catch {
    /* SSR */
  }
  return next
}

export function useFovSettings() {
  const [s, setS] = useState(getFovSettings)
  useEffect(() => {
    const onEvt = (e) => setS(e.detail && typeof e.detail === 'object' ? e.detail : getFovSettings())
    const onStorage = (e) => {
      if (e.key === KEY) setS(getFovSettings())
    }
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return s
}

// Below 2 m the barometric altitude is mostly noise (and on the ground it is
// ~0), so a size would be meaningless; above 150 m an item is a few pixels.
export const MIN_SIZE_ALT_M = 2
export const MAX_SIZE_ALT_M = 150

/**
 * Metres of ground covered by one pixel, for a camera looking straight down.
 * Only the horizontal field of view is used: pixels are square, so the same
 * scale holds vertically. (Using the sensor's vertical FOV instead is wrong
 * for a 16:9 frame — 720p crops the top and bottom of a 4:3 sensor, which
 * made heights ~25 % too big.)
 * @returns metres per pixel, or null when the altitude is unusable.
 */
export function metersPerPixel({ frameW, altitudeM, fovHDeg } = {}) {
  const alt = Number(altitudeM)
  const fw = Number(frameW)
  if (!Number.isFinite(alt) || alt < MIN_SIZE_ALT_M || alt > MAX_SIZE_ALT_M) return null
  if (!Number.isFinite(fw) || fw <= 0) return null
  const fov = Number(fovHDeg) || DEFAULT_FOV_DEG.horizontal
  return (2 * alt * Math.tan((fov * Math.PI) / 360)) / fw
}

/**
 * Convert a detection box (pixels) into a rough real-world size, given the
 * drone's altitude (metres). Assumes the camera looks straight down and there
 * is no lens distortion — good enough for a ±30 % estimate.
 * @returns {widthM, heightM} or null if any input is missing.
 */
export function pixelBoxToRealSize({ boxW, boxH, frameW, altitudeM, fovDeg } = {}) {
  if (!Number.isFinite(Number(boxW)) || !Number.isFinite(Number(boxH))) return null
  const mpp = metersPerPixel({ frameW, altitudeM, fovHDeg: fovDeg?.horizontal })
  if (mpp == null) return null
  return {
    widthM: Math.round(Number(boxW) * mpp * 100) / 100,
    heightM: Math.round(Number(boxH) * mpp * 100) / 100,
  }
}

// Size classes by an item's longest side. Ranges and typical items are shown
// in the report so a reader knows what "large" means.
export const SIZE_CLASSES = [
  { key: 'small', label: 'Small', maxM: 0.15, range: 'under 15 cm', examples: 'caps, wrappers, cups' },
  { key: 'medium', label: 'Medium', maxM: 0.5, range: '15–50 cm', examples: 'bottles, bags, food containers' },
  { key: 'large', label: 'Large', maxM: 1.5, range: '50 cm – 1.5 m', examples: 'sacks, jerrycans, crates, sheets' },
  { key: 'xlarge', label: 'Very large', maxM: Infinity, range: 'over 1.5 m', examples: 'debris mats, dumped piles, nets' },
]
export const SIZE_LABEL = Object.fromEntries(SIZE_CLASSES.map((c) => [c.key, c.label]))

export function sizeClassOf(lengthM) {
  const m = Number(lengthM)
  if (!Number.isFinite(m) || m <= 0) return null
  return SIZE_CLASSES.find((c) => m < c.maxM).key
}

/** "≈30 cm" / "≈1.2 m" for a length in metres. */
export function fmtLength(m) {
  const n = Number(m)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1) return `≈${Math.max(1, Math.round(n * 100))} cm`
  return `≈${n.toFixed(1)} m`
}

// Items count as one cluster when their centres all fit within this ground span.
export const CLUSTER_MIN_ITEMS = 3
export const CLUSTER_MAX_SPAN_M = 15

/**
 * Sizes for every plastic box in one frame, plus what the group looks like.
 * @param boxes  [{x1,y1,x2,y2}] in source pixels
 * @returns null without a usable altitude, else
 *   { items:[{lengthM, widthM, heightM, size}], largestM, largestSize, counts:{small,…},
 *     largeCount, totalAreaM2, spanM, cluster }
 */
export function summarizeSizes(boxes, { frameW, altitudeM, fovHDeg } = {}) {
  const mpp = metersPerPixel({ frameW, altitudeM, fovHDeg })
  if (mpp == null || !boxes?.length) return null
  const counts = { small: 0, medium: 0, large: 0, xlarge: 0 }
  let totalAreaM2 = 0
  let largestM = 0
  const cx = []
  const cy = []
  const items = boxes.map((b) => {
    const widthM = (b.x2 - b.x1) * mpp
    const heightM = (b.y2 - b.y1) * mpp
    const lengthM = Math.max(widthM, heightM)
    const size = sizeClassOf(lengthM)
    if (size) counts[size]++
    totalAreaM2 += widthM * heightM
    largestM = Math.max(largestM, lengthM)
    cx.push(((b.x1 + b.x2) / 2) * mpp)
    cy.push(((b.y1 + b.y2) / 2) * mpp)
    return { lengthM, widthM, heightM, size }
  })
  const spanM = items.length > 1 ? Math.hypot(Math.max(...cx) - Math.min(...cx), Math.max(...cy) - Math.min(...cy)) : 0
  return {
    items,
    largestM: Math.round(largestM * 100) / 100,
    largestSize: sizeClassOf(largestM),
    counts,
    largeCount: counts.large + counts.xlarge,
    totalAreaM2: Math.round(totalAreaM2 * 100) / 100,
    spanM: Math.round(spanM * 10) / 10,
    cluster: items.length >= CLUSTER_MIN_ITEMS && spanM <= CLUSTER_MAX_SPAN_M,
  }
}

/**
 * One line for a sighting — "cluster of 7 items over ~4 m, 2 of them large
 * (largest ≈80 cm)" / "1 medium item ≈30 cm". Fields as stored in the trash log.
 */
export function describeSighting({ count, largestM, largeCount, cluster, spanM } = {}) {
  const n = Math.max(1, Number(count) || 1)
  if (!Number.isFinite(Number(largestM)) || largestM <= 0) return null
  const biggest = fmtLength(largestM)
  const size = SIZE_LABEL[sizeClassOf(largestM)]?.toLowerCase()
  if (cluster) {
    const big = largeCount > 0 ? `, ${largeCount} of them large` : ''
    const heavy = largeCount > 0 ? 'Cluster of large debris' : 'Cluster'
    return `${heavy}: ${n} items over ~${Math.max(1, Math.round(spanM || 0))} m${big} (largest ${biggest})`
  }
  if (n === 1) return `1 ${size} item ${biggest}`
  return `${n} items, largest ${size} ${biggest}`
}

/** Grams — item count × average per-item weight for the class. */
export function estimateWeightG(cls, itemCount, avgWeightG) {
  const table = avgWeightG || DEFAULT_AVG_WEIGHT_G
  const per = Number(table[cls] ?? DEFAULT_AVG_WEIGHT_G[cls] ?? DEFAULT_AVG_WEIGHT_G.trash) || 0
  const n = Math.max(0, Number(itemCount) || 0)
  return Math.round(per * n)
}

/** Pretty label for a weight in grams — "~180 g" or "~1.4 kg". */
export function fmtWeight(g) {
  const n = Number(g) || 0
  if (n < 1000) return `~${n} g`
  return `~${(n / 1000).toFixed(1)} kg`
}
