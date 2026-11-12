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
//   R1 (RB) → collector scoop: to its extreme / back to 0
//   L1 + R1 together → instant brake: motors stop and the boat disarms
//   MODE (HOME / GUIDE) → next flight mode
//   D-pad left / right → servo 1 / servo 2 on / off (also with an RC transmitter)
//   D-pad down → give both servos back to the transmitter's switches
//
// Browsers only reveal a controller after one of its buttons is pressed.
//
// Controllers that don't report the standard layout (most PS2 pads on a USB
// adapter, many cheap USB pads) number their buttons and sticks their own way.
// "Set up buttons" in the Boat tab learns them: press each control once, and
// the layout is remembered for that controller (by its name) on this PC.
// PS2 names: ✕ = A, ○ = B, □ = X, △ = Y, SELECT = BACK.

export const BUTTON = {
  A: 0, B: 1, X: 2, Y: 3, L1: 4, R1: 5, BACK: 8, START: 9,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, MODE: 16,
}

/** What the MODE button steps through; the GPS-only one is skipped without a 3D fix. */
export const MODE_CYCLE = [
  { id: 'MANUAL' }, { id: 'ACRO' }, { id: 'LOITER', gps: true }, { id: 'HOLD' },
]

/** The mode after `current` in MODE_CYCLE (MANUAL if it isn't in the list). */
export function nextMode(current, gpsOk) {
  const list = MODE_CYCLE.filter((m) => gpsOk || !m.gps).map((m) => m.id)
  const i = list.indexOf(current)
  return i < 0 ? list[0] : list[(i + 1) % list.length]
}
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

// ---------------------------------------------------------------- learned layouts
// {steer: {a, s}, thr: {a, s}, buttons: {standardIndex: {b} | {a, v}}}
//   steer / thr: the axis and its sign (s = +1 / -1 so right / forward is +1)
//   a button: a real button index {b}, or a D-pad hat / trigger axis at a value {a, v}
const LAYOUT_KEY = 'varuna.padLayouts'
let layouts = null

function allLayouts() {
  if (layouts) return layouts
  try {
    layouts = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {}
  } catch {
    layouts = {}
  }
  return layouts
}

/** The learned layout for this controller, or null (the standard layout). */
export function layoutFor(pad) {
  if (!pad) return null
  return allLayouts()[pad.id] || null
}

export function saveLayout(pad, layout) {
  const all = { ...allLayouts() }
  if (layout) all[pad.id] = layout
  else delete all[pad.id]
  layouts = all
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(all)) } catch { /* kept for this session */ }
}

/** What "Set up buttons" asks for, in order. key: 'thr' / 'steer' (sticks) or a BUTTON index. */
export const LEARN_STEPS = [
  { key: 'thr', text: 'Push the LEFT stick UP (forward), then let go', stick: true },
  { key: 'steer', text: 'Push the RIGHT stick RIGHT, then let go', stick: true },
  { key: 5, text: 'Press R1 (collector scoop)' },
  { key: 4, text: 'Press L1 (with R1: brake)' },
  { key: 9, text: 'Press START (hold 1 s: arm)' },
  { key: 8, text: 'Press SELECT (hold 1 s: disarm)' },
  { key: 0, text: 'Press ✕ / A (MANUAL)' },
  { key: 1, text: 'Press ○ / B (HOLD — stop)' },
  { key: 2, text: 'Press □ / X (resume mission)' },
  { key: 3, text: 'Press △ / Y (return home)' },
  { key: 14, text: 'Press D-pad LEFT (servo 1)' },
  { key: 15, text: 'Press D-pad RIGHT (servo 2)' },
  { key: 13, text: 'Press D-pad DOWN (servos back to the transmitter)' },
  { key: 16, text: 'Press MODE / ANALOG (next mode) — or Skip: many PS2 pads don’t report it', optional: true },
]

/** The controller's raw state, for learning. */
export function rawState(pad) {
  return {
    buttons: Array.from(pad?.buttons || []).map((b) => !!(b && (b.pressed || b.value > 0.5))),
    axes: Array.from(pad?.axes || []).map((v) => Number(v) || 0),
  }
}

/** All controls back where they were at rest? */
export function atRest(base, cur) {
  return !cur.buttons.some((p, i) => p && !base.buttons[i]) &&
    cur.axes.every((v, i) => Math.abs(v - (base.axes[i] ?? 0)) < 0.3)
}

/**
 * What changed from rest, for one learning step: a stick step takes the axis
 * that moved most ({a, s}); a button step takes a newly pressed button ({b}),
 * else an axis that jumped (a D-pad hat or an analog trigger, {a, v}). null: nothing yet.
 */
export function detectInput(base, cur, stick) {
  if (!stick) {
    const b = cur.buttons.findIndex((p, i) => p && !base.buttons[i])
    if (b >= 0) return { b }
  }
  let best = -1
  let move = 0
  cur.axes.forEach((v, i) => {
    const d = v - (base.axes[i] ?? 0)
    if (Math.abs(d) > Math.abs(move)) { best = i; move = d }
  })
  if (best < 0 || Math.abs(move) < (stick ? 0.6 : 0.5)) return null
  return stick ? { a: best, s: move > 0 ? 1 : -1 } : { a: best, v: Math.round(cur.axes[best] * 1000) / 1000 }
}

/**
 * One tick of "Set up buttons". L: {padId, base, step, draft: {buttons: {}}, release}.
 * Returns true when the current step was just recorded (the caller moves on).
 * First call: takes the controller at rest; after each control it waits for
 * everything to be let go; a stick moving never counts as a button.
 */
export function learnFeed(L, cur) {
  if (!L.base) { L.base = cur; return false }
  if (L.release) { if (atRest(L.base, cur)) L.release = false; return false }
  const step = LEARN_STEPS[L.step]
  if (!step) return false
  const got = detectInput(L.base, cur, step.stick)
  if (!got) return false
  if (step.stick && step.key === 'steer' && got.a === L.draft.thr?.a) return false   // the other stick, please
  if (!step.stick && got.a != null && [L.draft.thr?.a, L.draft.steer?.a].includes(got.a)) return false
  if (step.stick) L.draft[step.key] = got
  else L.draft.buttons[step.key] = got
  L.release = true
  return true
}

/** Stick value with a dead zone around the centre, rescaled so it still reaches ±1. */
export function shape(v) {
  const x = Number(v) || 0
  const a = Math.abs(x)
  if (a < DEADZONE) return 0
  return Math.sign(x) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE))
}

/** {s: steering -1 (left)…1 (right), t: throttle -1 (reverse)…1 (forward)}. */
export function sticks(pad, layout = layoutFor(pad)) {
  if (!pad) return { s: 0, t: 0 }
  const ax = pad.axes || []
  if (layout?.steer && layout?.thr) {
    return { s: layout.steer.s * shape(ax[layout.steer.a]), t: layout.thr.s * shape(ax[layout.thr.a]) }
  }
  return { s: shape(ax[2]), t: -shape(ax[1]) }
}

/** Is this (standard-layout) button pressed, through the controller's learned layout if it has one. */
export function pressed(pad, index, layout = layoutFor(pad)) {
  if (layout) {
    const m = layout.buttons?.[index]
    if (!m) return false
    if (m.b != null) {
      const b = pad?.buttons?.[m.b]
      return !!(b && (b.pressed || b.value > 0.5))
    }
    const v = Number(pad?.axes?.[m.a])
    // A hat axis has steps ~0.29 apart (up -1 … neutral ~1.29); a trigger just has to get there.
    return Number.isFinite(v) && (Math.abs(v - m.v) < 0.12 || (Math.abs(m.v) >= 0.9 && Math.abs(v) <= 1.05 && v * Math.sign(m.v) >= Math.abs(m.v) - 0.12))
  }
  const b = pad?.buttons?.[index]
  return !!(b && (b.pressed || b.value > 0.5))
}

/** A short name for the controller ("Xbox Wireless Controller (STANDARD GAMEPAD …)" → "Xbox Wireless Controller"). */
export function padName(pad) {
  return String(pad?.id || 'Game controller').replace(/\s*\(.*$/, '').trim() || 'Game controller'
}
