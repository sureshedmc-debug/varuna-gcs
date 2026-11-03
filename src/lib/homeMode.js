// Simple / Expert view of the app. Simple (the default) is for first-time
// operators: Home shows one guided path and plain words, and the full
// dashboard folds away. Expert is the original Home, unchanged.

import { useSyncExternalStore } from 'react'

const KEY = 'varuna.homeMode'
const subs = new Set()

let mode = (() => {
  try {
    return localStorage.getItem(KEY) === 'expert' ? 'expert' : 'simple'
  } catch {
    return 'simple'
  }
})()

export function setHomeMode(next) {
  mode = next === 'expert' ? 'expert' : 'simple'
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* private mode: kept for this session */
  }
  subs.forEach((fn) => fn())
}

export function useHomeMode() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => mode,
  )
}
