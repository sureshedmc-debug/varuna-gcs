// "Set up buttons" for a PS2 pad on a USB adapter (src/lib/gamepad.js): learns a
// non-standard layout, then every control works through it.  Run: node scripts/test-gamepad-learn.mjs
const store = {}
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v) } }
const g = await import('../src/lib/gamepad.js')
const { BUTTON, LEARN_STEPS, learnFeed, layoutFor, pressed, rawState, saveLayout, sticks } = g

let fails = 0
const check = (ok, what) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}`); if (!ok) fails++ }

// A typical PS2 adapter: △○✕□ L2 R2 L1 R1 SELECT START, LX LY RY RX, D-pad on a hat axis (9).
const HAT = { rest: 1.2857, up: -1, right: -0.4286, down: 0.1429, left: 0.7143 }
const PS2 = { tri: 0, cir: 1, cross: 2, sq: 3, L2: 4, R2: 5, L1: 6, R1: 7, SELECT: 8, START: 9 }
function pad() {
  return { id: 'Twin USB Joystick (Vendor: 0810 Product: 0001)', mapping: '', connected: true,
    buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.rest] }
}
const p = pad()
const press = (i, on = true) => { p.buttons[i] = { pressed: on, value: on ? 1 : 0 } }
const reset = () => { p.buttons.forEach((_, i) => press(i, false)); p.axes = [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT.rest] }

// What the operator does for each step.
const actions = {
  thr: () => { p.axes[1] = -1 },        // left stick up: LY goes negative
  steer: () => { p.axes[3] = 1 },       // right stick right: RX (axis 3 on this adapter)
  [BUTTON.R1]: () => press(PS2.R1), [BUTTON.L1]: () => press(PS2.L1),
  [BUTTON.START]: () => press(PS2.START), [BUTTON.BACK]: () => press(PS2.SELECT),
  [BUTTON.A]: () => press(PS2.cross), [BUTTON.B]: () => press(PS2.cir),
  [BUTTON.X]: () => press(PS2.sq), [BUTTON.Y]: () => press(PS2.tri),
  [BUTTON.DPAD_LEFT]: () => { p.axes[9] = HAT.left }, [BUTTON.DPAD_RIGHT]: () => { p.axes[9] = HAT.right },
  [BUTTON.DPAD_DOWN]: () => { p.axes[9] = HAT.down },
}

console.log('PS2 pad, button set-up')
check(!layoutFor(p), 'no layout learned yet')
const L = { padId: p.id, base: null, step: 0, draft: { buttons: {} }, release: false }
learnFeed(L, rawState(p))                                          // at rest
for (const step of LEARN_STEPS) {
  if (step.optional) { L.step += 1; continue }                    // MODE: skipped (no ANALOG report)
  // A wrong move first: during a button step, nudging a stick must not count.
  if (!step.stick && L.draft.thr) {
    p.axes[L.draft.thr.a] = -0.9
    check(!learnFeed(L, rawState(p)), `${step.text.split(' (')[0]}: a stick moving isn't taken as the button`)
    reset(); learnFeed(L, rawState(p))
  }
  actions[step.key]()
  const took = learnFeed(L, rawState(p))
  check(took, `learned: ${step.text.split(' (')[0]}`)
  L.step += 1
  check(!learnFeed(L, rawState(p)), '…held: nothing more until it is let go')
  reset()
  learnFeed(L, rawState(p))                                       // let go
}
saveLayout(p, L.draft)
const lay = layoutFor(p)
check(!!lay && lay.thr.a === 1 && lay.thr.s === -1 && lay.steer.a === 3 && lay.steer.s === 1, `sticks: ${JSON.stringify({ thr: lay.thr, steer: lay.steer })}`)

console.log('Driving with the learned layout')
reset()
check(Object.values(BUTTON).every((b) => !pressed(p, b)), 'at rest: no button reads as pressed (hat at neutral 1.29)')
let st = sticks(p)
check(st.s === 0 && st.t === 0, 'at rest: sticks centred')
p.axes[1] = -1; p.axes[3] = 1
st = sticks(p)
check(st.t === 1 && st.s === 1, `left stick up + right stick right → throttle ${st.t}, steering ${st.s}`)
p.axes[1] = 1; p.axes[3] = -1
st = sticks(p)
check(st.t === -1 && st.s === -1, 'left stick down + right stick left → -1, -1')
p.axes[0] = 1; p.axes[2] = 1; p.axes[1] = 0; p.axes[3] = 0
st = sticks(p)
check(st.t === 0 && st.s === 0, 'the other stick axes (LX, RY) do nothing')
reset()
for (const [name, std, ps2] of [['R1', BUTTON.R1, PS2.R1], ['L1', BUTTON.L1, PS2.L1], ['START', BUTTON.START, PS2.START],
  ['SELECT', BUTTON.BACK, PS2.SELECT], ['✕', BUTTON.A, PS2.cross], ['○', BUTTON.B, PS2.cir], ['□', BUTTON.X, PS2.sq], ['△', BUTTON.Y, PS2.tri]]) {
  press(ps2)
  const on = Object.values(BUTTON).filter((b) => pressed(p, b))
  check(on.length === 1 && on[0] === std, `${name} (PS2 button ${ps2}) → only standard button ${std}`)
  reset()
}
check(!pressed(p, BUTTON.R1) && (press(PS2.R2), !pressed(p, BUTTON.R1)), 'R2 is not R1 (PS2 pads have both)')
reset()
for (const [name, std, v] of [['◀', BUTTON.DPAD_LEFT, HAT.left], ['▶', BUTTON.DPAD_RIGHT, HAT.right], ['▼', BUTTON.DPAD_DOWN, HAT.down]]) {
  p.axes[9] = v
  const on = Object.values(BUTTON).filter((b) => pressed(p, b))
  check(on.length === 1 && on[0] === std, `D-pad ${name} (hat ${v}) → only button ${std}`)
}
p.axes[9] = HAT.up
check(Object.values(BUTTON).every((b) => !pressed(p, b)), 'D-pad ▲ (not set up) presses nothing')
check(!pressed(p, BUTTON.MODE), 'MODE skipped → never pressed')

console.log('A standard controller is unchanged')
const xbox = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', mapping: 'standard', buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, -1, 1, 0] }
xbox.buttons[5] = { pressed: true, value: 1 }
check(!layoutFor(xbox) && pressed(xbox, BUTTON.R1) && sticks(xbox).t === 1 && sticks(xbox).s === 1, 'standard pad: R1 = 5, LY up = forward, axis 2 = steering')
saveLayout(p, null)
check(!layoutFor(p), '"Standard" forgets the learned layout')

console.log(fails ? `\n${fails} FAILED` : '\nPS2 BUTTON SET-UP TESTS PASSED')
process.exit(fails ? 1 : 0)
