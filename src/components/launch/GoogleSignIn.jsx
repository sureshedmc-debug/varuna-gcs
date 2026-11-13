// "Continue with Google". Needs the operator's own Google OAuth client ID (a
// public identifier, not a secret); until one is saved this offers to set it up.
import { useEffect, useRef, useState } from 'react'
import { getAuthConfig, saveGoogleClientId, signInWithGoogle, finishFaceCheck, finishWithFingerprint } from '../../lib/auth'
import { GoogleIcon } from './icons'
import { useOnline } from '../../lib/online'
import FaceCheck from './FaceCheck'

export default function GoogleSignIn({ label = 'Continue with Google', onSignedIn }) {
  const [cfg, setCfg] = useState(null) // {configured} | {error}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [setup, setSetup] = useState(false)
  const [clientId, setClientId] = useState('')
  const [face, setFace] = useState(null) // {ticket, enroll, fingerprint} once Google has said yes
  const [faceBusy, setFaceBusy] = useState(false)
  const [faceError, setFaceError] = useState('')
  const abortRef = useRef(null)
  const online = useOnline()

  useEffect(() => {
    let live = true
    getAuthConfig()
      .then((g) => live && setCfg(g))
      .catch((err) => live && setCfg({ configured: false, error: err.message, unavailable: err.code === 'unavailable' }))
    return () => {
      live = false
      abortRef.current?.abort()
    }
  }, [])

  async function start() {
    setError('')
    setPageUrl('')
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const r = await signInWithGoogle({ signal: ac.signal, onPage: setPageUrl })
      setFaceError('')
      setFace(r.face)
    } catch (err) {
      if (err.code !== 'cancelled') setError(err.message)
    } finally {
      setBusy(false)
      setPageUrl('')
    }
  }

  async function saveSetup(e) {
    e.preventDefault()
    setError('')
    try {
      const g = await saveGoogleClientId(clientId.trim())
      setCfg(g)
      setSetup(false)
    } catch (err) {
      setError(err.message)
    }
  }

  async function faceDone(samples) {
    setFaceBusy(true)
    try {
      const u = await finishFaceCheck(face.ticket, samples, 'google')
      setFace(null)
      onSignedIn?.(u)
    } catch (err) {
      if (err.code === 'face_mismatch') setFaceError(err.message)
      else {
        setFace(null)
        setError(err.message)
      }
    } finally {
      setFaceBusy(false)
    }
  }

  // Instead of the face: the fingerprint saved for this account.
  async function fingerprintInstead() {
    setFaceBusy(true)
    setFaceError('')
    try {
      const u = await finishWithFingerprint(face.ticket, 'google')
      setFace(null)
      onSignedIn?.(u)
    } catch (err) {
      if (err.code === 'cancelled' || err.code === 'not_verified' || err.code === 'bad_fingerprint') setFaceError(err.message)
      else {
        setFace(null)
        setError(err.message)
      }
    } finally {
      setFaceBusy(false)
    }
  }

  if (face) {
    return (
      <div className="vl-msg info">
        <b>{face.enroll ? 'One more step: save your face for future sign-ins.' : 'One more step: check it is you.'}</b>
        <FaceCheck mode={face.enroll ? 'enroll' : 'verify'} busy={faceBusy} error={faceError}
          onCapture={faceDone} onRetry={() => setFaceError('')} onCancel={() => setFace(null)}
          onFingerprint={face.fingerprint ? fingerprintInstead : undefined} />
      </div>
    )
  }

  if (cfg?.unavailable) return <div className="vl-msg info">{cfg.error}</div>
  // The one part of signing in that needs the internet.
  if (!online) return <div className="vl-msg info">Google sign-in needs the internet. Sign in with a username and password instead — that works offline.</div>

  return (
    <div>
      <button type="button" className="vl-btn google vl-full" onClick={start} disabled={busy || !cfg?.configured}>
        <GoogleIcon /> {busy ? 'Waiting for Google…' : label}
      </button>
      {busy && (
        <div className="vl-msg info">
          Finish signing in in the Google window that opened (it may be in your web browser).{' '}
          {pageUrl && <>Nothing opened? <a className="vl-link" href={pageUrl} target="_blank" rel="noreferrer">Open the sign-in page</a>. </>}
          <button type="button" className="vl-link" onClick={() => abortRef.current?.abort()}>Cancel</button>
        </div>
      )}
      {cfg && !cfg.configured && !setup && (
        <div className="vl-msg info">
          Google sign-in is not set up on this computer yet.{' '}
          <button type="button" className="vl-link" onClick={() => setSetup(true)}>Set it up</button>
        </div>
      )}
      {setup && (
        <form onSubmit={saveSetup} className="vl-msg info">
          <label className="vl-field">
            <span className="vl-label">Google OAuth client ID (Web application)</span>
            <input className="vl-input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
          </label>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>
            Create it in Google Cloud Console → APIs &amp; Services → Credentials (type: Web application) and add{' '}
            <code className="vl-mono">{cfg?.origin || "this app's sign-in address"}</code> under Authorised JavaScript
            origins (if the app ever starts on a different port, add that address too). Only the client ID is
            needed; no client secret is stored.
          </div>
          <button className="vl-btn" type="submit" disabled={!clientId.trim()}>Save</button>{' '}
          <button className="vl-btn ghost" type="button" onClick={() => setSetup(false)}>Cancel</button>
        </form>
      )}
      {cfg?.error && !cfg.unavailable && <div className="vl-msg bad">{cfg.error}</div>}
      {error && <div className="vl-msg bad" role="alert">{error}</div>}
    </div>
  )
}
