import { AnimatePresence, animate, motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { relTime } from '../lib/format'
import { useToast } from './Toast' // circular with Toast.jsx (StatusOrb) — safe: both only used at render time

// --- Status semantics: green=ok, amber=warn, red=bad. Used NOWHERE else. ---
// Tuned to -600 hues so they stay legible on a light canvas (field-safety).
export const STATUS = {
  ok: { color: '#32D74B', label: 'OK' },
  warn: { color: '#FF9F0A', label: 'WARN' },
  bad: { color: '#FF453A', label: 'FAULT' },
  idle: { color: '#98A0AB', label: '—' },
}

/** A status orb with believable volume + soft glow (not a flat circle). */
export function StatusOrb({ level = 'idle', size = 14, pulse = false }) {
  const c = (STATUS[level] || STATUS.idle).color
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {pulse && (
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ background: c }}
          animate={{ opacity: [0.45, 0], scale: [1, 2.2] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <span
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at 32% 28%, #ffffffcc, ${c} 60%, ${c})`,
          boxShadow: `0 0 10px ${c}66, inset 0 0 4px ${c}`,
        }}
      />
    </span>
  )
}

/** Glass card with an optional few-degree cursor tilt (preserve-3d). */
export function TiltCard({ children, className = '', tilt = true, ...rest }) {
  const ref = useRef(null)
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [6, -6]), { stiffness: 200, damping: 20 })
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-6, 6]), { stiffness: 200, damping: 20 })

  function onMove(e) {
    if (!tilt || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    mx.set((e.clientX - r.left) / r.width - 0.5)
    my.set((e.clientY - r.top) / r.height - 0.5)
  }
  function reset() {
    mx.set(0)
    my.set(0)
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={reset}
      style={{ rotateX: tilt ? rx : 0, rotateY: tilt ? ry : 0, transformPerspective: 900 }}
      className={`glass shadow-elev ${className}`}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

/** Primary/secondary/danger button with press depth + glow. Big touch target. */
export function Btn({ children, variant = 'primary', className = '', disabled, ...rest }) {
  const base =
    'touch relative inline-flex items-center justify-center gap-2 rounded-2xl px-5 font-semibold tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none'
  const textColor = {
    primary: 'text-white',
    danger: 'text-white',
    secondary: 'text-ink',
    ghost: 'text-ink',
  }
  const bg = {
    primary: {
      background: 'linear-gradient(180deg, var(--accent2), var(--accent-hex))',
      boxShadow: '0 8px 24px -6px rgb(var(--accent) / 0.5)',
    },
    danger: {
      background: 'linear-gradient(180deg,#FF6A61,#FF453A)',
      boxShadow: '0 8px 24px -6px rgba(255,69,58,0.45)',
    },
    secondary: { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' },
    ghost: { background: 'transparent', border: '1px solid rgba(255,255,255,0.14)' },
  }
  return (
    <motion.button
      whileTap={disabled ? {} : { scale: 0.96 }}
      whileHover={disabled ? {} : { scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      disabled={disabled}
      style={bg[variant]}
      className={`${base} ${textColor[variant]} ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  )
}

/** "last updated / stale / disconnected" badge for every live value block. */
export function StaleBadge({ lastUpdate, now, staleAfter = 6000, connected = true }) {
  const age = now - lastUpdate
  let level = 'ok'
  let text = relTime(lastUpdate, now)
  if (!connected || !lastUpdate) {
    level = 'bad'
    text = 'disconnected'
  } else if (age > staleAfter) {
    level = 'warn'
    text = `stale · ${relTime(lastUpdate, now)}`
  }
  const c = STATUS[level].color
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tnum"
      style={{ background: `${c}16`, color: c, border: `1px solid ${c}40` }}
    >
      <StatusOrb level={level} size={7} />
      {text}
    </span>
  )
}

export function Field({ label, value, unit, level, mono = true }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      <span
        className={`text-2xl font-semibold ${mono ? 'font-mono tnum' : ''}`}
        style={level ? { color: STATUS[level]?.color } : { color: '#EDEFF2' }}
      >
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted">{unit}</span>}
      </span>
    </div>
  )
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center gap-3 text-muted">
      <motion.span
        className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      />
      <span className="text-sm">{label}…</span>
    </div>
  )
}

/* ================= Flight command buttons + swipe-to-confirm ================= */

function hexA(hex, a) {
  let h = String(hex).replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }
const CMD_ICON = {
  arm: (
    <g {...stroke}>
      <path d="M12 3.5v8" />
      <path d="M6.6 7.2a7.5 7.5 0 1010.8 0" />
    </g>
  ),
  disarm: (
    <g {...stroke}>
      <path d="M12 3.5v8" />
      <path d="M6.6 7.2a7.5 7.5 0 1010.8 0" />
      <path d="M4 4l16 16" />
    </g>
  ),
  takeoff: (
    <g {...stroke}>
      <path d="M12 17V5M6.5 10.5L12 5l5.5 5.5" />
      <path d="M5 20.5h14" />
    </g>
  ),
  rth: (
    <g {...stroke}>
      <path d="M3.5 11.5L12 4l8.5 7.5" />
      <path d="M6.5 9.5V20h11V9.5" />
      <path d="M10 20v-5h4v5" />
    </g>
  ),
  land: (
    <g {...stroke}>
      <path d="M12 3.5v12M6.5 10L12 15.5 17.5 10" />
      <path d="M5 20.5h14" />
    </g>
  ),
  mission: (
    <g {...stroke}>
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </g>
  ),
  stop: (
    <g {...stroke}>
      <path d="M8.3 3.5h7.4l4.8 4.8v7.4l-4.8 4.8H8.3l-4.8-4.8V8.3z" />
      <path d="M9 9h6v6H9z" fill="currentColor" />
    </g>
  ),
}

// color = button icon/border; accent = pop-up circle, knob and fill (defaults to color).
export const FLIGHT_CMD = {
  arm: { caption: 'ARM', color: '#22B865', title: 'Arm Motors', message: 'Motors will spin up at idle. Keep clear of the propellers.', swipe: 'Slide to arm' },
  disarm: { caption: 'DISARM', color: '#FFFFFF', accent: '#2F8FFF', title: 'Disarm Motors', message: 'Motors will stop. Only disarm when the aircraft is on the ground.', swipe: 'Slide to disarm' },
  takeoff: { caption: 'TAKEOFF', color: '#2F8FFF', title: 'Take Off', message: 'The aircraft will take off and hover. Make sure the area around it is clear.', swipe: 'Slide to take off' },
  rth: { caption: 'RTH', color: '#F5B400', title: 'Return to Home', message: 'The aircraft will climb to RTH altitude, fly back to the Home Point and land.', swipe: 'Slide to return home' },
  land: { caption: 'LAND', color: '#2F8FFF', title: 'Land', message: 'The aircraft will descend and land at its current position. Make sure the ground below is clear.', swipe: 'Slide to land' },
  mission: { caption: 'START', color: '#2F8FFF', title: 'Start Mission', message: 'The aircraft will fly the uploaded mission. Make sure the flight path is clear.', swipe: 'Slide to start mission' },
  stop: { caption: 'STOP', color: '#FF3B30', title: 'Emergency Stop', message: 'Cancels the mission and all movement immediately, then lands at the current position. Make sure the ground below is clear.', swipe: 'Slide to stop & land' },
}

/** Dark panel that groups flight-command buttons. */
export function CommandPanel({ children, className = '' }) {
  return (
    <div className={className} style={{ background: '#0E1013', borderRadius: 18, padding: 16 }}>
      <div style={{ color: '#AEB3BA', fontSize: 12, fontWeight: 700, letterSpacing: '1.2px', marginBottom: 12 }}>FLIGHT COMMANDS</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: 18, rowGap: 14 }}>{children}</div>
    </div>
  )
}

/** Round flight-command button. Tapping opens a swipe-to-confirm pop-up; onConfirm runs only after a full swipe. */
export function CommandButton({ cmd, onConfirm, disabled = false }) {
  const c = FLIGHT_CMD[cmd]
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [openId, setOpenId] = useState(0) // fresh pop-up instance per open
  const openedCmdRef = useRef(cmd) // the command the operator actually saw and swiped
  const cmdRef = useRef(cmd)
  cmdRef.current = cmd
  const onConfirmRef = useRef(onConfirm)
  onConfirmRef.current = onConfirm
  const triggerRef = useRef(null)

  function openPopup() {
    openedCmdRef.current = cmd
    setOpenId((n) => n + 1)
    setOpen(true)
  }
  // Only send if the command is still the one that was confirmed. For the ARM/DISARM
  // toggle, a telemetry change mid-swipe must never turn "Arm" into "Disarm".
  function confirmed() {
    if (cmdRef.current !== openedCmdRef.current) {
      toast.push({ level: 'warn', title: 'Aircraft state changed — command not sent' })
      return
    }
    onConfirmRef.current?.()
  }
  if (!c) return null
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <motion.button
          type="button"
          aria-label={c.title}
          ref={triggerRef}
          disabled={disabled}
          onClick={openPopup}
          whileTap={disabled ? undefined : { scale: 0.9 }}
          transition={{ duration: 0.1 }}
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'rgba(21,23,27,0.8)',
            border: `1.5px solid ${hexA(c.color, 0.55)}`,
            color: c.color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.4 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <svg viewBox="0 0 24 24" width="25" height="25" aria-hidden="true">{CMD_ICON[cmd]}</svg>
        </motion.button>
        <span style={{ color: '#FFFFFF', fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase' }}>{c.caption}</span>
      </div>
      <SwipeConfirm
        open={open}
        openId={openId}
        cmd={openedCmdRef.current}
        onClose={() => setOpen(false)}
        onConfirm={confirmed}
        returnFocusRef={triggerRef}
      />
    </>
  )
}

/** Confirm pop-up: backdrop + card + swipe track. Rendered into <body> so transformed parents can't offset it. */
// Optional: `detail` — extra line under the message (e.g. altitude / target);
// `onCancel` — called ONLY on a real cancel (Cancel, backdrop, Escape), never on a swipe;
// `onSwiped` — called the moment the swipe commits (before the close animation).
export function SwipeConfirm({ open, openId = 0, cmd, onClose, onConfirm, returnFocusRef, detail, onCancel, onSwiped }) {
  const c = FLIGHT_CMD[cmd]
  const lockedRef = useRef(false) // set once the swipe fires: no more closing/cancelling
  const pendingRef = useRef(null) // command to run once the close animation finishes
  const cardRef = useRef(null)
  // Parents pass a fresh onClose every render; read it via a ref so the effect
  // below runs only when the pop-up opens (not on every telemetry re-render).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    if (!open) return
    lockedRef.current = false
    pendingRef.current = null // a fresh pop-up never inherits an earlier one's pending confirm
    cardRef.current?.focus()
    // Make the app behind the pop-up inert (no Tab/Enter reaching other buttons
    // or navigation). The pop-up is portalled to <body>, outside #root.
    const root = document.getElementById('root')
    const wasInert = root ? root.inert : false
    if (root) root.inert = true
    const onKey = (e) => {
      if (e.key === 'Escape' && !lockedRef.current) {
        onCancelRef.current?.()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (root) root.inert = wasInert
      returnFocusRef?.current?.focus?.()
    }
  }, [open, returnFocusRef])

  if (!c || typeof document === 'undefined') return null
  const accent = c.accent || c.color
  const close = () => {
    if (lockedRef.current) return
    onCancel?.()
    onClose()
  }

  return createPortal(
    <AnimatePresence
      onExitComplete={() => {
        const run = pendingRef.current
        pendingRef.current = null
        run?.()
      }}
    >
      {open && (
        <motion.div
          key={`swipe-confirm-${openId}`}
          onClick={close}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.54)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-label={c.title}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="focus:outline-none"
            style={{ width: 350, background: 'rgba(18,20,23,0.94)', borderRadius: 18, padding: '22px 22px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: hexA(accent, 0.16), color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">{CMD_ICON[cmd]}</svg>
            </div>
            <div style={{ marginTop: 12, color: '#FFFFFF', fontSize: 19, fontWeight: 700 }}>{c.title}</div>
            <p style={{ marginTop: 8, color: '#AEB3BA', fontSize: 13, lineHeight: 1.45, textAlign: 'center' }}>{c.message}</p>
            {detail && <p style={{ marginTop: 8, color: '#FFFFFF', fontSize: 13, fontWeight: 700, textAlign: 'center' }}>{detail}</p>}
            <div style={{ marginTop: 18 }}>
              <SwipeTrack
                accent={accent}
                label={c.swipe}
                onFire={() => {
                  lockedRef.current = true
                  onSwiped?.()
                }}
                onDone={() => {
                  // Close first; the command runs when the exit animation completes.
                  pendingRef.current = onConfirm
                  onClose()
                }}
              />
            </div>
            <button
              type="button"
              onClick={close}
              className="focus:outline-none focus-visible:underline"
              style={{ marginTop: 4, color: '#AEB3BA', fontSize: 14, padding: '2px 16px', background: 'transparent' }}
            >
              Cancel
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

const TRACK_W = 300
const TRACK_H = 56
const KNOB = 48
const INSET = 4
const TRAVEL = TRACK_W - KNOB - INSET * 2 // 244 px of knob travel
const EASE_OUT_BACK = [0.34, 1.56, 0.64, 1]

function SwipeTrack({ accent, label, onFire, onDone }) {
  const x = useMotionValue(0)
  // Clamped view of x: the ease-out-back spring can overshoot below 0, but the knob never goes left of the start.
  const xc = useTransform(x, (v) => Math.min(TRAVEL, Math.max(0, v)))
  const fillW = useTransform(xc, (v) => v + KNOB + INSET * 2)
  const labelOpacity = useTransform(xc, (v) => Math.max(0, 1 - (v / TRAVEL) * 1.4))
  const [done, setDone] = useState(false)
  const firedRef = useRef(false)
  const dragRef = useRef(null)
  const animRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(
    () => () => {
      animRef.current?.stop()
      clearTimeout(timerRef.current)
    },
    [],
  )

  function fire() {
    if (firedRef.current) return
    firedRef.current = true
    dragRef.current = null
    animRef.current?.stop()
    animRef.current = animate(x, TRAVEL, { duration: 0.12, ease: 'easeOut' })
    setDone(true)
    onFire?.()
    try {
      navigator.vibrate?.(40)
    } catch {
      /* unsupported */
    }
    timerRef.current = setTimeout(() => onDone?.(), 250)
  }

  function springBack() {
    animRef.current?.stop()
    animRef.current = animate(x, 0, { duration: 0.28, ease: EASE_OUT_BACK })
  }

  function onPointerDown(e) {
    if (firedRef.current || !e.isPrimary || e.button !== 0) return
    animRef.current?.stop()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { id: e.pointerId, startX: e.clientX, startV: xc.get() }
  }
  function onPointerMove(e) {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    x.set(Math.min(TRAVEL, Math.max(0, d.startV + (e.clientX - d.startX))))
  }
  function onPointerUp(e) {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    if (xc.get() >= TRAVEL - 6) fire()
    else springBack()
  }
  // An interrupted gesture (e.g. OS takes over the touch) must never confirm.
  function onPointerCancel(e) {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    springBack()
  }
  function onKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (e.repeat) return
    fire()
  }

  return (
    <div style={{ position: 'relative', width: TRACK_W, height: TRACK_H, borderRadius: 28, background: '#2A2D33', overflow: 'hidden', userSelect: 'none' }}>
      <motion.div style={{ position: 'absolute', left: 0, top: 0, height: TRACK_H, width: fillW, borderRadius: 28, background: hexA(accent, 0.28) }} />
      <motion.div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, paddingLeft: KNOB, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', opacity: labelOpacity }}
      >
        <motion.span
          animate={{ opacity: [0.45, 1], x: [0, 6] }}
          transition={{ duration: 1.4, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
          style={{ color: '#B8BCC4', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}
        >
          {label}
        </motion.span>
      </motion.div>
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={`${label}. Press Enter or Space to confirm.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onKeyDown={onKeyDown}
        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        style={{
          position: 'absolute',
          left: INSET,
          top: INSET,
          x: xc,
          width: KNOB,
          height: KNOB,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 12px ${hexA(accent, 0.45)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          touchAction: 'none',
          cursor: done ? 'default' : 'grab',
        }}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          {done ? (
            <path d="M5.5 12.5l4.5 4.5 8.5-9.5" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M9.5 6l6 6-6 6" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </motion.div>
    </div>
  )
}
