import { useEffect, useState } from 'react'
import {
  useUser, displayName, loginWithPassword, registerAccount, finishFaceCheck, finishWithFingerprint, logout,
  signInWithFingerprint, canAddFingerprint, addFingerprint, fingerprintsSaved,
} from '../../lib/auth'
import { fingerprintSupported } from '../../lib/fingerprint'
import { preloadFace } from '../../lib/face'
import GoogleSignIn from './GoogleSignIn'
import FaceCheck from './FaceCheck'
import { FingerprintIcon, RouteIcon, ChevronRight } from './icons'
import { motion } from 'framer-motion'
import { rise, Links, RiverRoute } from './FullPage'

// Full screen, like Direct Mission Plan: the left side names the step in big
// type, the right side holds the form itself.
const HERO = {
  login: { lines: ['Welcome', 'back to', 'Varuna'], sub: 'Sign in so missions and detections are saved under your name.' },
  register: { lines: ['Create', 'your', 'account'], sub: 'One account for planning and flying. The last step saves your face, so each sign-in can check it is you.' },
  verify: { lines: ['Check', 'it is', 'you'], sub: 'Your password is right. Now look at the camera.' },
  enroll: { lines: ['Save', 'your', 'face'], sub: 'The camera takes your face so each sign-in can check it is you.' },
  profile: { lines: ['You are', 'signed', 'in'], sub: 'Missions and detections from here on are saved under your name.' },
}
const WAYS = [
  ['Gmail', 'One click with your Google account.'],
  ['Password + face', 'Your password, then the camera checks it is you.'],
  ['Fingerprint', 'One touch with Windows Hello, once it is added.'],
]

function LoginShell({ kind, onOpen, children }) {
  const h = HERO[kind]
  const signedOut = kind === 'login' || kind === 'register'
  return (
    <div className="vl-dmp vl-dmp-login">
      <section className="vl-dmp-hero">
        <RiverRoute />
        <div className="vl-dmp-hero-inner">
          <motion.div className="vl-dmp-eyebrow" {...rise(0)}>VARUNA AI · {kind === 'profile' ? 'Your account' : 'Secure sign-in'}</motion.div>
          <motion.h1 key={kind} className="vl-dmp-title" {...rise(1)}>
            {h.lines[0]}<br /><span className="vl-dmp-outline">{h.lines[1]}</span><br /><span className="vl-brand-ai">{h.lines[2]}</span>
          </motion.h1>
          <motion.p className="vl-dmp-sub" {...rise(2)}>{h.sub}</motion.p>

          {signedOut && (
            <motion.ol className="vl-login-ways" {...rise(3)} aria-label="Ways to sign in">
              {WAYS.map(([t, d], i) => (
                <li key={t}><span>{String(i + 1).padStart(2, '0')}</span><b>{t}</b><small>{d}</small></li>
              ))}
            </motion.ol>
          )}

          {(signedOut || kind === 'profile') && (
            <motion.div className="vl-dmp-cta" {...rise(4)}>
              <button type="button" className={kind === 'profile' ? 'vl-dmp-primary' : 'vl-dmp-secondary'} onClick={() => onOpen('plan')}>
                <RouteIcon size={18} /> {kind === 'profile' ? 'Direct Mission Plan' : 'Plan without signing in'} <ChevronRight size={16} />
              </button>
            </motion.div>
          )}

          <motion.div {...rise(5)}><Links /></motion.div>
        </div>
      </section>

      <aside className="vl-dmp-side">
        <motion.div className="vl-dmp-card vl-login-card" {...rise(2)}>{children}</motion.div>
        {kind === 'login' && (
          <motion.div className="vl-dmp-card" {...rise(3)}>
            <div className="vl-section-title" style={{ marginTop: 0 }}>Why sign in</div>
            <ol className="vl-dmp-steps">
              <li><span className="vl-dmp-step-n">01</span><span><b>Your name on every mission</b><small>Missions and detections are saved under your name and ID.</small></span></li>
              <li><span className="vl-dmp-step-n">02</span><span><b>Only you can sign in</b><small>After the password, the camera checks it is really you.</small></span></li>
              <li><span className="vl-dmp-step-n">03</span><span><b>Faster next time</b><small>Add your fingerprint and one touch signs you in.</small></span></li>
            </ol>
          </motion.div>
        )}
      </aside>
    </div>
  )
}

/** Windows Hello is on this computer (and, with `needSaved`, a fingerprint is saved). */
function useFingerprint(needSaved) {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    let live = true
    fingerprintSupported()
      .then((yes) => (yes && needSaved ? fingerprintsSaved().then((n) => n > 0) : yes))
      .then((yes) => live && setOk(yes), () => {})
    return () => {
      live = false
    }
  }, [needSaved])
  return ok
}

/** Right after signing in: offer to add a fingerprint for next time. */
function AddFingerprint({ user }) {
  const supported = useFingerprint(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // { text, bad }
  if (msg && !msg.bad) return <div className="vl-msg info">{msg.text}</div>
  if (!supported || user.fingerprint === 'yes' || !canAddFingerprint()) return null
  async function add() {
    setBusy(true)
    setMsg(null)
    try {
      await addFingerprint()
      setMsg({ text: 'Fingerprint added. Next time, press “Sign in with fingerprint”: no password needed.' })
    } catch (err) {
      setMsg({ text: err.message, bad: true })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="vl-fp-offer">
      <FingerprintIcon />
      <div>
        <b>Sign in faster next time</b>
        <span>Add your fingerprint (Windows Hello). Then one touch signs you in.</span>
        {msg?.bad && <span className="vl-fp-bad">{msg.text}</span>}
      </div>
      <button type="button" className="vl-btn" onClick={add} disabled={busy}>{busy ? 'Waiting for Windows…' : 'Add fingerprint'}</button>
    </div>
  )
}

function Field({ label, ...props }) {
  return (
    <label className="vl-field">
      <span className="vl-label">{label}</span>
      <input className="vl-input" {...props} />
    </label>
  )
}

function Profile({ user, onOpen, onClose }) {
  const when = user.loginAt ? new Date(user.loginAt).toLocaleString() : ''
  return (
    <>
      <h2 className="vl-h1">Hi, {displayName(user)}</h2>
      <p className="vl-sub">You are signed in{user.provider === 'google' ? ' with Google' : ''}.</p>
      <div className="vl-identity">
        <div className="vl-avatar">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : displayName(user)[0]?.toUpperCase()}</div>
        <div>
          <div className="vl-identity-name">{user.name || user.username}</div>
          <div className="vl-identity-sub">{[user.email, user.username && `@${user.username}`].filter(Boolean).join(' · ')}</div>
          <div className="vl-identity-sub">
            ID {user.userId}
            {user.profession ? ` · ${user.profession}` : ''}
            {user.organisation ? ` · ${user.organisation}` : ''}
            {when ? ` · signed in ${when}` : ''}
          </div>
        </div>
      </div>
      <AddFingerprint user={user} />
      <div className="vl-actions">
        <button type="button" className="vl-btn ghost" onClick={() => logout()}>Sign out</button>
        <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="vl-btn ghost" onClick={onClose}>Back to Home</button>
          <button type="button" className="vl-btn" onClick={() => onOpen('plan')}>Direct Mission Plan</button>
        </span>
      </div>
    </>
  )
}

export default function LoginPage({ onOpen, onClose, startRegister = false }) {
  const user = useUser()
  const [mode, setMode] = useState(startRegister ? 'register' : 'login') // login | register
  const [f, setF] = useState({ username: '', password: '', confirm: '', name: '', email: '', profession: '', organisation: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The face step: { enroll } while making an account, { ticket, enroll } after the password.
  const [face, setFace] = useState(null)
  const [faceError, setFaceError] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const fingerprintSaved = useFingerprint(true)
  // The face models get ready while the password is typed, so the camera step is instant.
  useEffect(() => {
    if (!user) preloadFace()
  }, [user])

  if (user) return <LoginShell kind="profile" onOpen={onOpen}><Profile user={user} onOpen={onOpen} onClose={onClose} /></LoginShell>

  function backToForm(message = '') {
    setFace(null)
    setFaceError('')
    setError(message)
    setF((s) => ({ ...s, password: '', confirm: '' })) // never keep it around
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!f.username.trim() || !f.password) return setError('Enter your username and password.')
    if (mode === 'register') {
      if (!f.name.trim()) return setError('Enter your name.')
      if (f.password.length < 8) return setError('Password: at least 8 characters.')
      if (f.password !== f.confirm) return setError('The two passwords do not match.')
      // The account is made once the face is taken (faceDone).
      return setFace({ enroll: true, register: true })
    }
    setBusy(true)
    try {
      setFace(await loginWithPassword(f.username.trim(), f.password))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function fingerprintSignIn() {
    setBusy(true)
    setError('')
    try {
      await signInWithFingerprint()
    } catch (err) {
      if (err.code !== 'cancelled') setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // Instead of the face, after the password.
  async function fingerprintInstead() {
    setBusy(true)
    setFaceError('')
    try {
      await finishWithFingerprint(face.ticket, 'password')
      backToForm()
    } catch (err) {
      if (err.code === 'cancelled' || err.code === 'not_verified' || err.code === 'bad_fingerprint') setFaceError(err.message)
      else backToForm(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function faceDone(samples) {
    setBusy(true)
    setFaceError('')
    try {
      if (face.register) {
        await registerAccount({
          username: f.username.trim(), password: f.password, name: f.name.trim(), email: f.email.trim(),
          profession: f.profession.trim(), organisation: f.organisation.trim(), face: samples,
        })
      } else {
        await finishFaceCheck(face.ticket, samples, 'password')
      }
      backToForm()
    } catch (err) {
      // A wrong face can be retaken; anything else (wrong details, expired) goes back to the form.
      if (err.code === 'face_mismatch') setFaceError(err.message)
      else backToForm(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (face) {
    return (
      <LoginShell kind={face.enroll ? 'enroll' : 'verify'} onOpen={onOpen}>
        <h2 className="vl-h1">{face.enroll ? 'Save your face' : 'Check it is you'}</h2>
        <p className="vl-sub">
          {face.register
            ? 'Last step: the camera takes your face so each sign-in can check it is you.'
            : face.enroll
              ? 'Your account has no face saved yet. Save it now; from then on every sign-in checks it.'
              : 'Your password is right. Now look at the camera.'}
        </p>
        <FaceCheck mode={face.enroll ? 'enroll' : 'verify'} busy={busy} error={faceError}
          onCapture={faceDone} onRetry={() => setFaceError('')} onCancel={() => backToForm()}
          onFingerprint={face.fingerprint ? fingerprintInstead : undefined} />
      </LoginShell>
    )
  }

  return (
    <LoginShell kind={mode} onOpen={onOpen}>
      <h2 className="vl-h1">{mode === 'login' ? 'Login' : 'Create an account'}</h2>
      <p className="vl-sub">Sign in so missions and detections are saved under your name.</p>

      {fingerprintSaved && mode === 'login' && (
        <button type="button" className="vl-btn vl-full vl-fp-btn" onClick={fingerprintSignIn} disabled={busy}>
          <FingerprintIcon /> {busy ? 'Waiting for Windows Hello…' : 'Sign in with fingerprint'}
        </button>
      )}

      <GoogleSignIn />

      <div className="vl-divider">OR</div>

      <form onSubmit={submit} noValidate>
        {mode === 'register' && (
          <div className="vl-row">
            <Field label="Full name" value={f.name} onChange={set('name')} autoComplete="name" maxLength={80} />
            <Field label="Email (optional)" type="email" value={f.email} onChange={set('email')} autoComplete="email" maxLength={254} />
          </div>
        )}
        <Field label="Username" value={f.username} onChange={set('username')} autoComplete="username" maxLength={32} />
        <div className={mode === 'register' ? 'vl-row' : ''}>
          <Field label="Password" type="password" value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={200} />
          {mode === 'register' && <Field label="Confirm password" type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" maxLength={200} />}
        </div>
        {mode === 'register' && (
          <div className="vl-row">
            <Field label="Role / profession (optional)" value={f.profession} onChange={set('profession')} maxLength={80} placeholder="e.g. Drone pilot" />
            <Field label="Organisation (optional)" value={f.organisation} onChange={set('organisation')} maxLength={120} />
          </div>
        )}
        {error && <div className="vl-msg bad" role="alert">{error}</div>}
        <button className="vl-btn vl-full" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Login' : 'Next: take your face picture'}
        </button>
      </form>
      <p style={{ fontSize: 13, marginTop: 14, textAlign: 'center' }}>
        {mode === 'login' ? 'New here? ' : 'Already have an account? '}
        <button type="button" className="vl-link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>
          {mode === 'login' ? 'Create an account' : 'Login'}
        </button>
      </p>
    </LoginShell>
  )
}
