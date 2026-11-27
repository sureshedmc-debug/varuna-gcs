// Direct Mission Plan, full screen. Left: the title, the two ways in, live
// numbers and an animated river route. Right: who is planning, the plan in
// progress, how it works and the rivers on file.
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useUser, displayName, logout } from '../../lib/auth'
import { useLivePlan, endLivePlan, MAX_SECTIONS } from '../../lib/liveMissionPlan'
import GoogleSignIn from './GoogleSignIn'
import LiveMissionPlanDialog, { loadCatalog } from './LiveMissionPlanDialog'
import { RouteIcon, ChevronRight } from './icons'
import { rise, Links, RiverRoute } from './FullPage'

const STEPS = [
  ['State', 'Choose the state the river runs through.'],
  ['River', 'Pick the river from the list on file.'],
  ['Sections', `Split it into up to ${MAX_SECTIONS} sections to cover one by one.`],
  ['Plan & fly', 'Lay the route on the map; Varuna scouts, Nirmal Dhara Jalyan collects.'],
]

function useCatalogStats() {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    let live = true
    loadCatalog()
      .then((c) => {
        if (!live) return
        const states = c?.states || []
        const rivers = states.flatMap((s) => (s.rivers || []).map((r) => ({ id: `${s.id}:${r.id}`, name: r.name || r.id, state: s.name || s.id })))
        setStats({ states: states.length, rivers })
      })
      .catch(() => live && setStats({ states: 0, rivers: [] }))
    return () => { live = false }
  }, [])
  return stats
}

// `startWizard`: opened from Simple Home's "Start a mission" — go straight to
// the wizard, and cancelling it goes back Home.
export default function DirectMissionPlanPage({ onOpen, onNavigate, onClose, startWizard = false }) {
  const user = useUser()
  const plan = useLivePlan()
  const stats = useCatalogStats()
  const [wizard, setWizard] = useState(startWizard)

  const toPlanner = () => {
    onClose()
    onNavigate('mission')
  }

  return (
    <div className="vl-dmp">
      <section className="vl-dmp-hero">
        <RiverRoute />
        <div className="vl-dmp-hero-inner">
          <motion.div className="vl-dmp-eyebrow" {...rise(0)}>VARUNA AI · Mission planning</motion.div>
          <motion.h1 className="vl-dmp-title" {...rise(1)}>
            Direct<br /><span className="vl-dmp-outline">Mission</span><br /><span className="vl-brand-ai">Plan</span>
          </motion.h1>
          <motion.p className="vl-dmp-sub" {...rise(2)}>
            Pick the river and how many sections to cover, then plan it on the map. The drone finds the waste; the boat collects it.
          </motion.p>

          <motion.div className="vl-dmp-cta" {...rise(3)}>
            <button type="button" className="vl-dmp-primary" onClick={() => setWizard(true)}>
              <RouteIcon size={20} /> Live Mission Plan <ChevronRight size={18} />
            </button>
            <button type="button" className="vl-dmp-secondary" onClick={toPlanner}>Open the planner directly</button>
          </motion.div>

          <motion.dl className="vl-dmp-stats" {...rise(4)}>
            <div><dt>States</dt><dd>{stats ? stats.states : '–'}</dd></div>
            <div><dt>Rivers on file</dt><dd>{stats ? stats.rivers.length : '–'}</dd></div>
            <div><dt>Sections per plan</dt><dd>{MAX_SECTIONS}</dd></div>
          </motion.dl>

          <motion.div {...rise(5)}><Links /></motion.div>
        </div>
      </section>

      <aside className="vl-dmp-side">
        <motion.div className="vl-dmp-card" {...rise(2)}>
          <div className="vl-section-title" style={{ marginTop: 0 }}>Who is planning</div>
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
        </motion.div>

        <motion.div className="vl-dmp-card" {...rise(3)}>
          <div className="vl-section-title" style={{ marginTop: 0 }}>How it works</div>
          <ol className="vl-dmp-steps">
            {STEPS.map(([t, s], i) => (
              <li key={t}>
                <span className="vl-dmp-step-n">{String(i + 1).padStart(2, '0')}</span>
                <span><b>{t}</b><small>{s}</small></span>
              </li>
            ))}
          </ol>
        </motion.div>

        {stats?.rivers.length > 0 && (
          <motion.div className="vl-dmp-card" {...rise(4)}>
            <div className="vl-section-title" style={{ marginTop: 0 }}>Rivers on file</div>
            <div className="vl-dmp-chips">
              {stats.rivers.slice(0, 10).map((r) => (
                <button type="button" key={r.id} className="vl-dmp-chip" onClick={() => setWizard(true)} title={`${r.name} · ${r.state}`}>
                  {r.name}<small>{r.state}</small>
                </button>
              ))}
              {stats.rivers.length > 10 && <span className="vl-dmp-chip more">+{stats.rivers.length - 10} more</span>}
            </div>
          </motion.div>
        )}
      </aside>

      {wizard && <LiveMissionPlanDialog onClose={() => { setWizard(false); if (startWizard) onClose() }} onProceed={() => { setWizard(false); toPlanner() }} />}
    </div>
  )
}
