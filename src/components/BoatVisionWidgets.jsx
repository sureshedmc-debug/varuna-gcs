import { useBoatVision } from './BoatVisionContext'
import { GREEN } from './BoatParts'

const AMBER = '#FF9F0A'
const CARD = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }

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
 * Tiles for the boat's camera features.
 * Each opens its full tab.
 */
export function BoatVisionWidgets({ onNavigate, title = 'Boat camera' }) {
  const bv = useBoatVision()
  if (!bv?.online) return null
  const v = bv.vision
  const today = v?.catch?.today?.total ?? 0
  const bin = v?.catch?.bin
  const binPct = Math.min(100, bin?.pct || 0)
  const hm = v?.homing
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
      </div>
    </div>
  )
}
