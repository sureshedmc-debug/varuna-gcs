import { useState } from 'react'
import { useUser, displayName, loginWithPassword, registerAccount, logout } from '../../lib/auth'
import GoogleSignIn from './GoogleSignIn'

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

export default function LoginPage({ onOpen, onClose }) {
  const user = useUser()
  const [mode, setMode] = useState('login') // login | register
  const [f, setF] = useState({ username: '', password: '', confirm: '', name: '', email: '', profession: '', organisation: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  if (user) return <Profile user={user} onOpen={onOpen} onClose={onClose} />

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!f.username.trim() || !f.password) return setError('Enter your username and password.')
    if (mode === 'register') {
      if (!f.name.trim()) return setError('Enter your name.')
      if (f.password.length < 8) return setError('Password: at least 8 characters.')
      if (f.password !== f.confirm) return setError('The two passwords do not match.')
    }
    setBusy(true)
    try {
      if (mode === 'login') await loginWithPassword(f.username.trim(), f.password)
      else {
        await registerAccount({
          username: f.username.trim(), password: f.password, name: f.name.trim(), email: f.email.trim(),
          profession: f.profession.trim(), organisation: f.organisation.trim(),
        })
      }
      setF((s) => ({ ...s, password: '', confirm: '' })) // never keep it around
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 className="vl-h1">{mode === 'login' ? 'Login' : 'Create an account'}</h2>
      <p className="vl-sub">Sign in so missions and detections are saved under your name.</p>

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
          {busy ? 'Please wait…' : mode === 'login' ? 'Login' : 'Create account and sign in'}
        </button>
      </form>
      <p style={{ fontSize: 13, marginTop: 14, textAlign: 'center' }}>
        {mode === 'login' ? 'New here? ' : 'Already have an account? '}
        <button type="button" className="vl-link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>
          {mode === 'login' ? 'Create an account' : 'Login'}
        </button>
      </p>
    </>
  )
}
