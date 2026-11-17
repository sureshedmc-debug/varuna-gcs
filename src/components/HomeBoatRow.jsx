import { useBoatVision } from './BoatVisionContext'

// The boat's camera features as Home KPI cards (homeNew.css styles).
// Shown only while the boat is online.

const ICON = {
  catch: <path d="M4 8h16l-1.5 11a2 2 0 01-2 1.7h-9a2 2 0 01-2-1.7zM9 8V6a3 3 0 016 0v2" />,
  bin: <path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14" />,
}

function Card({ icon, tone, label, value, delta, deltaClass = 'neu', onClick }) {
  return (
    <button type="button" className="vh-kpi-card" onClick={onClick} style={{ cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
      <div className={`vh-kpi-icon ${tone}`}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICON[icon]}</svg>
      </div>
      <div className="vh-kpi-right">
        <div className="vh-kpi-label">{label}</div>
        <div className="vh-kpi-value" style={{ fontSize: 28 }}>{value}</div>
        <div className={`vh-kpi-delta ${deltaClass}`}>{delta}</div>
      </div>
    </button>
  )
}

export default function HomeBoatRow({ onNavigate }) {
  const bv = useBoatVision()
  if (!bv?.online) return null
  const v = bv.vision
  const today = v?.catch?.today?.total ?? 0
  const bin = v?.catch?.bin
  const pct = Math.min(100, bin?.pct || 0)
  return (
    <div className="vh-kpi-row vh-animate vh-animate-3">
      <Card icon="catch" tone="teal" label="Boat · collected today" value={today}
        delta={v?.homing ? `${v.homing.collected} by camera homing` : 'Catch counter'} deltaClass="up"
        onClick={() => onNavigate?.('vision')} />
      <Card icon="bin" tone="blue" label="Boat bin" value={`${pct}%`}
        delta={bin ? `${bin.count} of ${bin.capacity} items` : '—'} deltaClass={pct >= 90 ? 'down' : 'neu'}
        onClick={() => onNavigate?.('vision')} />
    </div>
  )
}
