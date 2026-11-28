// The Data tab: saved records, the CSV files and the river list, behind a PIN.
import { useState } from 'react'
import { Page, Pill, TabHeader } from '../components/simple/Simple'
import BasicDataPage from '../components/launch/BasicDataPage'
import { unlockData } from '../lib/auth'
import { isDataUnlocked, lockData, setDataUnlocked } from '../lib/dataLock'

const HINT = 'Every mission, drone position and plastic find, saved as spreadsheets you can download.'

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
    <form className="sx-section mx-auto mt-6 w-full max-w-[420px] p-7 text-center" onSubmit={submit} noValidate>
      <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl" style={{ background: 'var(--sx-accent-soft)', color: 'var(--sx-accent-text)' }}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 118 0v3" /><path d="M12 15v2" />
        </svg>
      </span>
      <h2 className="text-[20px] font-bold tracking-tight text-ink">Records are locked</h2>
      <p className="mt-1 text-[14px] text-muted">Enter the PIN to open the saved records.</p>
      <input className="sx-input mt-5 text-center font-mono text-[20px] tracking-[0.4em]" style={{ minHeight: 52 }}
        type="password" inputMode="numeric" autoComplete="off" autoFocus placeholder="••••"
        aria-label="PIN" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value.replace(/\s/g, ''))} />
      {error && <div className="mt-3 rounded-lg px-3 py-2 text-[13px] font-semibold" role="alert" style={{ background: 'var(--sx-bad-soft)', color: 'var(--sx-bad)' }}>{error}</div>}
      <button className="sx-btn lg mt-4 w-full" type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Unlock'}
      </button>
      <p className="mt-4 text-[12px] text-muted">The records lock again when you lock the app.</p>
    </form>
  )
}

export default function DataScreen() {
  const [open, setOpen] = useState(isDataUnlocked)
  return (
    <Page>
      <TabHeader icon="data" title="Data" hint={HINT}>
        {open ? (
          <>
            <Pill tone="ok">Unlocked</Pill>
            <button type="button" className="sx-btn ghost sm" onClick={() => { lockData(); setOpen(false) }}>Lock</button>
          </>
        ) : <Pill>Locked</Pill>}
      </TabHeader>
      {open ? <BasicDataPage /> : <PinGate onUnlock={() => setOpen(true)} />}
    </Page>
  )
}
