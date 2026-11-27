// The camera step of sign-up and sign-in. Opens the webcam, waits for one face
// to be clearly in view, takes a few face templates a moment apart and hands
// them to onCapture. The camera turns off as soon as this closes.
import { useEffect, useRef, useState } from 'react'
import { loadFace, openCamera, lookOnce, SAMPLES } from '../../lib/face'

const GAP_MS = { enroll: 250, verify: 90 }

export default function FaceCheck({ mode = 'verify', onCapture, onCancel, onRetry, onFingerprint, busy = false, error = '' }) {
  const videoRef = useRef(null)
  const [msg, setMsg] = useState('Starting the camera…')
  const [fail, setFail] = useState('')
  const [taken, setTaken] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [off, setOff] = useState(false) // fingerprint chosen: camera off
  const doneRef = useRef(onCapture)
  doneRef.current = onCapture
  const need = SAMPLES[mode] || SAMPLES.verify

  useEffect(() => {
    let stream = null
    let stopped = false
    setFail('')
    setTaken(0)
    if (off) return undefined
    const ready = loadFace().catch(() => { throw new Error('The face check could not load. Restart the app and try again.') })
    ready.catch(() => {}) // reported below when awaited; not if the camera failed first
    ;(async () => {
      try {
        // The picture shows as soon as the camera is on; the models are usually
        // ready by then (they load while the password is typed).
        stream = await openCamera()
        if (stopped) return
        const v = videoRef.current
        v.srcObject = stream
        await v.play().catch(() => {})
        setMsg('Getting ready…')
        await ready
        if (stopped) return
        setMsg('Look at the camera')
        const samples = []
        while (!stopped && samples.length < need) {
          if (v.readyState < 2) {
            await new Promise((r) => setTimeout(r, 50))
            continue
          }
          const look = await lookOnce(v)
          if (stopped) return
          if (look.faces === 0) setMsg('No face found. Look at the camera, with light on your face.')
          else if (look.faces > 1) setMsg('Only one person in front of the camera, please.')
          else {
            samples.push(look.descriptor)
            setTaken(samples.length)
            setMsg(samples.length < need ? 'Hold still…' : 'Got it')
          }
          if (samples.length < need) await new Promise((r) => setTimeout(r, look.faces === 1 ? GAP_MS[mode] || 90 : 60))
        }
        if (!stopped) doneRef.current?.(samples)
      } catch (err) {
        if (!stopped) setFail(err.message)
      } finally {
        stream?.getTracks().forEach((t) => t.stop())
        stream = null
      }
    })()
    return () => {
      stopped = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [attempt, mode, need, off])

  const shownError = fail || error
  const finished = taken >= need && !shownError
  return (
    <div className="vl-face">
      <div className={`vl-face-cam ${finished ? 'done' : ''}`}>
        <video ref={videoRef} muted playsInline aria-label="Camera preview" />
        <span className="vl-face-oval" aria-hidden="true" />
      </div>
      <div className="vl-face-status" role="status">
        {busy ? (off ? 'Waiting for Windows Hello…' : mode === 'enroll' ? 'Saving your face…' : 'Checking it is you…') : shownError ? '' : off ? '' : msg}
        {!shownError && !busy && !off && <span className="vl-face-dots">{Array.from({ length: need }, (_, i) => <i key={i} className={i < taken ? 'on' : ''} />)}</span>}
      </div>
      {shownError && <div className="vl-msg bad" role="alert">{shownError}</div>}
      <div className="vl-actions">
        <button type="button" className="vl-btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {onFingerprint && <button type="button" className="vl-btn ghost" onClick={() => { setOff(true); onFingerprint() }} disabled={busy}>Use fingerprint instead</button>}
          {(shownError || (off && !busy)) && <button type="button" className="vl-btn" onClick={() => { onRetry?.(); setOff(false); setAttempt((n) => n + 1) }} disabled={busy}>{off ? 'Use the camera' : 'Try again'}</button>}
        </span>
      </div>
      <p className="vl-face-note">
        {mode === 'enroll'
          ? 'Your face is saved as a set of numbers on this computer, so it can check it is you each time you sign in. No photo is kept.'
          : 'Your face is compared with the one saved when your account was made. No photo is kept.'}
      </p>
    </div>
  )
}
