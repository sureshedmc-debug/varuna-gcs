import { useState } from 'react'
import { motion } from 'framer-motion'
import { Btn } from './ui'

const KEY = 'welcome to Varuna'
const OPERATOR_PIN = '1111' // local unlock code — no backend involved

export function getStoredSession() {
  try {
    return sessionStorage.getItem(KEY) || null
  } catch {
    return null
  }
}

/**
 * Lightweight PIN lock-screen. Preserves the /api/auth/verify_pin flow.
 * On success stores a session marker for this tab only. This is a simple
 * access gate, not bank-grade auth (by design).
 */
export function PinGate({ onUnlock }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  function submit(e) {
    e?.preventDefault()
    if (!pin || busy) return
    setBusy(true)
    setErr('')
    if (pin.trim() === OPERATOR_PIN) {
      try {
        sessionStorage.setItem(KEY, 'ok')
      } catch {
        /* private mode */
      }
      onUnlock('ok')
    } else {
      setErr('Incorrect PIN')
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <div className="ambient" />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}
        className="glass relative z-10 w-full max-w-sm p-7 shadow-elev"
      >
        <div className="mb-1 text-sm font-semibold tracking-[0.3em] text-accent">VARUNA AI</div>
        <h1 className="mb-6 text-2xl font-bold text-ink">Ground Control</h1>
        <label className="mb-2 block text-xs uppercase tracking-wider text-muted">Operator PIN</label>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="inp touch mb-4 w-full px-4 text-lg tracking-widest"
          placeholder="••••"
        />
        {err && <div className="mb-3 text-sm font-medium text-bad">{err}</div>}
        <Btn type="submit" className="w-full">
          Unlock
        </Btn>
      </motion.form>
    </div>
  )
}
