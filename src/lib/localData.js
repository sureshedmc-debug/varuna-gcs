// Client for the local data store (electron/localData.cjs), reached same-origin
// under /local/*: CSV records, the state/river catalog and sign-in.
//
// Records go through an outbox kept in localStorage, so a save that fails (the
// CSV is open in Excel, the store is briefly busy) is retried instead of lost.

import { useSyncExternalStore } from 'react'

export class LocalDataError extends Error {
  constructor(code, message, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

const UNAVAILABLE =
  'Local data storage is not available here. It runs inside the VARUNA desktop app (and `npm run dev`); this copy of the app is served from somewhere else.'

/** GET (no body) or POST JSON to the store; resolves with its JSON or throws LocalDataError. */
export async function localCall(path, body) {
  let res
  try {
    res = await fetch(path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new LocalDataError('offline', 'The local data store did not answer. Is the app still running?')
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    /* not JSON: an app shell or a proxy page, i.e. no store here */
  }
  if (!json || typeof json.ok !== 'boolean') throw new LocalDataError('unavailable', UNAVAILABLE, res.status)
  if (!json.ok) throw new LocalDataError(json.code || 'error', json.error || `Request failed (${res.status})`, res.status)
  return json
}

export const fetchCatalog = () => localCall('/local/catalog')
export const fetchDataStatus = () => localCall('/local/status')
export const exportHref = (table) => `/local/export/${encodeURIComponent(table)}.csv`

// ---------------------------------------------------------------- outbox
const OUTBOX_KEY = 'varuna.outbox'
const MAX_PENDING = 300 // localStorage is ~5 MB; old saves beyond this are dropped
const RETRY_MS = 10000

let nextId = 1
const newId = () => `${Date.now().toString(36)}-${nextId++}`

function loadOutbox() {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX_KEY))
    return Array.isArray(v) ? v.filter((x) => x && Array.isArray(x.ops)).map((x) => ({ ...x, id: x.id || newId() })) : []
  } catch {
    return []
  }
}

let outbox = loadOutbox()
let inFlight = null // id of the item being sent; it must not be merged into or dropped
let flushing = false
let retryTimer = null
// The app is served from somewhere without a store (e.g. the drone's Pi): stop
// queueing saves that can never be delivered instead of filling localStorage.
let storeMissing = false
let status = { pending: outbox.length, lastError: null, lastErrorCode: null, lastSavedAt: null, dropped: 0 }
const subs = new Set()

function setStatus(patch) {
  status = { ...status, ...patch, pending: outbox.length }
  subs.forEach((fn) => fn())
}

function persistOutbox() {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox))
  } catch {
    // Storage full: keep the newer half (and the item being sent) rather than
    // losing everything.
    const keepFrom = Math.floor(outbox.length / 2)
    const before = outbox.length
    outbox = outbox.filter((x, i) => i >= keepFrom || x.id === inFlight)
    status = { ...status, dropped: status.dropped + (before - outbox.length) }
    try {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox))
    } catch {
      /* private mode: the outbox lives in memory only */
    }
  }
}

function removeItem(id) {
  outbox = outbox.filter((x) => x.id !== id)
  persistOutbox()
}

function scheduleRetry() {
  if (retryTimer || !outbox.length) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    flushOutbox()
  }, RETRY_MS)
}

export async function flushOutbox() {
  if (flushing) return
  flushing = true
  try {
    while (outbox.length) {
      const item = outbox[0]
      inFlight = item.id
      try {
        await localCall('/local/records', { ops: item.ops })
        inFlight = null
        removeItem(item.id)
        storeMissing = false
        setStatus({ lastSavedAt: Date.now(), lastError: null, lastErrorCode: null })
      } catch (err) {
        inFlight = null
        if (err.code === 'invalid' || err.code === 'too_large') {
          // Retrying a request the store rejects would block everything behind it.
          console.warn('[local-data] save rejected:', err.message, item.ops.map((o) => o.table))
          removeItem(item.id)
          setStatus({ lastError: `A record could not be saved: ${err.message}`, lastErrorCode: err.code })
          continue
        }
        if (err.code === 'unavailable' || err.code === 'forbidden') {
          storeMissing = true
          const n = outbox.length
          outbox = []
          persistOutbox()
          setStatus({ lastError: err.message, lastErrorCode: err.code, dropped: status.dropped + n })
          break
        }
        setStatus({ lastError: err.message, lastErrorCode: err.code })
        scheduleRetry()
        break
      }
    }
  } finally {
    inFlight = null
    flushing = false
  }
}

const detectionsOnly = (ops) => ops.length === 1 && ops[0].table === 'detections' && (ops[0].op || 'upsert') === 'upsert'

/**
 * Queue writes for the CSV store and send them now. Never throws: problems show
 * up in useDataSaveStatus() and the write is retried.
 * @param {{table: string, op?: 'upsert'|'insert'|'replace', rows: object[], where?: object}[]} ops
 */
export function saveRecords(ops) {
  const list = (ops || []).filter((o) => o && Array.isArray(o.rows) && (o.rows.length || o.op === 'replace'))
  if (!list.length || storeMissing) return
  // Detection sync re-sends a sighting every time it is seen again; while the
  // store is unreachable, fold those into one waiting item per sighting.
  const waiting = detectionsOnly(list) && outbox.findLast?.((x) => x.id !== inFlight && detectionsOnly(x.ops))
  if (waiting && waiting.ops[0].rows.length + list[0].rows.length <= 4000) {
    const rows = new Map(waiting.ops[0].rows.map((r) => [r.detection_id, r]))
    for (const r of list[0].rows) {
      const merged = { ...rows.get(r.detection_id) }
      for (const [k, v] of Object.entries(r)) if (v !== undefined) merged[k] = v // undefined = keep
      rows.set(r.detection_id, merged)
    }
    waiting.ops = [{ ...waiting.ops[0], rows: [...rows.values()] }]
  } else {
    outbox.push({ id: newId(), ops: list, at: Date.now() })
  }
  let dropped = 0
  while (outbox.length > MAX_PENDING) {
    const i = outbox.findIndex((x) => x.id !== inFlight)
    outbox.splice(i, 1)
    dropped++
  }
  persistOutbox()
  setStatus(dropped ? { dropped: status.dropped + dropped } : {})
  flushOutbox()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => flushOutbox())
  if (outbox.length) setTimeout(flushOutbox, 1500) // saves left over from the last session
}

/** { pending, lastError, lastErrorCode, lastSavedAt, dropped } */
export function useDataSaveStatus() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => status,
  )
}

// ---------------------------------------------------------------- helpers
/** One CSV event row. */
export function eventRow(event, { missionId = '', sectionNo = '', details = '', user = null } = {}) {
  const at = new Date().toISOString()
  return {
    event_id: `E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    mission_id: missionId,
    section_no: sectionNo,
    event,
    details: typeof details === 'string' ? details : JSON.stringify(details),
    user_id: user?.userId || '',
    user_name: user?.name || '',
  }
}
