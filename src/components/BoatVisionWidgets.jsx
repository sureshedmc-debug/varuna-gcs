import { useBoatVision } from './BoatVisionContext'
import { GREEN } from './BoatParts'

const AMBER = '#FF9F0A'
const RED = '#FF453A'
const CARD = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }

function ntuColor(ntu) {
  const n = Number(ntu)
  if (!Number.isFinite(n)) return 'var(--muted)'
  return n < 10 ? GREEN : n < 50 ? '#B5E61D' : n < 150 ? AMBER : RED
}

function Widget({ label, value, sub, color, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-xl px-3 py-2 text-left transition-all hover:brightness-125 active:scale-[0.98]" style={CARD}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-[15px] font-bold tnum text-ink" style={color ? { color } : undefined}>{value}</div>
      <div className="truncate text-[10px] text-muted">{sub}</div>
    </button>
  )
}

/**
 * Four tiles for the boat's camera and water features (Boat tab, Home).
 * Each opens its full tab.
 */
export function BoatVisionWidgets({ onNavigate, title = 'Camera & water' }) {
  const bv = useBoatVision()
  if (!bv?.online) return null
  const v = bv.vision
  const w = bv.water
  const today = v?.catch?.today?.total ?? 0
  const bin = v?.catch?.bin
  const binPct = Math.min(100, bin?.pct || 0)
  const hm = v?.homing
  const wl = v?.wildlife
  const wlPaused = wl?.state && wl.state !== 'clear'
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="eyebrow">{title}</span>
        <span className="text-[10px] font-bold" style={{ color: v?.link?.alive ? GREEN : bv.cameraUp ? AMBER : 'var(--muted)' }}>
          {!bv.cameraUp ? 'NO CAMERA' : v?.link?.alive ? 'AI LINKED' : bv.enabled ? 'AI STARTING' : 'AI OFF'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Widget label="Catch today" value={`${today} items`} sub={bin ? `Bin ${binPct}% full` : 'Catch counter'}
          color={binPct >= 90 ? AMBER : undefined} onClick={() => onNavigate?.('vision')} />
        <Widget label="Homing" value={hm ? `${hm.collected}/${hm.attempts}` : '—'}
          sub={hm?.state && hm.state !== 'idle' ? `Item ${hm.item ?? ''} · ${hm.distance_m ?? '—'} m` : 'collected / tried'}
          color={hm?.state && hm.state !== 'idle' ? '#3B9EFF' : undefined} onClick={() => onNavigate?.('vision')} />
        <Widget label="Wildlife" value={wlPaused ? 'PAUSED' : 'Clear'}
          sub={wlPaused ? `${wl.label} ahead` : `${wl?.pauses_today ?? 0} pause(s) today`}
          color={wlPaused ? (wl.state === 'alert' ? RED : AMBER) : GREEN} onClick={() => onNavigate?.('vision')} />
        <Widget label="Water" value={w?.ntu != null ? `${w.ntu} NTU` : '—'} sub={w?.connected ? w.quality : 'No turbidity sensor'}
          color={ntuColor(w?.ntu)} onClick={() => onNavigate?.('water')} />
      </div>
    </div>
  )
}
