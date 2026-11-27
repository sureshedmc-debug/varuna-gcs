// Shared pieces of the two boat tabs (Boat, Collect): map icons, mission
// state labels and the "boat not connected" card.
import L from 'leaflet'
import { Btn, StatusOrb } from './ui'

export const BLUE = '#3B9EFF'
export const GREEN = '#32D74B'

// ── Map icons (cached: Leaflet re-sets an icon whenever it gets a new object) ──
const iconCache = new Map()
function cachedIcon(key, make) {
  let ic = iconCache.get(key)
  if (!ic) { ic = make(); iconCache.set(key, ic) }
  return ic
}
export function boatIcon(heading) {
  const h = Math.round((Number(heading) || 0) / 5) * 5
  return cachedIcon(`boat:${h}`, () => L.divIcon({
    className: '',
    html: `<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(59,158,255,0.18);border:1px solid rgba(59,158,255,0.6);box-shadow:0 0 14px rgba(59,158,255,0.5)">
      <svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${h}deg)">
        <path d="M12 2.5c2.6 2.4 4 5.6 4 9.5v8.5H8V12c0-3.9 1.4-7.1 4-9.5z" fill="#3B9EFF" stroke="#0E1116" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M12 6.5v9" stroke="#0E1116" stroke-width="1.4" stroke-linecap="round"/>
      </svg></div>`,
    iconSize: [44, 44], iconAnchor: [22, 22],
  }))
}
export function itemIcon(label, state) {
  return cachedIcon(`item:${label}:${state}`, () => {
    const bg = state === 'done' ? `linear-gradient(180deg,#5BE37A,${GREEN})` : state === 'current' ? 'linear-gradient(180deg,#FFD15C,#F5B400)' : `linear-gradient(180deg,#6BB8FF,${BLUE})`
    const glow = state === 'done' ? GREEN : state === 'current' ? '#F5B400' : BLUE
    return L.divIcon({
      className: '',
      html: `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:#04121F;display:flex;align-items:center;justify-content:center;font:700 12px Inter;box-shadow:0 0 12px ${glow}aa;border:2px solid #0E1116">${state === 'done' ? '✓' : label}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    })
  })
}

export const MISSION_STATE = {
  none: { label: 'No mission', color: '#98A0AB' },
  uploaded: { label: 'Ready', color: BLUE },
  running: { label: 'Collecting', color: GREEN },
  paused: { label: 'Paused', color: '#FF9F0A' },
  returning: { label: 'Returning home', color: '#F5B400' },
  completed: { label: 'Completed', color: GREEN },
}

/** Shown in place of the live panel while the boat can't be reached. */
export function BoatOffline({ boat, onNavigate }) {
  const wrong = boat.wrongTarget
  const checking = boat.reachable === undefined
  return (
    <div className="rounded-xl p-3 text-[12px]" style={{ background: wrong ? 'rgba(255,159,10,0.08)' : 'rgba(255,69,58,0.08)', border: `1px solid ${wrong ? 'rgba(255,159,10,0.3)' : 'rgba(255,69,58,0.25)'}` }}>
      <div className="mb-1 flex items-center gap-2">
        <StatusOrb level={checking ? 'idle' : wrong ? 'warn' : 'bad'} size={11} pulse={!checking} />
        <span className="text-[13px] font-bold text-ink">
          {checking ? 'Looking for the boat…' : wrong ? 'That address is not the boat' : 'Boat not connected'}
        </span>
      </div>
      {!checking && (
        <>
          <div className="text-muted">
            {wrong
              ? "A VARUNA backend answered, but it isn't the boat's (it may be the drone's Pi). Boat commands stay locked."
              : boat.linkHint || 'No answer from the boat Pi.'}
          </div>
          <div className="mt-1.5 text-muted">
            Set the boat Pi's Netbird address in <span className="font-semibold text-ink">System → Boat connection</span>.
            To practise without hardware, run the boat simulator: <span className="font-mono text-ink">boat-pi › python main.py --sim --port 8001</span>
          </div>
          <div className="mt-2.5 flex gap-2">
            <Btn className="h-9 text-xs" onClick={() => onNavigate?.('system')}>Open System</Btn>
            <Btn className="h-9 text-xs" variant="secondary" onClick={() => boat.refreshPing?.()}>Retry</Btn>
          </div>
        </>
      )}
    </div>
  )
}

