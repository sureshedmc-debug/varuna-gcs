import { useEffect, useState } from 'react'
import { boatApi } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { isOk } from '../lib/commands'

const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const GREY = '#98A0AB'
const BLUE = '#0A84FF'

/**
 * Boat tab: the two extra servos. Two-position, worked from the RC transmitter
 * (a switch on the servo's channel) or from here / the controller's D-pad.
 * With a transmitter, a servo the app moved stays with the app until it is
 * given back; with no transmitter the app always has them.
 */
export function BoatServoCard() {
  const boat = useBoat()
  const t = boat.telemetry.data
  const sv = t?.servos
  const [setup, setSetup] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (!sv || !boat.fcConnected) return undefined
    let gone = false
    boatApi.servosSetup().then((r) => { if (!gone) setSetup(r && !r._httpError && Array.isArray(r.servos) ? r : null) }).catch(() => {})
    return () => { gone = true }
  }, [!!sv, boat.fcConnected]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sv) return null
  const tx = sv.source === 'transmitter'

  async function run(key, fn) {
    setBusy(key)
    try {
      const r = await fn()
      setMsg({ text: r?.message || (isOk(r) ? 'Done.' : 'Failed.'), ok: isOk(r) })
      if (r?.report) setSetup(r.report)
    } catch (e) {
      setMsg({ text: String(e?.message || e), ok: false })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="12" r="3" /><path d="M11 12h9M17 9l3 3-3 3" />
          </svg>
          Servos
        </span>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${tx ? BLUE : GREEN}22`, color: tx ? BLUE : GREEN }}>
          {tx ? 'TRANSMITTER + APP' : 'APP'}
        </span>
      </div>

      {sv.servos.map((s) => {
        const on = s.on
        const color = on == null ? GREY : on ? GREEN : GREY
        return (
          <div key={s.index} className="mb-1.5 flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="min-w-0">
              <div className="truncate font-semibold text-ink">{s.name}</div>
              <div className="text-[10px] text-faint">out {s.output} · ch {s.channel}{s.us ? ` · ${s.us} µs` : ''}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <b style={{ color }}>{on == null ? '—' : on ? 'ON' : 'OFF'}</b>
              {tx && (
                <span className="rounded px-1 font-mono text-[9.5px] font-bold" style={{ background: `${s.by === 'app' ? AMBER : BLUE}22`, color: s.by === 'app' ? AMBER : BLUE }}>
                  {s.by === 'app' ? 'APP' : 'TX'}
                </span>
              )}
              <button type="button" disabled={!boat.fcConnected || busy != null}
                onClick={() => run(`s${s.index}`, () => boatApi.servo(s.index + 1, !on))}
                className="font-semibold text-accent disabled:opacity-50">{busy === `s${s.index}` ? '…' : on ? 'Turn off' : 'Turn on'}</button>
              {tx && s.by === 'app' && (
                <button type="button" disabled={busy != null} onClick={() => run(`r${s.index}`, () => boatApi.servoRelease(s.index + 1))}
                  className="font-semibold text-muted disabled:opacity-50">Give back</button>
              )}
            </div>
          </div>
        )
      })}

      <div className="text-[10.5px] text-faint">
        Controller: D-pad <b className="text-muted">←</b> {sv.servos[0]?.name} · <b className="text-muted">→</b> {sv.servos[1]?.name}
        {tx && <> · <b className="text-muted">↓</b> give both back</>}.
        {tx
          ? ` Transmitter: a switch on channel ${sv.servos.map((s) => s.channel).join(' / ')}. A servo moved here stays with the app until you give it back (or the app is closed).`
          : ' No transmitter: the boat Pi holds them where you put them.'}
      </div>

      {msg && <div className="mt-1.5 text-[11px]" style={{ color: msg.ok ? GREEN : AMBER }}>{msg.text}</div>}

      {setup && !setup.ok && (
        <div className="mt-2 rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'rgba(255,159,10,0.1)', border: '1px solid rgba(255,159,10,0.35)' }}>
          <div className="font-semibold text-warn">Pixhawk outputs not set up for the servos</div>
          {(setup.problems || []).map((p) => <div key={p} className="text-muted">{p}</div>)}
          {setup.servos?.some((r) => r.fixable) && (
            <button type="button" disabled={busy != null || t.armed} onClick={() => run('setup', boatApi.fixServosSetup)}
              className="mt-1 font-semibold text-accent disabled:opacity-50">
              {busy === 'setup' ? 'Setting…' : t.armed ? 'Disarm to set up' : 'Set up the outputs'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
