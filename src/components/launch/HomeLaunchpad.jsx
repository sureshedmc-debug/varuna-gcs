// Top of the Home tab: a full-width hero playing the VARUNA ecosystem, with
// the account buttons and Direct Mission Plan floating on it, then the
// drone/boat status cards.
import { useState } from 'react'
import './launch.css'
import { useUser, displayName } from '../../lib/auth'
import { useLivePlan } from '../../lib/liveMissionPlan'
import { useSystem } from '../SystemContext'
import { useBoat } from '../BoatContext'
import { pick } from '../../lib/format'
import { UserIcon, RouteIcon, ChevronRight } from './icons'

// The ecosystem in daylight, rendered from the intro's own 3D scene (its
// lighter 'day' mood): the drone scouts and tags plastic, the boat belts it
// aboard. A seamless 16 s loop; a still frame when motion is reduced.
function EcosystemLoop() {
  const [still] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  if (still) return <img className="vl-hero-video" src="/ecosystem-day-poster.jpg" alt="" aria-hidden="true" />
  return (
    <video className="vl-hero-video" autoPlay muted loop playsInline preload="auto" poster="/ecosystem-day-poster.jpg" aria-hidden="true">
      <source src="/ecosystem-day.mp4" type="video/mp4" />
      <source src="/ecosystem-day.webm" type="video/webm" />
    </video>
  )
}

// ---------------------------------------------------------------- link status
const CONNECT_HELP = [
  'Switch on the drone (or the boat) and wait about a minute.',
  'Connect this laptop to the same Wi-Fi network as the drone.',
  'This card turns green by itself when the drone answers.',
]

function Readiness() {
  const { backendReachable, simulated, telemetry } = useSystem()
  const [help, setHelp] = useState(false)
  const v = Number(telemetry?.data ? pick(telemetry.data, ['battery_voltage', 'voltage', 'battery']) : NaN)
  const batt = Number.isFinite(v) && v > 0 ? Math.round(Math.max(0, Math.min(100, ((v - 10.5) / (12.6 - 10.5)) * 100))) : null

  let tone = 'wait'
  let title = 'Looking for the drone…'
  let text = 'This takes a few seconds.'
  if (backendReachable === true) {
    tone = batt != null && batt < 30 ? 'warn' : 'ok'
    title = tone === 'ok' ? 'Ready to fly' : 'Battery is low'
    text = batt == null ? 'The drone is connected.' : tone === 'ok' ? `The drone is connected. Battery ${batt}%.` : `Battery ${batt}%. Charge it before you fly.`
  } else if (backendReachable === false) {
    tone = 'warn'
    title = 'Drone not connected'
    text = simulated
      ? 'You can still plan and practise: until a drone connects, the app flies a pretend one.'
      : 'The connection to the drone was lost. The app keeps trying.'
  }
  return (
    <div className={`vl-ready ${tone}`} role="status">
      <span className="vl-ready-dot" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div className="vl-ready-title">{title}</div>
        <div className="vl-ready-text">
          {text}{' '}
          {tone === 'warn' && backendReachable === false && (
            <button type="button" className="vl-link" onClick={() => setHelp((h) => !h)} aria-expanded={help}>
              {help ? 'Hide help' : 'How do I connect?'}
            </button>
          )}
        </div>
        {help && (
          <ol className="vl-ready-help">
            {CONNECT_HELP.map((s) => <li key={s}>{s}</li>)}
          </ol>
        )}
      </div>
    </div>
  )
}

const BOAT_HELP = [
  'Switch on the boat and wait about a minute.',
  'Check this laptop and the boat are on the same Netbird network.',
  "If it still doesn't connect, check the boat's address under System → Boat connection.",
]

/** The boat's link, in the same plain words as the drone's card above it. */
function BoatReadiness() {
  const boat = useBoat()
  const [help, setHelp] = useState(false)
  const t = boat?.telemetry?.data || {}
  const pct = Number(t.battery_percent)
  const batt = Number.isFinite(pct) && t.battery_percent != null ? Math.round(pct) : null

  let tone = 'wait'
  let title = 'Looking for the boat…'
  let text = 'This takes a few seconds.'
  if (boat?.reachable === true) {
    tone = !boat.fcConnected || (batt != null && batt < 30) ? 'warn' : 'ok'
    title = !boat.fcConnected ? 'Boat found, not ready' : tone === 'ok' ? 'Boat ready' : 'Boat battery is low'
    text = !boat.fcConnected
      ? 'Nirmal Dhara Jalyan is on, but its flight controller is not answering yet.'
      : batt == null ? 'Nirmal Dhara Jalyan is connected.' : tone === 'ok' ? `Nirmal Dhara Jalyan is connected. Battery ${batt}%.` : `Battery ${batt}%. Charge Nirmal Dhara Jalyan before you go.`
  } else if (boat?.reachable === false) {
    tone = 'warn'
    title = 'Boat not connected'
    text = boat.wrongTarget ? "The boat's address points at something that is not the boat." : 'The app keeps trying to reach Nirmal Dhara Jalyan.'
  }
  return (
    <div className={`vl-ready ${tone}`} role="status">
      <span className="vl-ready-dot" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div className="vl-ready-title">{title}</div>
        <div className="vl-ready-text">
          {text}{' '}
          {boat?.reachable === false && (
            <button type="button" className="vl-link" onClick={() => setHelp((h) => !h)} aria-expanded={help}>
              {help ? 'Hide help' : 'How do I connect?'}
            </button>
          )}
        </div>
        {help && (
          <ol className="vl-ready-help">
            {BOAT_HELP.map((s) => <li key={s}>{s}</li>)}
          </ol>
        )}
      </div>
    </div>
  )
}

/** Top-right of the hero: Login / Create account, or the signed-in account. */
function AccountButtons({ user, onOpen }) {
  if (user) {
    const name = displayName(user)
    return (
      <button type="button" className="vl-glass-btn vl-account-chip" onClick={() => onOpen('login')} aria-label={`Account: ${name}`}>
        <span className="vl-avatar-sm">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : name[0]?.toUpperCase()}</span>
        <span className="vl-account-name">{name}</span>
      </button>
    )
  }
  return (
    <>
      <button type="button" className="vl-glass-btn" onClick={() => onOpen('register')}>Create account</button>
      <button type="button" className="vl-solid-btn" onClick={() => onOpen('login')}>
        <UserIcon size={16} /> Login
      </button>
    </>
  )
}

export default function HomeLaunchpad({ onOpen }) {
  const user = useUser()
  const plan = useLivePlan()
  const toStatus = () => document.getElementById('home-status')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <>
      <section className="vl-hero" aria-label="Welcome">
        <EcosystemLoop />
        <div className="vl-hero-scrim" aria-hidden="true" />

        <header className="vl-hero-bar">
          <span className="vl-hero-badge"><i className="vl-dot live" aria-hidden="true" />River patrol · live demo</span>
          <nav className="vl-hero-account" aria-label="Account">
            <AccountButtons user={user} onOpen={onOpen} />
          </nav>
        </header>

        <div className="vl-hero-copy">
          <div className="vl-hero-eyebrow">Autonomous river cleanup</div>
          <h1 className="vl-hero-title">
            {user ? <>Hi, {displayName(user)}</> : <>VARUNA <span className="vl-brand-ai">AI</span></>}
          </h1>
          <p className="vl-hero-sub">
            {plan
              ? `Live plan in progress: ${plan.name}, section ${plan.activeSection} of ${plan.sections}.`
              : 'A drone that finds the waste, a boat that collects it. Cleaner water, greener tomorrow.'}
          </p>
          <button type="button" className="vl-float-plan" onClick={() => onOpen('plan')}>
            <span className="vl-float-plan-icon"><RouteIcon size={22} /></span>
            <span className="vl-float-plan-text">
              <b>Direct Mission Plan</b>
              <small>{plan ? 'Continue the live plan, or start a new one' : 'Choose state, river and sections, then plan'}</small>
            </span>
            <ChevronRight size={20} />
          </button>
        </div>

        <ul className="vl-hero-roles" aria-label="In the video">
          <li><i className="vl-dot cyan" aria-hidden="true" />Varuna · aerial scout</li>
          <li><i className="vl-dot saffron" aria-hidden="true" />Nirmal Dhara Jalyan · collector</li>
        </ul>

        <button type="button" className="vl-hero-scroll" onClick={toStatus}>
          Status &amp; stats <span aria-hidden="true">↓</span>
        </button>
      </section>

      <section id="home-status" className="vl-status-row" aria-label="Drone and boat status">
        <Readiness />
        <BoatReadiness />
      </section>
    </>
  )
}
