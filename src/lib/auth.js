// The signed-in operator. Passwords are checked (and hashed) by the local data
// store; Google sign-in is verified there against Google. All this page keeps
// is the non-sensitive profile below — no password, no Google token.

import { useSyncExternalStore } from 'react'
import { localCall, LocalDataError, saveRecords, eventRow } from './localData'
import { runFingerprint } from './fingerprint'

const KEY = 'varuna.user'
const subs = new Set()

const FIELDS = ['userId', 'username', 'name', 'email', 'provider', 'profession', 'organisation', 'picture', 'createdAt', 'loginAt', 'fingerprint']

function pick(p) {
  if (!p || typeof p !== 'object' || !p.userId) return null
  return Object.fromEntries(FIELDS.map((k) => [k, typeof p[k] === 'string' ? p[k] : '']))
}

function load() {
  try {
    return pick(JSON.parse(localStorage.getItem(KEY)))
  } catch {
    return null
  }
}

let user = load()
// For a few minutes after signing in, the operator may add a fingerprint. Kept
// in memory only, never saved.
let fingerprintSetup = null

function setUser(profile) {
  user = pick(profile)
  try {
    if (user) localStorage.setItem(KEY, JSON.stringify(user))
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode: signed in for this session only */
  }
  subs.forEach((fn) => fn())
  return user
}

/** users.csv is written by the store itself; this adds the activity line.
 *  `j`: the store's answer, { profile, fingerprintSetup }. */
function signedIn(j, how) {
  fingerprintSetup = j.fingerprintSetup || null
  const u = setUser(j.profile)
  if (u) saveRecords([{ table: 'mission_events', op: 'insert', rows: [eventRow('login', { user: u, details: how })] }])
  return u
}

export function getUser() {
  return user
}

/** React hook: the signed-in profile, or null. */
export function useUser() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => user,
  )
}

/** "Asha" from "Asha Rao"; falls back to the username or email. */
export function displayName(u) {
  if (!u) return ''
  return u.name || u.username || (u.email || '').split('@')[0] || 'Operator'
}

/**
 * Checks the password. Not signed in yet: resolves with the face step,
 * { ticket, enroll, fingerprint }, to finish with finishFaceCheck() — or
 * finishWithFingerprint() when `fingerprint` (one is saved for this account).
 */
export async function loginWithPassword(username, password) {
  return (await localCall('/local/auth/login', { username, password })).face
}

/** Finishes a password or Google sign-in with the face templates from FaceCheck. */
export async function finishFaceCheck(ticket, face, how) {
  const j = await localCall('/local/auth/face', { ticket, face })
  return signedIn(j, how)
}

/** Instead of the face check: Windows Hello with the fingerprint saved for this account. */
export async function finishWithFingerprint(ticket, how, opts) {
  return signedIn(await runFingerprint('verify', ticket, opts), `${how} + fingerprint`)
}

/** Sign in with the fingerprint alone (Windows Hello), no password. */
export async function signInWithFingerprint(opts) {
  return signedIn(await runFingerprint('login', '', opts), 'fingerprint')
}

/** True for a few minutes after signing in: a fingerprint can be added now. */
export function canAddFingerprint() {
  return !!fingerprintSetup && !!user
}

/** Save this operator's fingerprint (Windows Hello) for the next sign-in. */
export async function addFingerprint(opts) {
  if (!canAddFingerprint()) throw new LocalDataError('expired', 'Sign in again, then add the fingerprint.')
  await runFingerprint('add', fingerprintSetup, opts)
  fingerprintSetup = null
  return setUser({ ...user, fingerprint: 'yes' })
}

/** How many fingerprints are saved on this computer (0 = hide the button). */
export async function fingerprintsSaved() {
  return (await localCall('/local/auth/config')).fingerprint?.saved || 0
}

/** `fields.face`: the face templates taken while making the account. */
export async function registerAccount(fields) {
  const j = await localCall('/local/auth/register', fields)
  return signedIn(j, 'new account')
}

/** The Data tab's PIN, checked by the local store. */
export async function unlockData(pin) {
  await localCall('/local/data/unlock', { pin })
}

export function logout() {
  if (user) saveRecords([{ table: 'mission_events', op: 'insert', rows: [eventRow('logout', { user })] }])
  fingerprintSetup = null
  setUser(null)
}

export async function getAuthConfig() {
  return (await localCall('/local/auth/config')).google
}

export async function saveGoogleClientId(googleClientId) {
  return (await localCall('/local/auth/config', { googleClientId })).google
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Google sign-in. Google does not allow its sign-in inside an embedded app
 * window, so a small sign-in page opens in the browser (the desktop app sends it
 * to the system browser) and this waits for the store to report the result.
 * @param {{signal?: AbortSignal, onPage?: (url: string) => void}} [o]
 *   onPage gets the page URL so the UI can offer it as a link if a popup blocker
 *   stopped it opening.
 * @returns {Promise<{face: {ticket: string, enroll: boolean}}>} Google said yes;
 *   finish with the face check (finishFaceCheck).
 */
export async function signInWithGoogle({ signal, onPage } = {}) {
  const begin = await localCall('/local/auth/google/begin', {})
  try {
    window.open(begin.url, 'varuna-google-signin', 'popup,width=480,height=640')
  } catch {
    /* blocked: the link from onPage still works */
  }
  onPage?.(begin.url)
  const deadline = Date.now() + (begin.expiresInS || 300) * 1000
  while (Date.now() < deadline) {
    await sleep(500) // a local call; checking often makes sign-in feel instant
    if (signal?.aborted) throw new LocalDataError('cancelled', 'Google sign-in cancelled.')
    let r
    try {
      r = await localCall(`/local/auth/google/result?nonce=${encodeURIComponent(begin.nonce)}`)
    } catch (err) {
      if (err.code === 'offline') continue // a blip; keep waiting
      throw err
    }
    if (r.status === 'face') return { face: r.face } // Google said yes; the face check comes next
    if (r.status === 'done') return signedIn(r, 'google')
    if (r.status === 'error') throw new LocalDataError('google', r.message || 'Google sign-in failed.')
    if (r.status === 'expired') throw new LocalDataError('expired', r.message || 'The sign-in window expired. Try again.')
  }
  throw new LocalDataError('expired', 'Google sign-in timed out. Try again.')
}
