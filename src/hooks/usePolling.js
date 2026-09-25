import { useEffect, useRef, useState, useCallback, useMemo } from 'react'

// Same content as last time? Then keep the old object, so screens (and
// memoised values built from it) don't redo their work on every poll.
function sameJson(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * Poll an async fn on an interval, tracking data + error + a "last updated"
 * timestamp so the UI can show stale/disconnected state on every live value.
 */
export function usePolling(fn, interval = 4000, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(0)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const refresh = useCallback(async () => {
    try {
      const d = await fnRef.current()
      if (!mounted.current) return
      setData((prev) => (sameJson(prev, d) ? prev : d))
      setError(null)
      setLastUpdate(Date.now())
    } catch (e) {
      if (!mounted.current) return
      // A repeat of the same failure (e.g. backend offline) doesn't re-render.
      setError((prev) => (prev && String(prev?.message ?? prev) === String(e?.message ?? e) ? prev : e))
    } finally {
      if (mounted.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    mounted.current = true
    refresh()
    const id = setInterval(refresh, interval)
    return () => {
      mounted.current = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, ...deps])

  return useMemo(() => ({ data, error, lastUpdate, loading, refresh }), [data, error, lastUpdate, loading, refresh])
}

/** Ticking "now" so staleness labels update without new fetches. */
export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}
