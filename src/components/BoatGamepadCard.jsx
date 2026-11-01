import { useEffect, useState } from 'react'
import { boatApi } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { useBoatDrive } from './BoatDriveContext'
import { isOk } from '../lib/commands'

const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const RED = '#FF453A'

const LEGEND = [
  ['A', 'MANUAL — drive', GREEN], ['B', 'HOLD — stop', RED],
  ['X', 'Resume mission', '#0A84FF'], ['Y', 'Return home', '#FFD60A'],
  ['START', 'hold 1 s: arm', '#AEB3BA'], ['BACK', 'hold 1 s: disarm', '#AEB3BA'],
  ['R1', 'Roller run / stop', '#32D74B'], ['MODE', 'Next mode', '#BF5AF2'],
  ['L1 + R1', 'BRAKE: stop + disarm', RED],
]

function Bar({ label, value, vertical }) {
  // value −1…1, drawn from the centre.
  const pct = Math.round(Math.abs(value) * 50)
  const fill = value >= 0 ? { [vertical ? 'bottom' : 'left']: '50%' } : { [vertical ? 'top' : 'right']: '50%' }
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative overflow-hidden rounded-md" style={vertical ? { width: 14, height: 64, background: 'rgba(255,255,255,0.07)' } : { width: 96, height: 14, background: 'rgba(255,255,255,0.07)' }}>
        <div className="absolute" style={{ ...(vertical ? { left: 0, right: 0, height: `${pct}%` } : { top: 0, bottom: 0, width: `${pct}%` }), ...fill, background: Math.abs(value) > 0.01 ? GREEN : 'transparent' }} />
        <div className="absolute" style={vertical ? { left: 0, right: 0, top: '50%', height: 1, background: 'rgba(255,255,255,0.35)' } : { top: 0, bottom: 0, left: '50%', width: 1, background: 'rgba(255,255,255,0.35)' }} />
      </div>
      <span className="text-[9.5px] uppercase tracking-wider text-muted">{label}</span>
    </div>
  )
}

/** Boat tab: drive the boat with a game controller on this PC (no RC transmitter). */
export function BoatGamepadCard() {
  const boat = useBoat()
  const d = useBoatDrive()
  const t = boat.telemetry.data
  const mode = t?.flight_mode
  const [fs, setFs] = useState(null)
  const [fixing, setFixing] = useState(false)
  const [limit, setLimit] = useState(null)
  const gamepadBoat = d?.source === 'gamepad'

  useEffect(() => {
    if (!gamepadBoat || !boat.fcConnected) return
    let gone = false
    boatApi.failsafe().then((r) => { if (!gone) setFs(r && !r._httpError ? r : null) }).catch(() => {})
    return () => { gone = true }
  }, [gamepadBoat, boat.fcConnected])

  if (!d || !t) return null
  const maxThr = limit ?? d.boatDrive?.max_throttle ?? 0.6

  async function fix() {
    setFixing(true)
    try {
      const r = await boatApi.fixFailsafe()
      if (isOk(r) && r.report) setFs(r.report)
    } finally {
      setFixing(false)
    }
  }

  async function saveLimit(v) {
    setLimit(v)
    await boatApi.setVisionConfig({ gamepad_max_throttle: v }).catch(() => {})
  }

  let chip = { text: 'TRANSMITTER', color: '#98A0AB' }
  if (gamepadBoat) {
    if (!d.supported) chip = { text: 'NOT SUPPORTED', color: RED }
    else if (!d.enabled) chip = { text: 'OFF', color: '#98A0AB' }
    else if (!d.pad) chip = { text: 'NO CONTROLLER', color: AMBER }
    else if (!d.focused) chip = { text: 'PAUSED', color: AMBER }
    else if (d.linked) chip = { text: 'LINKED', color: GREEN }
    else chip = { text: 'CONNECTING', color: AMBER }
  }

  return (
    <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" /><path d="M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.9 6.31A2.5 2.5 0 0 0 6.2 16.9L8 15h8l1.8 1.9a2.5 2.5 0 0 0 4.36-2.16l-.9-6.31A4 4 0 0 0 17.3 5z" />
          </svg>
          Game controller
        </span>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${chip.color}22`, color: chip.color }}>{chip.text}</span>
      </div>

      {!gamepadBoat ? (
        <div className="text-[11px] text-muted">
          The boat is set up for an RC transmitter. To drive it with a game controller on this PC instead, run the
          Boat Pi Tool → <b className="text-ink">13. Driving by hand</b>.
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="truncate text-muted">{d.pad ? `${d.pad}${d.standard ? '' : ' (unusual layout — check the sticks)'}` : 'Plug the controller into this PC and press any button.'}</span>
            <label className="ml-2 flex shrink-0 items-center gap-1.5 text-muted">
              <input type="checkbox" className="accent-accent" checked={d.enabled} onChange={(e) => d.setEnabled(e.target.checked)} /> Use
            </label>
          </div>

          {d.pad && d.enabled && (
            <>
              <div className="mb-2 flex items-center justify-around">
                <Bar label="Throttle" value={d.t} vertical />
                <Bar label="Steering" value={d.s} />
              </div>
              {!d.focused && <div className="mb-2 text-[11px] text-warn">Click this window to drive: the controller is ignored while another window is in front, and the boat centres its sticks.</div>}
              {d.focused && mode !== 'MANUAL' && mode !== 'ACRO' && (
                <div className="mb-2 text-[11px] text-muted">Mode is {mode || '—'}: the sticks only drive in <b className="text-ink">MANUAL</b> or <b className="text-ink">ACRO</b> — press <b className="text-ink">A</b> for MANUAL.</div>
              )}
            </>
          )}

          <div className="mb-2">
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="text-muted">Throttle limit</span>
              <span className="font-mono font-semibold tnum text-ink">{Math.round(maxThr * 100)}%</span>
            </div>
            <input type="range" min={10} max={100} step={5} value={Math.round(maxThr * 100)} className="w-full accent-accent"
              onChange={(e) => setLimit(Number(e.target.value) / 100)} onMouseUp={(e) => saveLimit(Number(e.target.value) / 100)}
              onTouchEnd={(e) => saveLimit(Number(e.target.value) / 100)} onKeyUp={(e) => saveLimit(Number(e.target.value) / 100)} />
          </div>

          {t.collector && (
            <div className="mb-2 flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <span className="text-muted">
                Intake roller{t.collector.relay_gpio ? ` · relay GPIO${t.collector.relay_gpio}` : t.collector.output ? ` · out ${t.collector.output}` : ' · no output set'}:{' '}
                <b style={{ color: t.collector.on ? GREEN : undefined }} className={t.collector.on ? '' : 'text-ink'}>{t.collector.on ? 'RUNNING' : 'stopped'}</b>
              </span>
              <button type="button" disabled={!boat.fcConnected} onClick={() => boatApi.collector().catch(() => {})}
                className="font-semibold text-accent disabled:opacity-50">{t.collector.on ? 'Stop' : 'Run'}</button>
            </div>
          )}

          <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {LEGEND.map(([k, label, color]) => (
              <div key={k} className="flex items-center gap-1.5 text-[10.5px] text-muted">
                <span className="rounded px-1 font-mono text-[9.5px] font-bold" style={{ background: `${color}22`, color }}>{k}</span>{label}
              </div>
            ))}
          </div>
          <div className="text-[10.5px] text-faint">Left stick: throttle · right stick: steering. Controller lost for 3 s while driving → the boat holds.</div>

          {d.last && Date.now() - d.last.t < 15000 && (
            <div className="mt-1.5 text-[11px]" style={{ color: d.last.ok ? GREEN : AMBER }}>{d.last.text}</div>
          )}

          {fs && (
            <div className="mt-2 rounded-lg px-2.5 py-2 text-[11px]" style={{ background: fs.ok ? 'rgba(50,215,75,0.08)' : 'rgba(255,159,10,0.1)', border: `1px solid ${fs.ok ? 'rgba(50,215,75,0.25)' : 'rgba(255,159,10,0.35)'}` }}>
              {fs.ok ? (
                <span className="text-muted">If the boat Pi stops, the Pixhawk&apos;s failsafe will: <b className="text-ink">{fs.action}</b></span>
              ) : (
                <>
                  <div className="font-semibold text-warn">Pixhawk failsafe needs attention</div>
                  {(fs.problems || []).map((p) => <div key={p} className="text-muted">{p}</div>)}
                  <button type="button" disabled={fixing} onClick={fix} className="mt-1 font-semibold text-accent">{fixing ? 'Fixing…' : 'Fix it (failsafe on, action HOLD)'}</button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
