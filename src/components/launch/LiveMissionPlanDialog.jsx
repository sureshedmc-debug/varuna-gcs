// Live Mission Plan: State → River → Sections → proceed to the existing planner.
// The states and rivers come from the editable catalog (data/states.csv +
// rivers.csv), not from this file.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { fetchCatalog } from '../../lib/localData'
import { startLivePlan, checkSections, MAX_SECTIONS } from '../../lib/liveMissionPlan'
import { planRiverSections } from '../../lib/riverSections'
import { useHomeMode } from '../../lib/homeMode'

/** The catalog from the store, or the bundled default list if the store is absent. */
async function loadCatalog() {
  try {
    return await fetchCatalog()
  } catch (err) {
    const r = await fetch('/config/rivers.json', { cache: 'no-store' })
    if (!r.ok) throw err
    const j = await r.json()
    return { states: j.states || [], source: 'default', notes: [`Using the built-in river list (${err.message})`] }
  }
}

export default function LiveMissionPlanDialog({ onClose, onProceed }) {
  const [catalog, setCatalog] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [step, setStep] = useState(1)
  const [stateId, setStateId] = useState('')
  const [riverId, setRiverId] = useState('')
  const [sections, setSections] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [planning, setPlanning] = useState(false)
  const plain = useHomeMode() === 'simple'
  const [planFailed, setPlanFailed] = useState(false)
  const planAbort = useRef(null)
  useEffect(() => () => planAbort.current?.abort(), [])
  const firstRef = useRef(null)

  useEffect(() => {
    let live = true
    setLoadError('')
    setCatalog(null)
    loadCatalog()
      .then((c) => live && setCatalog(c))
      .catch((err) => live && setLoadError(err.message || 'Could not load the state and river list.'))
    return () => {
      live = false
    }
  }, [reload])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && (e.stopImmediatePropagation(), onClose())
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    firstRef.current?.focus()
  }, [step, catalog])

  const states = catalog?.states || []
  const state = states.find((s) => s.id === stateId)
  const rivers = state?.rivers || []
  const river = rivers.find((r) => r.id === riverId)

  function next() {
    setError('')
    if (step === 1) {
      if (!state) return setError('Select a state.')
      if (!rivers.length) return setError(`No rivers are listed for ${state.name}. Add them to rivers.csv (Basic data shows where it is).`)
      return setStep(2)
    }
    if (step === 2) {
      if (!river) return setError('Select a river.')
      return setStep(3)
    }
  }

  async function proceed(e) {
    e?.preventDefault()
    if (planning) return
    setError('')
    if (!state) return setStep(1), setError('Select a state.')
    if (!river) return setStep(2), setError('Select a river.')
    const chk = checkSections(sections)
    if (chk.error) return setError(chk.error)
    // Plan every section along the river first; if the map lookup fails the
    // operator can still go on and plan by hand (second press).
    let sectionPlans = null
    if (!planFailed) {
      const ac = new AbortController()
      planAbort.current = ac
      setPlanning(true)
      try {
        sectionPlans = await planRiverSections(river, chk.value, { signal: ac.signal })
      } catch (err) {
        setPlanning(false)
        if (err.code === 'cancelled') return
        setPlanFailed(true)
        return setError(`Couldn’t plan the sections automatically: ${err.message}`)
      }
      setPlanning(false)
    }
    try {
      onProceed(startLivePlan({ state, river, sections: chk.value, sectionPlans }))
    } catch (err) {
      setError(err.message)
    }
  }

  return createPortal(
    <div className="vl-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div
        className="vl-page vl-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vl-lmp-title"
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.32 }}
      >
        <h2 className="vl-h1" id="vl-lmp-title">Live Mission Plan</h2>
        <p className="vl-sub">Step {step} of 3 · {step === 1 ? 'Select State' : step === 2 ? 'Select River' : plain ? 'How many parts' : 'Sections'}</p>
        <div className="vl-steps" aria-hidden="true">
          {[1, 2, 3].map((n) => <span key={n} className={`vl-step ${n <= step ? 'on' : ''}`} />)}
        </div>

        {!catalog && !loadError && <div className="vl-msg info">Loading states and rivers…</div>}
        {loadError && (
          <div className="vl-msg bad">
            {loadError} <button type="button" className="vl-link" onClick={() => setReload((n) => n + 1)}>Try again</button>
          </div>
        )}
        {catalog?.notes?.length > 0 && <div className="vl-msg info">{catalog.notes.join(' ')}</div>}
        {catalog && !states.length && <div className="vl-msg bad">No states are enabled in states.csv.</div>}

        {catalog && step === 1 && (
          <div className="vl-choices" role="group" aria-label="State">
            {states.map((s, i) => (
              <button
                key={s.id}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                className="vl-choice"
                aria-pressed={s.id === stateId}
                onClick={() => { setStateId(s.id); setRiverId(''); setError('') }}
                onDoubleClick={() => { setStateId(s.id); setRiverId(''); setStep(2) }}
              >
                <div className="vl-choice-name">{s.name}</div>
                <div className="vl-choice-sub">{s.rivers.length} river{s.rivers.length === 1 ? '' : 's'}</div>
              </button>
            ))}
          </div>
        )}

        {catalog && step === 2 && (
          <>
            <div className="vl-section-title" style={{ marginTop: 0 }}>Rivers in {state?.name}</div>
            <div className="vl-choices" role="group" aria-label="River">
              {rivers.map((r, i) => (
                <button
                  key={r.id}
                  ref={i === 0 ? firstRef : undefined}
                  type="button"
                  className="vl-choice"
                  aria-pressed={r.id === riverId}
                  onClick={() => { setRiverId(r.id); setError('') }}
                  onDoubleClick={() => { setRiverId(r.id); setStep(3) }}
                >
                  <div className="vl-choice-name">{r.name}</div>
                  {r.notes && <div className="vl-choice-sub">{r.notes}</div>}
                </button>
              ))}
            </div>
          </>
        )}

        {catalog && step === 3 && (
          <form onSubmit={proceed} noValidate>
            <label className="vl-field">
              <span className="vl-label">{plain ? 'How many parts should the river be split into? Each part is one short flight.' : 'How many sections should this mission contain?'}</span>
              <input
                ref={firstRef}
                className="vl-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_SECTIONS}
                step={1}
                value={sections}
                aria-invalid={!!error}
                onChange={(e) => { setSections(e.target.value); setError(''); setPlanFailed(false) }}
                placeholder={`1 – ${MAX_SECTIONS}`}
              />
            </label>
            <div className="vl-summary">
              <b>{state?.name}</b> → <b>{river?.name}</b>
              {checkSections(sections).value ? <> → <b>{checkSections(sections).value}</b> {plain ? 'part' : 'section'}{checkSections(sections).value > 1 ? 's' : ''}</> : null}
              <div style={{ fontSize: 12, marginTop: 4 }}>{plain ? 'The app plans the route for every part, then opens the map on part 1. Check it, then send it to the drone.' : 'Waypoints are planned along the river for every section, then the mission planner opens on section 1. Review and upload one section at a time.'}</div>
            </div>
          </form>
        )}

        {planning && <div className="vl-msg info" role="status">Planning {checkSections(sections).value} section(s) along the {river?.name}…</div>}
        {error && <div className="vl-msg bad" role="alert">{error}</div>}

        <div className="vl-actions">
          <button type="button" className="vl-btn ghost" onClick={() => (planning ? planAbort.current?.abort() : step === 1 ? onClose() : (setStep(step - 1), setError('')))}>
            {step === 1 || planning ? 'Cancel' : 'Back'}
          </button>
          {step < 3 ? (
            <button type="button" className="vl-btn" onClick={next} disabled={!catalog}>Next</button>
          ) : (
            <button type="button" className="vl-btn" onClick={proceed} disabled={planning}>
              {planning ? 'Planning…' : planFailed ? 'Proceed and plan by hand' : 'Click Here to Proceed'}
            </button>
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}
