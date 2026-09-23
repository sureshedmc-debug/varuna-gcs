// Defensive formatting helpers. Missing/undefined => "no data" markers, never 0.

export const DASH = '—'

export function num(v, digits = 0) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return DASH
  return Number(v).toFixed(digits)
}

export function pick(obj, keys, fallback = undefined) {
  if (!obj) return fallback
  for (const k of keys) {
    if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') return obj[k]
  }
  return fallback
}

export function bool(v) {
  if (v === true || v === 'true' || v === 1) return true
  if (v === false || v === 'false' || v === 0) return false
  return undefined
}

export function relTime(ts, now = Date.now()) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 2) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export function fmtCoord(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return DASH
  return Number(v).toFixed(6)
}

export function fmtClock(ts) {
  if (!ts) return DASH
  const d = typeof ts === 'number' ? new Date(ts * (ts < 1e12 ? 1000 : 1)) : new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts)
  return d.toLocaleTimeString([], { hour12: false })
}
