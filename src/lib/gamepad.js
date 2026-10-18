// Game controller (USB / Bluetooth gamepad) for driving the boat by hand.
//
// Read through the browser's Gamepad API. Most controllers (Xbox, PlayStation,
// most generic USB pads) report the "standard" layout, used here:
//
//   left stick  up / down   → throttle (forward / reverse)
//   right stick left / right → steering
//   A  → MANUAL (drive with the sticks)     B → HOLD (stop)
//   X  → resume the collection mission      Y → return home
//   hold START 1 s → arm                    hold BACK / VIEW 1 s → disarm
//
// Browsers only reveal a controller after one of its buttons is pressed.

export const BUTTON = { A: 0, B: 1, X: 2, Y: 3, BACK: 8, START: 9 }
export const HOLD_MS = 1000
const DEADZONE = 0.12

export function gamepadSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
}

/** The first connected controller (the standard-layout one if there are several), or null. */
export function readPad() {
  if (!gamepadSupported()) return null
  let pads = []
  try {
    pads = Array.from(navigator.getGamepads() || []).filter((p) => p && p.connected)
  } catch {
    return null
  }
  return pads.find((p) => p.mapping === 'standard') || pads[0] || null
}

/** Stick value with a dead zone around the centre, rescaled so it still reaches ±1. */
export function shape(v) {
  const x = Number(v) || 0
  const a = Math.abs(x)
  if (a < DEADZONE) return 0
  return Math.sign(x) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE))
}

/** {s: steering -1 (left)…1 (right), t: throttle -1 (reverse)…1 (forward)}. */
export function sticks(pad) {
  if (!pad) return { s: 0, t: 0 }
  const ax = pad.axes || []
  return { s: shape(ax[2]), t: -shape(ax[1]) }
}

export function pressed(pad, index) {
  const b = pad?.buttons?.[index]
  return !!(b && (b.pressed || b.value > 0.5))
}

/** A short name for the controller ("Xbox Wireless Controller (STANDARD GAMEPAD …)" → "Xbox Wireless Controller"). */
export function padName(pad) {
  return String(pad?.id || 'Game controller').replace(/\s*\(.*$/, '').trim() || 'Game controller'
}
