import { useEffect, useState } from 'react'
import { boatApi } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { isOk } from '../lib/commands'

const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const RED = '#FF453A'
const STEP = 10
const MIN_PWM = 900
const MAX_PWM = 1500

/**
 * Boat tab: match the two thrusters. Spin one motor for 2 s at an exact signal
 * (the Pixhawk stops it itself), raise the signal until it just starts, save:
 * that motor's stopped point goes just below its start, so both motors start
 * together from the first bit of throttle — no dead band, no surge.
 */
export function BoatMotorMatchCard() {
  const boat = useBoat()
  const t = boat.telemetry.data
  const [open, setOpen] = useState(false)
  const [motor, setMotor] = useState('left')
  const [pwm, setPwm] = useState({ left: 1050, right: 1050 })
  const [motors, setMotors] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const canCommand = boat.reachable === true && boat.fcConnected
  const armed = t?.armed === true

  useEffect(() => {
    if (!open || !canCommand) return
    let gone = false
    boatApi.motors().then((r) => { if (!gone && r?.motors) setMotors(r.motors) }).catch(() => {})
    return () => { gone = true }
  }, [open, canCommand])

  if (!t) return null
  const value = pwm[motor]
  const setValue = (v) => setPwm((p) => ({ ...p, [motor]: Math.max(MIN_PWM, Math.min(MAX_PWM, v)) }))

  async function act(key, fn, after) {
    setBusy(key)
    setMsg(null)
    try {
      const r = await fn()
      setMsg({ ok: isOk(r), text: r?.message || (isOk(r) ? 'Done' : 'Failed') })
      if (isOk(r) && after) await after()
    } catch (e) {
      setMsg({ ok: false, text: String(e?.message || e) })
    } finally {
      setBusy(null)
    }
  }

  const spin = () => act('spin', () => boatApi.motorTest(motor, value, 2))
  const save = () => act('save', () => boatApi.motorStart(motor, value),
    async () => { const r = await boatApi.motors(); if (r?.motors) setMotors(r.motors) })

  return (
    <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <button type="button" className="flex w-full items-center justify-between gap-2" onClick={() => setOpen((o) => !o)}>
        <span className="text-[13px] font-bold text-ink">Motor matching</span>
        <span className="text-[11px] font-semibold text-muted">{open ? 'Hide ▴' : 'Show ▾'}</span>
      </button>

      {open && (
        <div className="mt-2">
          <div className="mb-2 rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.3)' }}>
            <b style={{ color: RED }}>Propellers off</b><span className="text-muted"> (or hold the boat out of the water). Battery connected, boat disarmed. Each spin stops by itself after 2 s.</span>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-1.5">
            {['left', 'right'].map((m) => (
              <button key={m} type="button" onClick={() => setMotor(m)}
                className={`rounded-lg py-1.5 text-[11px] font-bold ${motor === m ? '' : 'text-ink'}`}
                style={motor === m ? { background: `${GREEN}26`, color: GREEN, border: `1px solid ${GREEN}66` }
                  : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {m === 'left' ? 'Left' : 'Right'} motor
                {motors?.[m] && <span className="ml-1 font-mono text-[9.5px] font-semibold text-muted">out {motors[m].output}</span>}
              </button>
            ))}
          </div>

          <div className="mb-2 flex items-center justify-between gap-2">
            <button type="button" disabled={!!busy} onClick={() => setValue(value - STEP)}
              className="h-8 w-10 rounded-lg text-[13px] font-bold text-ink" style={{ background: 'rgba(255,255,255,0.07)' }}>−</button>
            <div className="text-center">
              <div className="font-mono text-[18px] font-bold tnum text-ink">{value}<span className="ml-0.5 text-[10px] font-normal text-muted">µs</span></div>
              <div className="text-[10px] text-muted">signal for the test spin</div>
            </div>
            <button type="button" disabled={!!busy} onClick={() => setValue(value + STEP)}
              className="h-8 w-10 rounded-lg text-[13px] font-bold text-ink" style={{ background: 'rgba(255,255,255,0.07)' }}>+</button>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <button type="button" disabled={!canCommand || armed || !!busy} onClick={spin}
              className="rounded-lg py-2 text-[11px] font-bold disabled:opacity-50"
              style={{ background: `${AMBER}22`, color: AMBER, border: `1px solid ${AMBER}55` }}>
              {busy === 'spin' ? 'Spinning…' : 'Spin 2 s'}
            </button>
            <button type="button" disabled={!canCommand || armed || !!busy} onClick={save}
              className="rounded-lg py-2 text-[11px] font-bold disabled:opacity-50"
              style={{ background: `${GREEN}22`, color: GREEN, border: `1px solid ${GREEN}55` }}>
              {busy === 'save' ? 'Saving…' : 'Starts here — save'}
            </button>
          </div>

          {armed && <div className="mb-1 text-[11px] text-warn">Disarm the boat to test the motors.</div>}
          {msg && <div className="mb-1 text-[11px]" style={{ color: msg.ok ? GREEN : AMBER }}>{msg.text}</div>}

          {motors && (
            <div className="mb-1 grid grid-cols-2 gap-1.5 text-[10.5px]">
              {['left', 'right'].map((m) => (
                <div key={m} className="rounded-lg px-2 py-1" style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <span className="text-muted">{m === 'left' ? 'Left' : 'Right'} stopped at </span>
                  <span className="font-mono font-semibold tnum text-ink">{motors[m]?.stop ?? '—'}</span>
                </div>
              ))}
            </div>
          )}

          <div className="text-[10.5px] text-muted">
            Raise the signal 10 µs at a time and press Spin each time, until the motor just turns. Then press save, and do the other motor.
          </div>
        </div>
      )}
    </div>
  )
}
