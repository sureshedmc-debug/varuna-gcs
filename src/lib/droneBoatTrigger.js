// Drone box -> boat, instantly. The moment the drone's AI draws ONE plastic box,
// the boat's motor runs and its buzzer + LED strip pulse. Nothing else is
// waited for: no GPS fix on the drone, no sighting in the trash log, no live
// collect running, no match with the boat's camera, no detection on the boat.
//
// How: the boat's own Ops endpoints (boat-pi/boat_extras.py), the same ones the
// Boat Ops "Test" buttons use:
//   POST /api/ops/alert {action:'test'}  -> buzzer + LED strip for alert_duration_s
//   POST /api/ops/motor {action:'test'}  -> motor at motor_power_pct for motor_run_s
// Each call restarts that time, so while the drone keeps seeing plastic they
// are sent again every RESEND_MS and the boat keeps going; when it stops seeing
// plastic, the boat's own timers end the run.
//
// Safety, kept from the boat's rules even though the boat's "test" action could
// arm it: the motor is sent ONLY while the boat reports itself ARMED in MANUAL
// (the operator's SwD). A drone box never arms the boat or changes its mode.
// The boat's Ops switches still decide: "Auto motor" OFF = no motor, "Visual
// alert" OFF = no buzzer. STOP / flipping SwD / disarming stop it as before.
// This app's own switch: localStorage 'varuna.droneBoatTrigger' = '0' turns it off.

import { boatApi } from '../api/boatClient'

const KEY = 'varuna.droneBoatTrigger'
export const RESEND_MS = 3000        // < motor_run_s (10) and alert_duration_s (8): no gap while plastic stays in view
export const STATUS_EVERY_MS = 1500  // how fresh the boat's armed / mode / switches are
export const STATUS_MAX_AGE_MS = 5000
const IDLE_MS = 10000                // no drone passes for this long: stop asking the boat
const RUN_MODES = new Set(['MANUAL', 'LEARNING', 'STEERING'])

export function getDroneBoatTrigger() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}
export function setDroneBoatTrigger(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
}

/** What the boat's Ops status says about running the motor / alert now. */
export function boatReadiness(st) {
  if (!st || st.success === false || st._httpError) return null
  const px = st.pixhawk || {}
  const s = st.auto?.settings || {}
  return {
    armedManual: !!px.connected && !!px.armed && RUN_MODES.has(String(px.mode || '')),
    motorOn: s.motor_on_signal !== false,
    alertOn: s.alert_on_signal !== false,
    mode: px.mode || null,
    armed: !!px.armed,
  }
}

/**
 * The trigger itself. `api` and `clock` are injectable for the test
 * (scripts/test-drone-boat-trigger.mjs); the app uses the default instance.
 */
export function createDroneBoatTrigger({ api = boatApi, clock = () => Date.now(), enabled = getDroneBoatTrigger, log = () => {} } = {}) {
  let ready = null          // boatReadiness() of the last status
  let readyAt = 0
  let statusBusy = false
  let lastPass = 0
  let timer = null
  let alertAt = -Infinity
  let motorAt = -Infinity
  let alertBusy = false
  let motorBusy = false
  const last = { alert: null, motor: null }

  async function refresh() {
    if (statusBusy) return
    statusBusy = true
    try {
      const st = await api.opsStatus()
      const r = boatReadiness(st)
      if (r) {
        ready = r
        readyAt = clock()
      }
    } catch {
      /* boat not reachable: the next poll retries */
    } finally {
      statusBusy = false
    }
  }

  function keepPolling() {
    if (timer) return
    refresh()
    timer = setInterval(() => {
      if (clock() - lastPass > IDLE_MS) {
        clearInterval(timer)
        timer = null
        return
      }
      refresh()
    }, STATUS_EVERY_MS)
  }

  function fresh() {
    return ready && clock() - readyAt <= STATUS_MAX_AGE_MS ? ready : null
  }

  function send(kind) {
    const isMotor = kind === 'motor'
    if (isMotor ? motorBusy : alertBusy) return
    if (isMotor) { motorBusy = true; motorAt = clock() } else { alertBusy = true; alertAt = clock() }
    const call = isMotor ? api.opsMotor('test') : api.opsAlert('test')
    Promise.resolve(call)
      .then((res) => {
        last[kind] = { t: clock(), ok: !!(res && res.success), message: res?.message || null }
        log(kind, last[kind])
        if (isMotor && res && res.success === false) motorAt = -Infinity // refused: try again on the next box
      })
      .catch(() => {
        last[kind] = { t: clock(), ok: false, message: 'boat not reachable' }
        if (isMotor) motorAt = -Infinity
        else alertAt = -Infinity
      })
      .finally(() => {
        if (isMotor) motorBusy = false
        else alertBusy = false
      })
  }

  /**
   * Called on every drone detection pass with how many plastic boxes it shows.
   * Returns what it did ({alert, motor} booleans), for the test.
   */
  function pass(boxes) {
    const now = clock()
    lastPass = now
    if (!enabled()) return { alert: false, motor: false }
    keepPolling()
    if (!(boxes > 0)) return { alert: false, motor: false }
    const r = fresh()
    let a = false
    let m = false
    // Buzzer first: harmless, so it goes even before the boat's status is known.
    if ((!r || r.alertOn) && now - alertAt >= RESEND_MS) { send('alert'); a = true }
    if (r && r.motorOn && r.armedManual && now - motorAt >= RESEND_MS) { send('motor'); m = true }
    return { alert: a, motor: m }
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { pass, stop, refresh, status: () => ({ ready: fresh(), last: { ...last } }) }
}

let shared = null
/** The app's one trigger (WebcamDetect calls this on every drone pass). */
export function droneBoatPass(boxes) {
  if (!shared) shared = createDroneBoatTrigger()
  return shared.pass(boxes)
}
