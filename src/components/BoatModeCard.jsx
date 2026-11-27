import { useState } from 'react'
import { boatApi } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { useToast } from './Toast'
import { isOk } from '../lib/commands'

const GREEN = '#32D74B'
const AMBER = '#FF9F0A'

// ArduRover modes the boat uses. MANUAL, ACRO and HOLD work with no GPS and an
// uncalibrated compass; the rest need to know where the boat is (a 3D GPS fix).
const MODES = [
  { id: 'MANUAL', label: 'Manual', gps: false, hint: 'Drive with the game controller' },
  { id: 'ACRO', label: 'Acro', gps: false, hint: 'Controller, with the turn rate held by the gyro' },
  { id: 'HOLD', label: 'Hold', gps: false, hint: 'Stop: motors to neutral' },
  { id: 'LOITER', label: 'Loiter', gps: true, hint: 'Stay on this spot' },
  { id: 'GUIDED', label: 'Guided', gps: true, hint: 'Go to points the app sends (collection)' },
  { id: 'AUTO', label: 'Auto', gps: true, hint: 'Run the mission on the Pixhawk' },
  { id: 'RTL', label: 'RTL', gps: true, hint: 'Return to launch' },
  { id: 'SMART_RTL', label: 'SmartRTL', gps: true, hint: 'Return the way it came' },
]

/** Boat tab: switch the boat's flight mode from the app. */
export function BoatModeCard() {
  const boat = useBoat()
  const toast = useToast()
  const [busy, setBusy] = useState(null)
  const t = boat.telemetry.data
  if (!t) return null
  const current = t.flight_mode
  const gpsOk = (Number(t.gps_fix) || 0) >= 3
  const canCommand = boat.reachable === true && boat.fcConnected

  async function choose(m) {
    if (!canCommand || busy || m.id === current) return
    setBusy(m.id)
    try {
      const res = await boatApi.setMode(m.id)
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || 'Mode change failed' }, `Mode ${m.label}`)
    } catch (e) {
      toast.push({ level: 'bad', title: `Mode change failed: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold text-ink">Flight mode</span>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${GREEN}22`, color: GREEN }}>{current || '—'}</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {MODES.map((m) => {
          const active = m.id === current
          const blocked = m.gps && !gpsOk
          return (
            <button key={m.id} type="button" disabled={!canCommand || !!busy || blocked}
              title={blocked ? `${m.hint}. Needs a 3D GPS fix.` : m.hint}
              onClick={() => choose(m)}
              className={`whitespace-nowrap rounded-lg px-1 py-1.5 text-[11px] font-bold transition-colors disabled:cursor-not-allowed ${active ? '' : blocked ? 'text-faint' : 'text-ink'}`}
              style={active
                ? { background: `${GREEN}26`, color: GREEN, border: `1px solid ${GREEN}66` }
                : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', opacity: canCommand ? 1 : 0.5 }}>
              {busy === m.id ? '…' : m.label}
              {m.gps && <span className={`ml-0.5 align-top text-[8px] font-semibold ${blocked ? '' : 'text-muted'}`} style={blocked ? { color: AMBER } : undefined}>GPS</span>}
            </button>
          )
        })}
      </div>
      <div className="mt-2 text-[10.5px] text-muted">
        {gpsOk
          ? 'Manual, Acro and Hold need no GPS or compass. The game controller only drives in Manual or Acro.'
          : 'No GPS fix: Manual, Acro and Hold work; the GPS modes unlock with a 3D fix.'}
      </div>
    </div>
  )
}
