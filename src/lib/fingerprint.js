// Fingerprint sign-in with Windows Hello (WebAuthn). WebAuthn names the site a
// key belongs to and refuses an IP address, and the desktop window runs on
// 127.0.0.1 — so the check runs in a small window at http://localhost:<same
// port>, served by the local store (electron/localData.cjs), and this waits for
// the store to say how it went. The fingerprint itself never leaves the sensor.
import { localCall, LocalDataError } from './localData'

const WAIT_MS = 2 * 60 * 1000

let supported = null
let pageOrigin = '' // http://localhost:<port>, as the store reports it

/** Resolves true when this computer has Windows Hello (fingerprint, face or PIN). */
export function fingerprintSupported() {
  supported ||= (async () => {
    try {
      if (!window.PublicKeyCredential || !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false
      pageOrigin = (await localCall('/local/auth/config')).fingerprint?.origin || ''
      return !!pageOrigin
    } catch {
      supported = null // the store may just be starting; ask again next time
      return false
    }
  })()
  return supported
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Open the Windows Hello window and wait for it. Call straight from a click, so
 * the window is not blocked.
 * @param {'login'|'verify'|'add'} kind  login: no password; verify: instead of
 *   the face check (token = the face ticket); add: token = fingerprintSetup.
 * @returns the store's answer: { profile, fingerprintSetup } or { added }.
 */
export async function runFingerprint(kind, token = '', { signal } = {}) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  if (!pageOrigin) throw new LocalDataError('unavailable', 'Windows Hello is not available here.')
  const url = `${pageOrigin}/local/auth/fingerprint/page#id=${id}&kind=${kind}&t=${encodeURIComponent(token)}`
  const win = window.open(url, 'varuna-fingerprint', 'popup,width=380,height=380')
  if (!win) throw new LocalDataError('blocked', 'The fingerprint window could not open. Allow pop-ups for VARUNA and try again.')
  const stop = (message) => {
    try {
      win.close()
    } catch {
      /* already closed */
    }
    localCall('/local/auth/fingerprint/cancel', { id, message }).catch(() => {})
  }
  const deadline = Date.now() + WAIT_MS
  let closedPolls = 0
  while (Date.now() < deadline) {
    await sleep(250)
    if (signal?.aborted) {
      stop('Fingerprint cancelled.')
      throw new LocalDataError('cancelled', 'Fingerprint cancelled.')
    }
    let r
    try {
      r = await localCall('/local/auth/fingerprint/result', { id })
    } catch (err) {
      if (err.code === 'offline') continue // a blip; keep waiting
      throw err
    }
    if (r.status === 'done') return r
    if (r.status === 'error') throw new LocalDataError(r.code || 'fingerprint', r.message || 'The fingerprint check failed.')
    if (r.status === 'cancelled') throw new LocalDataError('cancelled', r.message || 'Fingerprint cancelled.')
    // Closed without a word (the page reports a close itself; give it a moment).
    if (win.closed && ++closedPolls > 4) throw new LocalDataError('cancelled', 'Fingerprint cancelled.')
  }
  stop('Fingerprint timed out.')
  throw new LocalDataError('expired', 'The fingerprint check timed out. Try again.')
}
