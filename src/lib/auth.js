// The signed-in operator. Passwords are checked (and hashed) by the local data
// store; Google sign-in is verified there against Google. All this page keeps
// is the non-sensitive profile below — no password, no Google token.

import { useSyncExternalStore } from 'react'
import { localCall, LocalDataError, saveRecords, eventRow } from './localData'

const KEY = 'varuna.user'
const subs = new Set()

const FIELDS = ['userId', 'username', 'name', 'email', 'provider', 'profession', 'organisation', 'picture', 'createdAt', 'loginAt']

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

/** users.csv is written by the store itself; this adds the activity line. */
function signedIn(profile, how) {
  const u = setUser(profile)
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

export async function loginWithPassword(username, password) {
  const j = await localCall('/local/auth/login', { username, password })
  return signedIn(j.profile, 'password')
}

export async function registerAccount(fields) {
  const j = await localCall('/local/auth/register', fields)
  return signedIn(j.profile, 'new account')
}

export function logout() {
  if (user) saveRecords([{ table: 'mission_events', op: 'insert', rows: [eventRow('logout', { user })] }])
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
    await sleep(1500)
    if (signal?.aborted) throw new LocalDataError('cancelled', 'Google sign-in cancelled.')
    let r
    try {
      r = await localCall(`/local/auth/google/result?nonce=${encodeURIComponent(begin.nonce)}`)
    } catch (err) {
      if (err.code === 'offline') continue // a blip; keep waiting
      throw err
    }
    if (r.status === 'done') return signedIn(r.profile, 'google')
    if (r.status === 'error') throw new LocalDataError('google', r.message || 'Google sign-in failed.')
    if (r.status === 'expired') throw new LocalDataError('expired', r.message || 'The sign-in window expired. Try again.')
  }
  throw new LocalDataError('expired', 'Google sign-in timed out. Try again.')
}
