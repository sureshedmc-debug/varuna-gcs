import { useEffect, useState } from 'react'
import { boatApi } from '../api/boatClient'
import { useBoat } from './BoatContext'
import { useToast } from './Toast'
import { isOk } from '../lib/commands'
import { getAutoSend, liveCandidates, setAutoSend } from '../lib/liveCollectFeed'
import { useCollected } from '../lib/boatStore'
import { useTrashLog } from '../lib/trashLog'
import { relTime } from '../lib/format'

const GREEN = '#32D74B'
const AMBER = '#FF9F0A'
const BLUE = '#0A84FF'
const GOLD = '#F5B400'

export const LIVE_STATE = {
  off: { label: 'Off', color: '#98A0AB' },
  running: { label: 'Collecting', color: GREEN },
  paused: { label: 'Paused', color: AMBER },
  returning: { label: 'Returning home', color: GOLD },
}
const PHASE_TEXT = {
  waiting: 'Nothing left — waiting for the drone to find more',
  approach: 'Heading to item',
  camera: 'Camera homing onto item',
  through: 'Driving through item',
  dwell: 'Waiting for the ramp',
}

/**
 * Boat tab: live collect — the boat goes after the drone's plastic finds as
 * they come in, with no planned mission. The boat Pi drives (GUIDED, nearest
 * item first, intake roller near each item); the app only feeds it the finds.
 */
export function BoatLiveCollectCard() {
  const boat = useBoat()
  const toast = useToast()
  const log = useTrashLog()
  const collected = useCollected()
  const live = boat.live
  const [busy, setBusy] = useState(null)
  const [whenEmpty, setWhenEmpty] = useState(() => live?.when_empty || 'wait')
  const [autoSend, setAuto] = useState(getAutoSend)
  useEffect(() => {
    const on = () => setAuto(getAutoSend())
    window.addEventListener('varuna:liveCollect-autoSend', on)
    return () => window.removeEventListener('varuna:liveCollect-autoSend', on)
  }, [])

  const t = boat.telemetry.data
  if (!t || !live) return null
  const canCommand = boat.reachable === true && boat.fcConnected
  const st = LIVE_STATE[live.state] || LIVE_STATE.off
  const active = live.state === 'running' || live.state === 'returning'
  const c = live.counts || {}
  const waiting = (c.pending || 0) + (c.active || 0)
  const gpsOk = (Number(t.gps_fix) || 0) >= 3
  const finds = liveCandidates(log, collected, live.started_at ? live.started_at * 1000 : null).length

  async function run(key, fn, okMsg) {
    setBusy(key)
    try {
      const res = await fn()
      toast.fromResult(isOk(res) ? res : { ...res, success: false, message: res?.message || (res?._httpError ? `HTTP ${res._httpError}` : 'Failed') }, okMsg)
    } catch (e) {
      toast.push({ level: 'bad', title: `Live collect: ${e?.message || e}` })
    } finally {
      setBusy(null)
    }
  }

  const cur = live.current
  return (
    <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
          Live collect
        </span>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${st.color}22`, color: st.color }}>{st.label.toUpperCase()}</span>
      </div>

      <div className="mb-2 grid grid-cols-3 gap-1.5 text-center">
        {[['Waiting', waiting, BLUE], ['Collected', c.collected || 0, GREEN], ['Missed', c.missed || 0, AMBER]].map(([k, v, col]) => (
          <div key={k} className="rounded-lg py-1" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="font-mono text-[15px] font-bold tnum" style={{ color: col }}>{v}</div>
            <div className="text-[9.5px] uppercase tracking-wider text-muted">{k}</div>
          </div>
        ))}
      </div>

      {active && (
        <div className="mb-2 text-[11px] text-muted">
          {live.state === 'returning' ? 'Nothing new — driving back home.' : (
            <>
              {PHASE_TEXT[live.phase] || 'Starting…'}
              {cur && <b className="text-ink"> {cur.number}{Number.isFinite(cur.distance_m) ? ` · ${Math.round(cur.distance_m)} m` : ''}</b>}
              {' · roller '}<b style={{ color: live.roller ? GREEN : undefined }} className={live.roller ? '' : 'text-ink'}>{live.roller ? 'ON' : 'off'}</b>
            </>
          )}
        </div>
      )}
      {live.state === 'paused' && live.reason && <div className="mb-2 text-[11px] text-warn">Paused — {live.reason}. Press Resume to carry on.</div>}

      {!active && (
        <>
          <div className="mb-1 text-[10.5px] uppercase tracking-wider text-muted">When nothing is left</div>
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            {[['wait', 'Wait here'], ['return', 'Return home']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setWhenEmpty(k)}
                className={`rounded-lg py-1.5 text-[11px] font-bold ${whenEmpty === k ? '' : 'text-ink'}`}
                style={whenEmpty === k ? { background: `${GREEN}26`, color: GREEN, border: `1px solid ${GREEN}66` }
                  : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>{label}</button>
            ))}
          </div>
        </>
      )}

      <label className="mb-2 flex items-center gap-1.5 text-[11px] text-muted">
        <input type="checkbox" className="accent-accent" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
        Send the drone&apos;s finds to the boat automatically
        <span className="ml-auto font-mono text-[10.5px] tnum text-ink">{finds}</span>
      </label>

      <div className={`grid gap-1.5 ${active ? 'grid-cols-3' : 'grid-cols-1'}`}>
        {active ? (
          <>
            <button type="button" disabled={!canCommand || !!busy} onClick={() => run('pause', boatApi.livePause, 'Live collect paused')}
              className="rounded-lg py-2 text-[11px] font-bold disabled:opacity-50" style={{ background: `${AMBER}22`, color: AMBER, border: `1px solid ${AMBER}55` }}>
              {busy === 'pause' ? '…' : 'Pause'}
            </button>
            <button type="button" disabled={!canCommand || !!busy} onClick={() => run('stop', () => boatApi.liveStop(false), 'Live collect stopped')}
              className="rounded-lg py-2 text-[11px] font-bold text-ink disabled:opacity-50" style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)' }}>
              {busy === 'stop' ? '…' : 'Stop'}
            </button>
            <button type="button" disabled={!canCommand || !!busy} onClick={() => run('home', () => boatApi.liveStop(true), 'Returning home')}
              className="rounded-lg py-2 text-[11px] font-bold disabled:opacity-50" style={{ background: `${GOLD}22`, color: GOLD, border: `1px solid ${GOLD}55` }}>
              {busy === 'home' ? '…' : 'Stop & home'}
            </button>
          </>
        ) : (
          <button type="button" disabled={!canCommand || !!busy || !gpsOk}
            title={gpsOk ? undefined : 'Needs a 3D GPS fix on the boat'}
            onClick={() => run('start', () => boatApi.liveStart({ whenEmpty }), live.state === 'paused' ? 'Live collect resumed' : 'Live collect started')}
            className="rounded-lg py-2 text-[12px] font-bold disabled:opacity-50" style={{ background: `${GREEN}22`, color: GREEN, border: `1px solid ${GREEN}55` }}>
            {busy === 'start' ? 'Starting…' : live.state === 'paused' ? 'Resume live collect' : 'Start live collect'}
          </button>
        )}
      </div>

      {!active && !gpsOk && <div className="mt-1.5 text-[10.5px] text-warn">Needs a GPS fix on the boat (GUIDED mode).</div>}
      {!live.roller_output && <div className="mt-1.5 text-[10.5px] text-muted">No intake-roller output set yet (collector_servo): the roller isn&apos;t switched.</div>}

      {(live.events || []).length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5">
          {[...live.events].reverse().slice(0, 3).map((e, i) => (
            <div key={`${e.t}-${i}`} className="flex gap-2 text-[10.5px]">
              <span className="shrink-0 font-mono tnum text-muted">{relTime(e.t * 1000)}</span>
              <span className={e.level === 'warn' ? 'text-warn' : 'text-muted'}>{e.text}</span>
            </div>
          ))}
        </div>
      )}
      {!active && waiting === 0 && (c.collected || c.missed) ? (
        <button type="button" className="mt-1.5 text-[11px] font-semibold text-accent" disabled={!!busy}
          onClick={() => run('clear', boatApi.liveClear, 'Live collect list cleared')}>Clear the list</button>
      ) : null}
    </div>
  )
}
