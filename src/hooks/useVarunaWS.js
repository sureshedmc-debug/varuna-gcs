import { useEffect, useRef, useState, useCallback } from 'react'
import { wsUrl, api } from '../api/client'

/**
 * Live telemetry via WebSocket (/api/ws) with:
 *  - auto-reconnect every 2s (never hang silently)
 *  - HTTP polling fallback to /api/telemetry when the socket is down
 *  - explicit connection state + "last updated" timestamp for staleness UI
 *
 * Returns { data, status, lastUpdate } where status is one of
 * 'connecting' | 'live' | 'polling' | 'offline'.
 */
export function useVarunaWS({ pollInterval = 2000 } = {}) {
  const [data, setData] = useState(null)
  const [status, setStatus] = useState('connecting')
  const [lastUpdate, setLastUpdate] = useState(0)

  const wsRef = useRef(null)
  const retryRef = useRef(null)
  const pollRef = useRef(null)
  const mounted = useRef(true)

  const apply = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return
    // Unwrap common envelopes without assuming a fixed schema.
    const t = payload.telemetry || payload.data || payload
    setData(t)
    setLastUpdate(Date.now())
  }, [])

  const startPolling = useCallback(() => {
    if (pollRef.current) return
    const tick = async () => {
      try {
        const t = await api.telemetry()
        if (mounted.current) {
          apply(t)
          setStatus((s) => (s === 'live' ? s : 'polling'))
        }
      } catch {
        if (mounted.current) setStatus('offline')
      }
    }
    tick()
    pollRef.current = setInterval(tick, pollInterval)
  }, [apply, pollInterval])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const connect = useCallback(() => {
    let ws
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      startPolling()
      retryRef.current = setTimeout(connect, 2000)
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      if (!mounted.current) return
      setStatus('live')
      stopPolling()
    }
    ws.onmessage = (ev) => {
      if (!mounted.current) return
      try {
        apply(JSON.parse(ev.data))
      } catch {
        /* ignore non-JSON keepalives */
      }
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
    ws.onclose = () => {
      if (!mounted.current) return
      wsRef.current = null
      setStatus((s) => (s === 'offline' ? s : 'polling'))
      startPolling() // keep data flowing while the socket is down
      retryRef.current = setTimeout(connect, 2000) // auto-retry every 2s
    }
  }, [apply, startPolling, stopPolling])

  useEffect(() => {
    mounted.current = true
    connect()
    return () => {
      mounted.current = false
      if (retryRef.current) clearTimeout(retryRef.current)
      stopPolling()
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {
          /* noop */
        }
      }
    }
  }, [connect, stopPolling])

  return { data, status, lastUpdate }
}
