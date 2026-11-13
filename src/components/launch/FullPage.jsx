// Shared parts of the full-screen launch pages (Direct Mission Plan, Login):
// the entrance motion, the drone/boat link badges and the animated river.
import { useSystem } from '../SystemContext'
import { useBoat } from '../BoatContext'

const EASE = [0.16, 1, 0.3, 1]

/** Props for a motion element that rises into place, `i`-th in the sequence. */
export const rise = (i) => ({
  initial: { opacity: 0, y: 28 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, ease: EASE, delay: 0.15 + i * 0.07 },
})

function LinkPill({ label, tone, text }) {
  return (
    <span className={`vl-dmp-pill ${tone}`}>
      <i aria-hidden="true" />
      <b>{label}</b>
      <span>{text}</span>
    </span>
  )
}

/** Drone and boat link, as two small badges. */
export function Links() {
  const { backendReachable, simulated } = useSystem()
  const boat = useBoat()
  const drone = backendReachable === true
    ? ['ok', 'Connected']
    : backendReachable === false ? ['warn', simulated ? 'Practice mode' : 'Not connected'] : ['wait', 'Looking…']
  const b = boat?.reachable === true
    ? (boat.fcConnected ? ['ok', 'Connected'] : ['warn', 'Not ready'])
    : boat?.reachable === false ? ['warn', 'Not connected'] : ['wait', 'Looking…']
  return (
    <div className="vl-dmp-links" role="status">
      <LinkPill label="Varuna drone" tone={drone[0]} text={drone[1]} />
      <LinkPill label="Nirmal Dhara Jalyan" tone={b[0]} text={b[1]} />
    </div>
  )
}

/** A river winding across the background, split into glowing sections. */
export function RiverRoute() {
  const d = 'M -40 520 C 120 470, 180 330, 330 330 S 520 470, 660 400 S 820 170, 980 210 S 1180 120, 1300 60'
  const marks = [[120, 470], [330, 330], [520, 440], [660, 400], [820, 250], [980, 210], [1160, 125]]
  return (
    <svg className="vl-dmp-river" viewBox="0 0 1260 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="dmpRiver" x1="0" x2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <path d={d} className="vl-dmp-river-bed" />
      <path d={d} className="vl-dmp-river-flow" stroke="url(#dmpRiver)" />
      {marks.map(([x, y], i) => (
        <g key={i} className="vl-dmp-mark" style={{ animationDelay: `${0.9 + i * 0.18}s` }}>
          <circle cx={x} cy={y} r="16" />
          <circle cx={x} cy={y} r="5" />
        </g>
      ))}
    </svg>
  )
}
