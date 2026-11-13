// The Data tab: saved records, the CSV files and the river list, behind a PIN.
import { useState } from 'react'
import '../components/launch/launch.css'
import BasicDataPage from '../components/launch/BasicDataPage'
import { unlockData } from '../lib/auth'
import { isDataUnlocked, setDataUnlocked } from '../lib/dataLock'

function PinGate({ onUnlock }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    if (!pin) return setError('Enter the PIN.')
    setBusy(true)
    setError('')
    try {
      await unlockData(pin)
      setDataUnlocked()
      onUnlock()
    } catch (err) {
      setError(err.message)
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="vl-page vl-pin" onSubmit={submit} noValidate>
      <h2 className="vl-h1">Data</h2>
      <p className="vl-sub">Enter the PIN to see the saved records.</p>
      <input className="vl-input vl-pin-input" type="password" inputMode="numeric" autoComplete="off" autoFocus
        aria-label="PIN" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value.replace(/\s/g, ''))} />
      {error && <div className="vl-msg bad" role="alert">{error}</div>}
      <button className="vl-btn vl-full" type="submit" disabled={busy} style={{ marginTop: 14 }}>
        {busy ? 'Checking…' : 'Open'}
      </button>
    </form>
  )
}

export default function DataScreen() {
  const [open, setOpen] = useState(isDataUnlocked)
  return (
    <div className="varuna-home vl-tab-page">
      {open ? (
        <div className="vl-page wide">
          <BasicDataPage />
        </div>
      ) : (
        <PinGate onUnlock={() => setOpen(true)} />
      )}
    </div>
  )
}
