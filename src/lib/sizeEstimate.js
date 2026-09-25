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

/**
 * Convert a detection box (pixels) into a rough real-world size, given the
 * drone's altitude (metres). Assumes the camera looks straight down and there
 * is no lens distortion — good enough for a ±30 % estimate.
 * @returns {widthM, heightM} or null if any input is missing.
 */
export function pixelBoxToRealSize({ boxW, boxH, frameW, frameH, altitudeM, fovDeg } = {}) {
  const alt = Number(altitudeM)
  if (!Number.isFinite(alt) || alt <= 0) return null
  if (!Number.isFinite(Number(boxW)) || !Number.isFinite(Number(boxH))) return null
  if (!Number.isFinite(Number(frameW)) || Number(frameW) <= 0) return null
  if (!Number.isFinite(Number(frameH)) || Number(frameH) <= 0) return null
  const fov = fovDeg || DEFAULT_FOV_DEG
  const groundW = 2 * alt * Math.tan(((fov.horizontal || DEFAULT_FOV_DEG.horizontal) * Math.PI) / 360)
  const groundH = 2 * alt * Math.tan(((fov.vertical || DEFAULT_FOV_DEG.vertical) * Math.PI) / 360)
  return {
    widthM: Math.round((Number(boxW) / Number(frameW)) * groundW * 100) / 100,
    heightM: Math.round((Number(boxH) / Number(frameH)) * groundH * 100) / 100,
  }
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
