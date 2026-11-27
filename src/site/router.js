// A tiny path router for the website build: /, /explore, /login, /app.
// Vercel serves index.html for every one of them (vercel.json).
import { useSyncExternalStore } from 'react'

const subs = new Set()
const notify = () => subs.forEach((fn) => fn())
window.addEventListener('popstate', notify)

function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** The current path, e.g. "/explore". */
export function usePath() {
  return useSyncExternalStore(subscribe, () => window.location.pathname.replace(/\/+$/, '') || '/')
}

/** Go to `to` ("/explore#team" scrolls to the team section once it is drawn). */
export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, window.location.origin)
  const same = url.pathname === window.location.pathname
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  notify()
  if (url.hash) scrollToId(url.hash.slice(1), same ? 'smooth' : 'auto')
  else if (!same) window.scrollTo(0, 0)
}

/** Scroll to the element with this id, waiting a moment for a new page to draw it. */
export function scrollToId(id, behavior = 'smooth') {
  let tries = 0
  const go = () => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior, block: 'start' })
    else if (tries++ < 30) setTimeout(go, 50)
  }
  go()
}

/** Props for an <a> that navigates without reloading the page. */
export function linkProps(to, after) {
  return {
    href: to,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      navigate(to)
      after?.()
    },
  }
}
