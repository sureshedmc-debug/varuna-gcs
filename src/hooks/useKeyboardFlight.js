import { useCallback, useEffect, useRef, useState } from 'react'
import { api, controlWsUrl } from '../api/client'

// Keyboard flight for the DRONE (Control tab). The boat is driven by the game
// controller (BoatDriveContext) — the two never share inputs.
//
//   W / S   forward / back        A / D   left / right
//   ↑ / ↓   climb / descend       ← / →   turn left / right
//   Shift   slow (40 %)           G       take keyboard control (GUIDED, hover)
//   Space   BRAKE (stop now)      Esc     release → BRAKE (hover in place)
//
// The keys are sent to the drone's Pi 20 times a second over /api/control as
// -1…1 values; the Pi turns them into GUIDED velocities with its own limits.
// Keys are tracked from keydown / keyup (never polled), and every key is
// released when the window loses focus, a dialog opens or the tab closes.

const TICK_MS = 50
const SLOW = 0.4
const MOVE_KEYS = {
  KeyW: ['x', 1], KeyS: ['x', -1], KeyD: ['y', 1], KeyA: ['y', -1],
  ArrowUp: ['z', 1], ArrowDown: ['z', -1], ArrowRight: ['r', 1], ArrowLeft: ['r', -1],
}
const SWALLOW = new Set([...Object.keys(MOVE_KEYS), 'Space', 'ShiftLeft', 'ShiftRight'])

function typingInField(target) {
  const el = target instanceof Element ? target : null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function dialogOpen() {
  // The slide-to-confirm dialogs make the app root inert while they are open.
  return !!document.getElementById('root')?.inert || !!document.querySelector('[aria-modal="true"]')
}

/** Axes from the held keys: {x, y, z, r} each -1…1. */
function axesFrom(held) {
  const a = { x: 0, y: 0, z: 0, r: 0 }
  for (const code of held) {
    const m = MOVE_KEYS[code]
    if (m) a[m[0]] += m[1]
  }
  const k = held.has('ShiftLeft') || held.has('ShiftRight') ? SLOW : 1
  for (const key of Object.keys(a)) a[key] = Math.max(-1, Math.min(1, a[key])) * k
  return a
}

/**
 * @param {object} o
 * @param {boolean} o.enabled   a real drone is connected (not the simulator)
 * @param {boolean} o.active    the drone reports keyboard flight on (GUIDED, taken)
 * @param {(msg: string, ok: boolean) => void} o.onAction  feedback for G / Space / Esc
 */
export function useKeyboardFlight({ enabled, active, onAction }) {
  const heldRef = useRef(new Set())
  const wsRef = useRef(null)
  const [held, setHeld] = useState(() => new Set())
  const [focused, setFocused] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()))
  const [linked, setLinked] = useState(false)
  const busyRef = useRef(false)
  const actionRef = useRef(onAction)
  actionRef.current = onAction

  const releaseAll = useCallback(() => {
    if (heldRef.current.size === 0) return
    heldRef.current = new Set()
    setHeld(new Set())
  }, [])

  const act = useCallback(async (label, fn) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const res = await fn()
      const okay = !!res && res.success !== false && !res._httpError
      actionRef.current?.(`${label}: ${res?.message || (okay ? 'done' : 'failed')}`, okay)
    } catch (e) {
      actionRef.current?.(`${label}: ${e?.message || e}`, false)
    } finally {
      busyRef.current = false
    }
  }, [])

  const take = useCallback(() => act('Keyboard control', api.controlTake), [act])
  const release = useCallback(() => act('Released', api.controlRelease), [act])
  const brake = useCallback(() => act('BRAKE', () => api.setMode('BRAKE')), [act])

  // Key events: only while this tab is mounted, no field is focused and no dialog is open.
  useEffect(() => {
    if (!enabled) return undefined
    const down = (e) => {
      if (typingInField(e.target) || dialogOpen()) { releaseAll(); return }
      const code = e.code
      if (SWALLOW.has(code)) e.preventDefault()        // no page scrolling with arrows / space
      if (e.repeat) return
      if (code === 'KeyG') return take()
      if (code === 'Space') return brake()
      if (code === 'Escape') return active ? release() : undefined
      if (MOVE_KEYS[code] || code === 'ShiftLeft' || code === 'ShiftRight') {
        heldRef.current = new Set(heldRef.current).add(code)
        setHeld(heldRef.current)
      }
    }
    const up = (e) => {
      if (!heldRef.current.has(e.code)) return
      const next = new Set(heldRef.current)
      next.delete(e.code)
      heldRef.current = next
      setHeld(next)
    }
    const blur = () => { releaseAll(); setFocused(false) }
    const focus = () => setFocused(true)
    const vis = () => { if (document.hidden) blur() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', vis)
      releaseAll()
    }
  }, [enabled, active, take, brake, release, releaseAll])

  // The socket: open while keyboard flight is on. Sends the keys (zeros when
  // none are held, or while the window is in the background) 20 times a second
  // — steady packets tell the Pi the app is still there.
  useEffect(() => {
    if (!enabled || !active) return undefined
    let closed = false
    let ws = null
    let retry = null
    const open = () => {
      if (closed) return
      try {
        ws = new WebSocket(controlWsUrl())
      } catch {
        retry = setTimeout(open, 1000)
        return
      }
      wsRef.current = ws
      ws.onopen = () => setLinked(true)
      ws.onclose = () => {
        setLinked(false)
        if (wsRef.current === ws) wsRef.current = null
        if (!closed) retry = setTimeout(open, 1000)
      }
      ws.onerror = () => {}
    }
    open()
    const timer = setInterval(() => {
      const s = wsRef.current
      if (!s || s.readyState !== WebSocket.OPEN) return
      const usable = document.hasFocus() && !document.hidden && !dialogOpen()
      if (!usable && heldRef.current.size) releaseAll()
      const a = usable ? axesFrom(heldRef.current) : { x: 0, y: 0, z: 0, r: 0 }
      s.send(JSON.stringify(a))
    }, TICK_MS)
    return () => {
      closed = true
      clearInterval(timer)
      clearTimeout(retry)
      const s = wsRef.current
      wsRef.current = null
      if (s) { s.onclose = null; try { s.close() } catch { /* closed */ } }
      setLinked(false)
    }
  }, [enabled, active, releaseAll])

  return { held, axes: axesFrom(held), focused, linked, take, release, brake }
}
