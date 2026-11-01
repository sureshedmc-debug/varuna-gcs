import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { boatApi, boatDriveUrl } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { useToast } from './Toast'
import { isOk } from '../lib/commands'
import { BUTTON, HOLD_MS, gamepadSupported, nextMode, padName, pressed, readPad, sticks } from '../lib/gamepad'

const Ctx = createContext(null)
export const useBoatDrive = () => useContext(Ctx)

const PREF_KEY = 'varuna.boatGamepad'
const TICK_MS = 50 // 20 updates a second to the boat

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Drives the boat with a game controller on this PC, when the boat is set up
 * for it (rc_source "gamepad": no RC transmitter). Runs on every tab, so B
 * (HOLD) always works. Sends the sticks over /api/drive 20 times a second; the
 * boat centres them if they stop arriving and holds if the link stays down.
 *
 * Only while this window has focus: an unfocused window may keep reporting the
 * last stick position, so the socket is closed instead (the boat centres the
 * sticks the moment it closes).
 */
export function BoatDriveProvider({ children }) {
  const boat = useBoat()
  const toast = useToast()
  const [enabled, setEnabledState] = useState(readPref)
  const [view, setView] = useState({ pad: null, standard: true, s: 0, t: 0, linked: false, focused: true })
  const [last, setLast] = useState(null) // last button action {text, ok, t}
  const t = boat?.telemetry?.data
  const online = boat?.reachable === true && !!t
  const source = online ? t.drive?.source || 'transmitter' : null
  const want = enabled && online && source === 'gamepad' && boat.fcConnected

  const wsRef = useRef(null)
  const prevRef = useRef({})        // button → was pressed
  const holdRef = useRef({})        // START / BACK → press start time (null once fired)
  const busyRef = useRef(false)
  const viewRef = useRef(view)
  const armedRef = useRef(false)
  armedRef.current = online && t.armed === true
  const modeRef = useRef({ mode: null, gpsOk: false })
  modeRef.current = { mode: online ? t.flight_mode : null, gpsOk: online && (Number(t.gps_fix) || 0) >= 3 }

  const act = useCallback(async (label, fn) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const res = await fn()
      const okay = isOk(res)
      setLast({ text: `${label}: ${res?.message || (okay ? 'done' : 'failed')}`, ok: okay, t: Date.now() })
      if (!okay) toast.push({ level: 'warn', title: `Controller — ${label}`, msg: res?.message || 'The boat refused.' })
    } catch (e) {
      setLast({ text: `${label}: ${e?.message || e}`, ok: false, t: Date.now() })
    } finally {
      busyRef.current = false
    }
  }, [toast])

  // Instant brake: never waits behind another button's command. Sent over the
  // open drive socket (fastest) and over HTTP (for the result).
  const brake = useCallback(async (ws) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ brake: true })) } catch { /* HTTP below still goes */ }
    }
    try {
      const res = await boatApi.brake()
      const okay = isOk(res)
      setLast({ text: `BRAKE: ${res?.message || (okay ? 'done' : 'failed')}`, ok: okay, t: Date.now() })
      if (!okay) toast.push({ level: 'bad', title: 'Controller — BRAKE', msg: res?.message || 'The boat refused.' })
    } catch (e) {
      setLast({ text: `BRAKE: ${e?.message || e}`, ok: false, t: Date.now() })
    }
  }, [toast])

  useEffect(() => {
    if (!gamepadSupported()) return undefined
    let lastView = 0
    const timer = setInterval(() => {
      const pad = readPad()
      const focused = typeof document === 'undefined' || (document.hasFocus() && !document.hidden)
      const st = sticks(pad)
      const active = want && pad && focused

      // Socket: open while driving is possible, closed otherwise (closing centres the sticks on the boat).
      let ws = wsRef.current
      if (active && !ws) {
        try {
          ws = new WebSocket(boatDriveUrl())
          ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null }
          ws.onerror = () => {}
          wsRef.current = ws
        } catch {
          wsRef.current = null
        }
      } else if (!active && ws) {
        wsRef.current = null
        ws.onclose = null
        try { ws.close() } catch { /* already closed */ }
        ws = null
      }
      if (active && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ s: +st.s.toFixed(3), t: +st.t.toFixed(3), pad: padName(pad) }))
      }

      // Buttons: L1 + R1 brake, A/B/X/Y/R1/MODE on press, START/BACK held for a second.
      if (active) {
        const now = Date.now()
        const edge = (b) => { const p = pressed(pad, b); const e = p && !prevRef.current[b]; prevRef.current[b] = p; return e }
        const l1 = pressed(pad, BUTTON.L1)
        const r1Press = edge(BUTTON.R1)
        const both = l1 && pressed(pad, BUTTON.R1)
        const brakePress = both && !prevRef.current.brake
        prevRef.current.brake = both
        if (brakePress) brake(ws)
        else if (r1Press && !l1) act('Roller', () => boatApi.collector())
        if (edge(BUTTON.MODE)) {
          const m = nextMode(modeRef.current.mode, modeRef.current.gpsOk)
          act(`Mode ${m}`, () => boatApi.setMode(m))
        }
        if (edge(BUTTON.A)) act('MANUAL', () => boatApi.setMode('MANUAL'))
        if (edge(BUTTON.B)) act('HOLD', boatApi.hold)
        if (edge(BUTTON.X)) act('Resume mission', boatApi.missionStart)
        if (edge(BUTTON.Y)) act('Return home', boatApi.rtl)
        for (const [b, label, arm] of [[BUTTON.START, 'Arm', true], [BUTTON.BACK, 'Disarm', false]]) {
          if (!pressed(pad, b)) { holdRef.current[b] = undefined; continue }
          if (holdRef.current[b] === undefined) holdRef.current[b] = now
          if (holdRef.current[b] !== null && now - holdRef.current[b] >= HOLD_MS) {
            holdRef.current[b] = null // once per press
            if (arm !== armedRef.current) act(label, () => boatApi.arm(arm))
          }
        }
      } else {
        prevRef.current = {}
        holdRef.current = {}
      }

      // The card's view, ~10 times a second.
      if (Date.now() - lastView > 100) {
        lastView = Date.now()
        const next = {
          pad: pad ? padName(pad) : null, standard: !pad || pad.mapping === 'standard',
          s: st.s, t: st.t, linked: !!(ws && ws.readyState === WebSocket.OPEN), focused,
        }
        const prev = viewRef.current
        if (next.pad !== prev.pad || next.standard !== prev.standard || next.linked !== prev.linked
          || next.focused !== prev.focused || Math.abs(next.s - prev.s) > 0.02 || Math.abs(next.t - prev.t) > 0.02) {
          viewRef.current = next
          setView(next)
        }
      }
    }, TICK_MS)
    return () => {
      clearInterval(timer)
      const ws = wsRef.current
      wsRef.current = null
      if (ws) { ws.onclose = null; try { ws.close() } catch { /* closed */ } }
    }
  }, [want, act, brake])

  const setEnabled = useCallback((on) => {
    setEnabledState(on)
    try {
      localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
    } catch {
      /* private mode */
    }
  }, [])

  const value = useMemo(() => ({
    supported: gamepadSupported(), enabled, setEnabled, source, ready: want, ...view, last,
    boatDrive: online ? t.drive || null : null,
  }), [enabled, setEnabled, source, want, view, last, online, t?.drive]) // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
