// Top of the Home tab: the ways in (left) and the VARUNA AI artwork (right).
// Simple mode shows one guided path (sign in → plan → fly) with a single big
// button and a plain-words readiness card; Expert mode shows the three options.
import { useState } from 'react'
import './launch.css'
import { useUser, displayName, logout } from '../../lib/auth'
import { useLivePlan, endLivePlan } from '../../lib/liveMissionPlan'
import { useActiveMission } from '../../lib/missionStore'
import { useImpactStats } from '../../lib/impactStats'
import { useSystem } from '../SystemContext'
import { useBoat } from '../BoatContext'
import { pick } from '../../lib/format'
import { UserIcon, RouteIcon, DataIcon, ChevronRight } from './icons'

function Option({ icon, tone = '', title, sub, onClick }) {
  return (
    <button type="button" className="vl-option" onClick={onClick}>
      <span className={`vl-option-icon ${tone}`}>{icon}</span>
      <span>
        <span className="vl-option-title" style={{ display: 'block' }}>{title}</span>
        <span className="vl-option-sub" style={{ display: 'block' }}>{sub}</span>
      </span>
      <span className="vl-option-go"><ChevronRight size={26} /></span>
    </button>
  )
}

// ---------------------------------------------------------------- simple mode
function Step({ n, title, state, hint, action, children }) {
  return (
    <li className={`vl-step-row ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
      <span className="vl-step-num" aria-hidden="true">{state === 'done' ? '✓' : n}</span>
      <span style={{ minWidth: 0 }}>
        <span className="vl-step-title">
          {title}
          {state === 'done' && <span className="vl-step-tag done">done</span>}
          {state === 'now' && <span className="vl-step-tag now">next</span>}
          {state === 'skipped' && <span className="vl-step-tag">skipped</span>}
        </span>
        {hint && <span className="vl-step-hint">{hint}</span>}
        {children}
      </span>
      {action && <span className="vl-step-action">{action}</span>}
    </li>
  )
}

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
      ? 'Jal Dhara is on, but its flight controller is not answering yet.'
      : batt == null ? 'Jal Dhara is connected.' : tone === 'ok' ? `Jal Dhara is connected. Battery ${batt}%.` : `Battery ${batt}%. Charge Jal Dhara before you go.`
  } else if (boat?.reachable === false) {
    tone = 'warn'
    title = 'Boat not connected'
    text = boat.wrongTarget ? "The boat's address points at something that is not the boat." : 'The app keeps trying to reach Jal Dhara.'
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

function SimpleStart({ onOpen, onNavigate }) {
  const user = useUser()
  const plan = useLivePlan()
  const mission = useActiveMission()
  const impact = useImpactStats()
  const firstTime = !(impact.missionsCompleted > 0)
  const flying = mission?.status === 'running'
  const [confirmCancel, setConfirmCancel] = useState(false)

  const step = !user && !plan ? 1 : !plan ? 2 : 3
  const where = plan && `${plan.river.name}, part ${plan.activeSection} of ${plan.sections}`
  const go =
    step === 1 ? { label: 'Sign in to start', sub: 'With Google or a username', run: () => onOpen('login') }
      : step === 2 ? { label: 'Start a mission', sub: 'Pick a river and the app plans the route', run: () => onOpen('plan-new') }
        : flying ? { label: 'Watch the flight', sub: where, run: () => onNavigate('live') }
          : { label: 'Open the map and fly', sub: where, run: () => onNavigate('mission') }

  return (
    <>
      <div>
        <h1 className="vl-greet">{user ? <>Hi, <b>{displayName(user)}</b></> : <>Welcome to <b>VARUNA AI</b></>}</h1>
        <p className="vl-greet-sub">
          {firstTime ? 'Your first mission takes three steps.' : 'Three steps to your next mission.'}
        </p>
      </div>

      <ol className="vl-steps-list">
        <Step n={1} title="Sign in" state={user ? 'done' : step === 1 ? 'now' : 'skipped'}
          hint={user ? `As ${displayName(user)}` : firstTime ? 'So your missions and findings are saved under your name.' : null}
          action={user
            ? <button type="button" className="vl-step-btn" onClick={() => logout()}>Sign out</button>
            : step !== 1 && <button type="button" className="vl-step-btn" onClick={() => onOpen('login')}>Sign in</button>} />
        <Step n={2} title="Plan a mission" state={plan ? 'done' : step === 2 ? 'now' : 'todo'}
          hint={plan ? `${plan.river.name} · ${plan.state.name}, ${plan.sections} part${plan.sections > 1 ? 's' : ''}` : firstTime ? 'Pick a state and a river, and say how many parts to split it into. The app plans the route.' : null}
          // Not while flying: the plan is what this flight is being recorded under.
          action={plan && !flying && !confirmCancel && <button type="button" className="vl-step-btn" onClick={() => setConfirmCancel(true)}>Cancel plan</button>}>
          {plan && confirmCancel && (
            <span className="vl-step-confirm" role="group" aria-label="Cancel this plan?">
              Cancel this plan? What was already saved stays in My records.
              <span>
                <button type="button" className="vl-step-btn danger" onClick={() => { endLivePlan(); setConfirmCancel(false) }}>Yes, cancel it</button>
                <button type="button" className="vl-step-btn" onClick={() => setConfirmCancel(false)}>Keep it</button>
              </span>
            </span>
          )}
        </Step>
        <Step n={3} title={flying ? 'Flying now' : 'Fly it'} state={step === 3 ? 'now' : 'todo'}
          hint={firstTime ? 'Check the route on the map, then press Save, Send to drone and Start.' : null} />
      </ol>

      <button type="button" className="vl-go" onClick={go.run}>
        <span>
          <span className="vl-go-label">{go.label}</span>
          {go.sub && <span className="vl-go-sub">{go.sub}</span>}
        </span>
        <ChevronRight size={30} />
      </button>

      <div className="vl-quiet-links">
        {step === 1 && <button type="button" className="vl-link" onClick={() => onOpen('plan-new')}>Skip and plan without signing in</button>}
        {step === 3 && <button type="button" className="vl-link" onClick={() => onOpen('plan-new')}>Plan a different river</button>}
        {user && <button type="button" className="vl-link" onClick={() => onOpen('login')}>My account</button>}
        <button type="button" className="vl-link" onClick={() => onOpen('data')}>My records</button>
      </div>

      <Readiness />
      <BoatReadiness />
    </>
  )
}

export default function HomeLaunchpad({ onOpen, onNavigate, simple = false }) {
  const user = useUser()
  const plan = useLivePlan()
  return (
    <section className={`vl-launch vh-animate vh-animate-2 ${simple ? 'simple' : ''}`} aria-label="Start">
      <div className="vl-options">
        {simple ? (
          <SimpleStart onOpen={onOpen} onNavigate={onNavigate} />
        ) : (
          <>
            <div>
              <h1 className="vl-greet">{user ? <>Hi, <b>{displayName(user)}</b></> : <>Welcome to <b>VARUNA AI</b></>}</h1>
              <p className="vl-greet-sub">
                {plan ? `Live plan in progress: ${plan.name}, section ${plan.activeSection} of ${plan.sections}.` : 'Drones and AI for cleaner water, greener environment.'}
              </p>
            </div>
            <Option
              icon={<UserIcon size={30} />}
              title={user ? 'Account' : 'Login'}
              sub={user ? `Signed in as ${user.email || user.username}` : 'Google or username & password'}
              onClick={() => onOpen('login')}
            />
            <Option
              icon={<RouteIcon size={30} />}
              tone="teal"
              title="Direct Mission Plan"
              sub={plan ? 'Continue the live plan, or start a new one' : 'Choose state, river and sections, then plan'}
              onClick={() => onOpen('plan')}
            />
            <Option icon={<DataIcon size={30} />} tone="amber" title="Basic / Elementary Data" sub="Saved records, CSV files and river list" onClick={() => onOpen('data')} />
          </>
        )}
      </div>

      <div className="vl-brand" role="img" aria-label="VARUNA AI drone over a lake">
        <div className="vl-brand-top">
          <div className="vl-brand-eyebrow">Welcome to</div>
          <div className="vl-brand-title">VARUNA AI</div>
        </div>
        <div className="vl-brand-art" />
        <div className="vl-brand-bottom">
          <span className="vl-brand-bar" />
          <span className="vl-brand-tag">Cleaner water<br />Greener tomorrow</span>
        </div>
      </div>
    </section>
  )
}

/** Simple / Expert switch shown at the top of Home. */
export function ModeSwitch({ mode, onChange }) {
  return (
    <div className="vl-mode" role="radiogroup" aria-label="Home view">
      {[['simple', 'Simple'], ['expert', 'Expert']].map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'on' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}
