import { useEffect, useRef, useState, useCallback } from 'react'

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
      setData(d)
      setError(null)
      setLastUpdate(Date.now())
    } catch (e) {
      if (!mounted.current) return
      setError(e)
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

  return { data, error, lastUpdate, loading, refresh }
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
