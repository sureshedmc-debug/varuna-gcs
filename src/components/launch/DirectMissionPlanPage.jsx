import { useState } from 'react'
import { useUser, displayName, logout } from '../../lib/auth'
import { useLivePlan, endLivePlan } from '../../lib/liveMissionPlan'
import GoogleSignIn from './GoogleSignIn'
import LiveMissionPlanDialog from './LiveMissionPlanDialog'
import { RouteIcon } from './icons'

// `startWizard`: opened from Simple Home's "Start a mission" — go straight to
// the wizard, and cancelling it goes back Home.
export default function DirectMissionPlanPage({ onOpen, onNavigate, onClose, startWizard = false }) {
  const user = useUser()
  const plan = useLivePlan()
  const [wizard, setWizard] = useState(startWizard)

  const toPlanner = () => {
    onClose()
    onNavigate('mission')
  }

  return (
    <>
      <h2 className="vl-h1">Direct Mission Plan</h2>
      <p className="vl-sub">Pick the river and how many sections to cover, then plan it on the map.</p>

      {user ? (
        <div className="vl-identity">
          <div className="vl-avatar">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : displayName(user)[0]?.toUpperCase()}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="vl-identity-name">Logged in as: {displayName(user)}</div>
            <div className="vl-identity-sub">{[user.email, user.username && `@${user.username}`].filter(Boolean).join(' · ')}</div>
          </div>
          <button type="button" className="vl-link" style={{ fontSize: 12 }} onClick={() => logout()}>Not you?</button>
        </div>
      ) : (
        <div className="vl-identity" style={{ display: 'block' }}>
          <div className="vl-identity-name" style={{ marginBottom: 8 }}>You are not signed in</div>
          <GoogleSignIn label="Login with Gmail" />
          <div style={{ fontSize: 12, marginTop: 8 }}>
            Or <button type="button" className="vl-link" onClick={() => onOpen('login')}>use a username and password</button>.
            You can also plan without signing in; the mission is then saved without a name.
          </div>
        </div>
      )}

      {plan && (
        <div className="vl-msg info vl-active-plan">
          <b>In progress:</b> {plan.name} · section {plan.activeSection} of {plan.sections} · {plan.missionId}
          <div className="vl-actions" style={{ marginTop: 8 }}>
            <button type="button" className="vl-btn ghost" onClick={() => endLivePlan()}>Close this plan</button>
            <button type="button" className="vl-btn" onClick={toPlanner}>Continue planning</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button type="button" className="vl-btn big vl-full" onClick={() => setWizard(true)}>
          <RouteIcon /> Live Mission Plan
        </button>
        <p style={{ fontSize: 12, textAlign: 'center', marginTop: 10, color: '#6d28d9' }}>
          Or <button type="button" className="vl-link" onClick={toPlanner}>open the mission planner directly</button>.
        </p>
      </div>

      {wizard && <LiveMissionPlanDialog onClose={() => { setWizard(false); if (startWizard) onClose() }} onProceed={() => { setWizard(false); toPlanner() }} />}
    </>
  )
}
