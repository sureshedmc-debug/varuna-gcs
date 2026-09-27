// Minimal IndexedDB helper — no dependency, promise-based.
//
// Three things in this app outgrew localStorage's ~5MB quota: detection
// photos, the self-training sample set, and cached map tiles. All three live
// in IndexedDB, which has no practical size limit, through this wrapper.
//
// Every call degrades to a no-op/empty result instead of throwing: IndexedDB
// is unavailable in private windows and can be blocked by site-data settings,
// and none of the features built on it are allowed to break the app when it
// isn't there.

const dbs = new Map()

/** Open (and cache) a database. `stores` is [{ name, keyPath, indexes? }]. */
export function openDb(name, version, stores) {
  const hit = dbs.get(name)
  if (hit) return hit
  const p = new Promise((resolve) => {
    let req
    try {
      req = indexedDB.open(name, version)
    } catch {
      return resolve(null) // no IndexedDB at all
    }
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of stores) {
        const store = db.objectStoreNames.contains(s.name)
          ? req.transaction.objectStore(s.name)
          : db.createObjectStore(s.name, { keyPath: s.keyPath })
        for (const ix of s.indexes || []) {
          if (!store.indexNames.contains(ix.name)) store.createIndex(ix.name, ix.keyPath)
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  dbs.set(name, p)
  return p
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store)
}
function wrap(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
}

export async function idbGet(dbp, store, key) {
  const db = await dbp
  if (!db) return undefined
  try {
    return await wrap(tx(db, store, 'readonly').get(key))
  } catch {
    return undefined
  }
}

export async function idbPut(dbp, store, value) {
  const db = await dbp
  if (!db) return false
  try {
    await wrap(tx(db, store, 'readwrite').put(value))
    return true
  } catch {
    return false // QuotaExceededError, or the store was removed
  }
}

/** One transaction for many writes — far faster than awaiting each put. */
export async function idbPutMany(dbp, store, values) {
  const db = await dbp
  if (!db || !values.length) return false
  try {
    const t = db.transaction(store, 'readwrite')
    const os = t.objectStore(store)
    for (const v of values) os.put(v)
    return await new Promise((resolve) => {
      t.oncomplete = () => resolve(true)
      t.onerror = () => resolve(false)
      t.onabort = () => resolve(false)
    })
  } catch {
    return false
  }
}

export async function idbDelete(dbp, store, key) {
  const db = await dbp
  if (!db) return
  try {
    await wrap(tx(db, store, 'readwrite').delete(key))
  } catch {
    /* gone already */
  }
}

export async function idbDeleteMany(dbp, store, keys) {
  const db = await dbp
  if (!db || !keys.length) return
  try {
    const t = db.transaction(store, 'readwrite')
    const os = t.objectStore(store)
    for (const k of keys) os.delete(k)
    await new Promise((resolve) => {
      t.oncomplete = resolve
      t.onerror = resolve
      t.onabort = resolve
    })
  } catch {
    /* noop */
  }
}

export async function idbGetAll(dbp, store) {
  const db = await dbp
  if (!db) return []
  try {
    return (await wrap(tx(db, store, 'readonly').getAll())) || []
  } catch {
    return []
  }
}

export async function idbCount(dbp, store) {
  const db = await dbp
  if (!db) return 0
  try {
    return (await wrap(tx(db, store, 'readonly').count())) || 0
  } catch {
    return 0
  }
}

export async function idbClear(dbp, store) {
  const db = await dbp
  if (!db) return
  try {
    await wrap(tx(db, store, 'readwrite').clear())
  } catch {
    /* noop */
  }
}

/**
 * Walk a store without loading every record into memory — used to total
 * stored bytes and to find the oldest records to prune. `visit(value)` may
 * return false to stop early.
 */
export async function idbEach(dbp, store, visit, { index, direction = 'next' } = {}) {
  const db = await dbp
  if (!db) return
  try {
    const os = tx(db, store, 'readonly')
    const src = index ? os.index(index) : os
    await new Promise((resolve) => {
      const req = src.openCursor(null, direction)
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) return resolve()
        if (visit(cur.value) === false) return resolve()
        cur.continue()
      }
      req.onerror = () => resolve()
    })
  } catch {
    /* noop */
  }
}

/** Rough byte size of a stored value, for the storage read-outs. */
export function sizeOf(v) {
  if (v == null) return 0
  if (typeof v === 'string') return v.length // data URLs are ASCII, 1 byte/char
  if (v instanceof Blob) return v.size
  if (v instanceof ArrayBuffer) return v.byteLength
  if (ArrayBuffer.isView(v)) return v.byteLength
  return 0
}
