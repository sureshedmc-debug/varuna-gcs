// The feedback form at the end of Explore Varuna. Sent to the Render backend
// (/site/feedback, rewritten by Vercel so it is same-origin).
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useUser } from '../lib/auth'
import { EASE, Icon } from './parts'

const ROLES = ['Student', 'Teacher', 'Judge', 'Engineer', 'Other']
const WORDS = ['', 'Needs work', 'Okay', 'Good', 'Great', 'Outstanding']

export default function Feedback() {
  const user = useUser()
  const [f, setF] = useState(() => ({ name: user?.name || '', email: user?.email || '', role: '', rating: 0, message: '' }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!f.rating) return setError('Tap the stars to give a rating.')
    if (f.message.trim().length < 3) return setError('Please write a few words.')
    setBusy(true)
    try {
      const res = await fetch('/site/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(f),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) throw new Error(j.error || 'Could not send right now. Please try again in a moment.')
      setSent(true)
    } catch (err) {
      setError(err.message === 'Failed to fetch' ? 'No connection. Check your internet and try again.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vs-form">
      <AnimatePresence mode="wait">
        {sent ? (
          <motion.div key="ok" className="vs-thanks" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, ease: EASE }}>
            <motion.i initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 16, delay: 0.1 }}>
              <Icon name="check" size={34} stroke={2.4} />
            </motion.i>
            <b>Thank you{f.name ? `, ${f.name.split(' ')[0]}` : ''}!</b>
            <p>Your feedback reached the Varuna team.</p>
            <button type="button" className="vs-btn ghost small" onClick={() => { setSent(false); setF((s) => ({ ...s, rating: 0, message: '' })) }}>Send another</button>
          </motion.div>
        ) : (
          <motion.form key="form" onSubmit={submit} noValidate initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="vs-field">
              <span>How would you rate VARUNA AI? {f.rating ? <em style={{ color: 'var(--cyan)', fontStyle: 'normal' }}>· {WORDS[f.rating]}</em> : null}</span>
              <div className="vs-stars" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={f.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
                    className={n <= f.rating ? 'on' : ''} onClick={() => setF((s) => ({ ...s, rating: n }))}>
                    <Icon name="star" size={32} />
                  </button>
                ))}
              </div>
            </div>
            <div className="vs-row2">
              <label className="vs-field"><span>Your name</span>
                <input className="vs-input" value={f.name} onChange={set('name')} maxLength={80} autoComplete="name" placeholder="Optional" />
              </label>
              <label className="vs-field"><span>Email</span>
                <input className="vs-input" type="email" value={f.email} onChange={set('email')} maxLength={120} autoComplete="email" placeholder="Optional, if you want a reply" />
              </label>
            </div>
            <div className="vs-field">
              <span>I am a</span>
              <div className="vs-pills">
                {ROLES.map((r) => (
                  <button key={r} type="button" className={f.role === r ? 'on' : ''} aria-pressed={f.role === r} onClick={() => setF((s) => ({ ...s, role: s.role === r ? '' : r }))}>{r}</button>
                ))}
              </div>
            </div>
            <label className="vs-field"><span>Your feedback</span>
              <textarea className="vs-input" value={f.message} onChange={set('message')} maxLength={2000}
                placeholder="What did you like? What should we build next?" />
            </label>
            {error && <div className="vs-msg" role="alert">{error}</div>}
            <button className="vs-btn primary block" type="submit" disabled={busy}>
              {busy ? 'Sending…' : <>Send feedback <Icon name="arrow" size={16} className="arrow" /></>}
            </button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  )
}
