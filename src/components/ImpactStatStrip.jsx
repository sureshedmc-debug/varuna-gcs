// A compact row of "impact so far" tiles. Reads impactStats live so any
// screen that renders it stays in sync with the running totals.

import { useImpactStats, resetImpactStats } from '../lib/impactStats'
import { openCertificatePrintView, buildCertificateHtml } from '../lib/certificate'

function fmtHours(sec) {
  const h = sec / 3600
  if (h >= 1) return `${h.toFixed(1)} h`
  return `${Math.round(sec / 60)} min`
}
function fmtArea(m2) {
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} ha`
  return `${Math.round(m2)} m²`
}

function Tile({ label, value, sub }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-chip px-3 py-2 text-center">
      <div className="font-mono text-lg font-bold tnum text-accent">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      {sub && <div className="text-[9px] text-faint">{sub}</div>}
    </div>
  )
}

export default function ImpactStatStrip({ compact = false, showActions = true }) {
  const s = useImpactStats()
  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2' : 'space-y-2'}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Items found" value={s.itemsFound} />
        <Tile label="Area covered" value={fmtArea(s.areaCoveredM2)} />
        <Tile label="Flight time" value={fmtHours(s.flightSeconds)} />
        <Tile label="Missions" value={s.missionsCompleted} />
      </div>
      {showActions && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <button
            onClick={() => openCertificatePrintView(buildCertificateHtml({ stats: s }))}
            className="rounded-md bg-chip px-2.5 py-1 font-semibold text-ink hover:bg-chip2"
          >
            Generate certificate
          </button>
          <button
            onClick={() => {
              if (window.confirm('Reset impact totals for this browser?')) resetImpactStats()
            }}
            className="rounded-md px-2 py-1 font-semibold text-muted hover:text-bad"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  )
}
