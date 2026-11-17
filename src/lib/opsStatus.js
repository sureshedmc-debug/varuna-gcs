// Boat Ops status (boat-pi/boat_extras.py → /api/ops/status), polled once a
// second while anything shows it, shared by every component that asks.

import { useEffect, useState } from 'react'
import { boatApi } from '../api/boatClient'

let data = null
let at = 0
let timer = null
const subs = new Set()

async function tick() {
  try {
    const r = await boatApi.opsStatus()
    if (r && r.success) {
      data = r
      at = Date.now()
    } else if (r && r._httpError === 404) {
      data = { success: false, missing: true }   // an older boat program without /api/ops
    }
  } catch {
    /* boat unreachable: keep the last view, `at` shows its age */
  }
  subs.forEach((fn) => fn())
}

function start() {
  if (timer) return
  tick()
  timer = setInterval(tick, 1000)
}

function stop() {
  if (timer && subs.size === 0) {
    clearInterval(timer)
    timer = null
  }
}

/** { ops, ageMs }: the latest /api/ops/status and how old it is. `enabled` = boat reachable. */
export function useOpsStatus(enabled = true) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    const fn = () => force((n) => n + 1)
    subs.add(fn)
    start()
    return () => {
      subs.delete(fn)
      stop()
    }
  }, [enabled])
  return { ops: enabled ? data : null, ageMs: at ? Date.now() - at : Infinity }
}

export const fmt8 = (v) => (Number.isFinite(v) ? Number(v).toFixed(8) : '—')
export const fmtM = (v) => (Number.isFinite(v) ? (v < 10 ? v.toFixed(1) : Math.round(v)) + ' m' : '—')
export const clock = (t) => (t ? new Date(t * 1000).toLocaleTimeString([], { hour12: false }) : '')
