// node scripts/test-drone-boat-trigger.mjs
// The drone-box -> boat motor + buzzer trigger (src/lib/droneBoatTrigger.js),
// against a fake boat API and a fake clock.

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

// src/ uses Vite's extensionless imports ('../api/boatClient'): add the .js for Node.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx) }
  catch (e) { if (/^\\.{1,2}\\//.test(spec) && !/\\.[cm]?js$/.test(spec)) return next(spec + '.js', ctx); throw e }
}`))

const { createDroneBoatTrigger, boatReadiness, RESEND_MS } = await import('../src/lib/droneBoatTrigger.js')

let fails = 0
let n = 0
function check(name, ok) {
  n++
  if (!ok) fails++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeBoat({ armed = true, mode = 'MANUAL', motorOn = true, alertOn = true, connected = true } = {}) {
  const calls = []
  const boat = {
    armed, mode, motorOn, alertOn, connected, calls,
    api: {
      opsStatus: async () => ({
        success: true,
        pixhawk: { connected: boat.connected, armed: boat.armed, mode: boat.mode },
        auto: { settings: { motor_on_signal: boat.motorOn, alert_on_signal: boat.alertOn } },
      }),
      opsMotor: async (a) => { calls.push(['motor', a]); return { success: true, message: 'MOTOR ON' } },
      opsAlert: async (a) => { calls.push(['alert', a]); return { success: true, message: 'ALERT' } },
    },
  }
  return boat
}
const count = (b, k) => b.calls.filter((c) => c[0] === k).length

// 1. Readiness parsing
check('readiness: armed MANUAL', boatReadiness({ success: true, pixhawk: { connected: true, armed: true, mode: 'MANUAL' } })?.armedManual === true)
check('readiness: HOLD is not MANUAL', boatReadiness({ success: true, pixhawk: { connected: true, armed: true, mode: 'HOLD' } })?.armedManual === false)
check('readiness: disarmed', boatReadiness({ success: true, pixhawk: { connected: true, armed: false, mode: 'MANUAL' } })?.armedManual === false)
check('readiness: http error = unknown', boatReadiness({ _httpError: true }) === null)

// 2. One box, boat armed in MANUAL: buzzer at once, motor as soon as the status is in
{
  let t = 1000
  const b = fakeBoat()
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => true })
  const first = trig.pass(1)
  check('first box: buzzer sent at once (status not known yet)', first.alert === true)
  await tick()
  t += 150
  const second = trig.pass(1)
  check('next pass (150 ms): motor sent', second.motor === true)
  await tick()
  check('one alert + one motor call', count(b, 'alert') === 1 && count(b, 'motor') === 1)
  check('both use the test action', b.calls.every((c) => c[1] === 'test'))
  // Plastic stays in view: no flood, but resent every RESEND_MS
  for (let i = 0; i < 10; i++) { t += 150; trig.pass(1); await tick() }
  check('no resend inside RESEND_MS', count(b, 'motor') === 1 && count(b, 'alert') === 1)
  t += RESEND_MS
  trig.pass(2)
  await tick()
  check('resent after RESEND_MS (keeps the boat going)', count(b, 'motor') === 2 && count(b, 'alert') === 2)
  // No boxes: nothing sent
  t += RESEND_MS * 2
  trig.pass(0)
  await tick()
  check('no box: nothing sent', count(b, 'motor') === 2 && count(b, 'alert') === 2)
  trig.stop()
}

// 3. Boat disarmed: buzzer yes, motor never (a drone box never arms the boat)
{
  let t = 1000
  const b = fakeBoat({ armed: false })
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => true })
  trig.pass(0)
  await tick()
  for (let i = 0; i < 5; i++) { t += RESEND_MS; trig.pass(1); await tick() }
  check('disarmed: buzzer sounds', count(b, 'alert') >= 1)
  check('disarmed: motor never sent', count(b, 'motor') === 0)
  trig.stop()
}

// 4. Boat in HOLD (SwD not MANUAL): no motor
{
  let t = 1000
  const b = fakeBoat({ mode: 'HOLD' })
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => true })
  trig.pass(0)
  await tick()
  trig.pass(1)
  await tick()
  check('HOLD: motor not sent', count(b, 'motor') === 0)
  trig.stop()
}

// 5. Boat's own switches decide
{
  let t = 1000
  const b = fakeBoat({ motorOn: false, alertOn: false })
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => true })
  trig.pass(0)
  await tick()
  trig.pass(1)
  await tick()
  check('Auto motor OFF / Visual alert OFF on the boat: nothing sent', b.calls.length === 0)
  trig.stop()
}

// 6. This app's switch off
{
  let t = 1000
  const b = fakeBoat()
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => false })
  trig.pass(0)
  await tick()
  trig.pass(1)
  await tick()
  check('app switch off: nothing sent', b.calls.length === 0)
  trig.stop()
}

// 7. Status goes stale (boat unreachable): no motor on old news
{
  let t = 1000
  const b = fakeBoat()
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => true })
  trig.pass(0)
  await tick()
  b.api.opsStatus = async () => { throw new Error('down') }
  t += 6000
  trig.pass(1)
  await tick()
  check('stale status: motor not sent', count(b, 'motor') === 0)
  trig.stop()
}

// 8. A refused motor call is retried on the next box, not after RESEND_MS
{
  let t = 1000
  const b = fakeBoat()
  let refuse = true
  b.api.opsMotor = async () => { b.calls.push(['motor', 'test']); return refuse ? { success: false, message: 'no' } : { success: true } }
  const trig = createDroneBoatTrigger({ api: b.api, clock: () => t, enabled: () => true })
  trig.pass(0)
  await tick()
  trig.pass(1)
  await tick()
  refuse = false
  t += 150
  trig.pass(1)
  await tick()
  check('refused motor retried on the next pass', count(b, 'motor') === 2)
  trig.stop()
}

console.log(`\n${n - fails}/${n} passed`)
process.exit(fails ? 1 : 0)
