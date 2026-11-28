import { useSyncExternalStore } from 'react'

/**
 * The VARUNA Assistant's shared "brain state": one robot, shown in the corner
 * dock on every tab and big on the Boat Vision tab, always in the same mood.
 *
 *   mood      what the robot looks like right now (idle | listening | thinking | speaking | happy | alert | sleep | error)
 *   gesture   a one-shot move { name, id } (wave | nod | shake | bounce | alert)
 *   caption   the line it is saying / doing
 *   feed      boat messages, newest first (text, level, kind, t)
 *   muted     boat messages pop up but are not spoken
 *   awake     a conversation is open
 *
 * `botLevel.current` (0..1) is its voice level, read every frame by the robot.
 */

export const botLevel = { current: 0 }

const MUTE_KEY = 'varuna.bot.muted'
const DEMO_KEY = 'varuna.bot.demo'
const readFlag = (k) => {
  try {
    return localStorage.getItem(k) === '1'
  } catch {
    return false
  }
}
const writeFlag = (k, on) => {
  try {
    localStorage.setItem(k, on ? '1' : '0')
  } catch {
    /* private mode */
  }
}

let state = {
  mood: 'idle',
  gesture: null,
  caption: '',
  heard: '',
  awake: false,
  feed: [],
  popups: [],
  muted: readFlag(MUTE_KEY),
  demo: readFlag(DEMO_KEY),
  summon: { id: 0, text: '' },
  confirm: null, // { title, detail, okLabel, danger, resolve }
}
const listeners = new Set()
function set(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const l of listeners) l()
}
export const getBot = () => state
export function subscribeBot(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
/** `useBot((s) => s.mood)` re-renders only when the picked value changes. */
export function useBotState(pick = (s) => s) {
  return useSyncExternalStore(subscribeBot, () => pick(state), () => pick(state))
}

let gid = 0
export const setMood = (mood) => state.mood !== mood && set({ mood })
export const setCaption = (caption) => state.caption !== caption && set({ caption })
export const setHeard = (heard) => set({ heard })
export const setAwake = (awake) => set({ awake })
export const gesture = (name) => set({ gesture: { name, id: ++gid } })
export function setMuted(muted) {
  writeFlag(MUTE_KEY, muted)
  set({ muted })
}
export function setDemo(demo) {
  writeFlag(DEMO_KEY, demo)
  set({ demo })
}

/** Wake the assistant from anywhere; `text` (optional) is handled as if spoken. */
export function summonAssistant(text = '') {
  set({ summon: { id: state.summon.id + 1, text } })
}

// ── boat messages ────────────────────────────────────────────────────────────
const LEVEL_RANK = { bad: 3, warn: 2, ok: 1, info: 0 }
const lastByKey = new Map()
let mid = 0
const msgListeners = new Set()

/**
 * Post a message from the boat (or its AI captain).
 *   { text, level: info|ok|warn|bad, kind, key, cooldownMs, speak }
 * The same `key` within `cooldownMs` (default 20 s) is dropped, so a flapping
 * signal never floods the operator.
 */
export function postBoatMessage({ text, level = 'info', kind = 'boat', key, cooldownMs = 20000, speak = true, say, mood }) {
  if (!text) return null
  const now = Date.now()
  const k = key || text
  const prev = lastByKey.get(k)
  if (prev && now - prev < cooldownMs) return null
  lastByKey.set(k, now)
  if (lastByKey.size > 300) lastByKey.delete(lastByKey.keys().next().value)
  const msg = { id: ++mid, t: now, text, say: say || text, level, kind, speak, mood: mood || (level === 'bad' ? 'alert' : null), rank: LEVEL_RANK[level] ?? 0 }
  set((s) => ({ feed: [msg, ...s.feed].slice(0, 120), popups: [msg, ...s.popups].slice(0, 3) }))
  for (const l of msgListeners) l(msg)
  return msg
}
export function onBoatMessage(fn) {
  msgListeners.add(fn)
  return () => msgListeners.delete(fn)
}
export const dismissPopup = (id) => set((s) => ({ popups: s.popups.filter((p) => p.id !== id) }))
export const clearFeed = () => set({ feed: [], popups: [] })

// ── confirmation ("Are you sure?") for anything that moves the boat ─────────
/** Resolves true (confirmed) / false (cancelled or 60 s timeout). */
export function askConfirm({ title, detail, okLabel = 'Yes, do it', danger = false }) {
  return new Promise((resolve) => {
    state.confirm?.resolve(false)
    const timer = setTimeout(() => finish(false), 60000)
    function finish(v) {
      clearTimeout(timer)
      if (state.confirm?.resolve === finish) set({ confirm: null })
      resolve(v)
    }
    set({ confirm: { title, detail, okLabel, danger, resolve: finish } })
  })
}

/** A spoken reply from the assistant that is not part of a conversation (e.g. a tapped command). */
export const assistantSays = (text, level = 'info') =>
  postBoatMessage({ text, level, kind: 'reply', key: `reply-${Date.now()}`, cooldownMs: 0 })

// Dev builds only: a handle for automated UI checks.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  window.__varunaBot = { setDemo, setMuted, postBoatMessage, summonAssistant, gesture, getBot }
}
