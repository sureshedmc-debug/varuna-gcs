// Installing VARUNA AI as an app from the website (Add to Home Screen /
// Install app). Website build only: SiteApp calls setupPwa() once.
import { useSyncExternalStore } from 'react'

let deferred = null // the browser's install prompt, kept until the user asks for it
let installed = false
const subs = new Set()
const notify = () => subs.forEach((fn) => fn())

export function setupPwa() {
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = Object.assign(document.createElement('link'), { rel: 'manifest', href: '/site/manifest.webmanifest' })
    document.head.appendChild(link)
    const apple = Object.assign(document.createElement('link'), { rel: 'apple-touch-icon', href: '/site/icon-192.png' })
    document.head.appendChild(apple)
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // we show our own sheet instead of the browser's mini bar
    deferred = e
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = null
    notify()
  })
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
  }
}

/** Running as the installed app (opened from the home screen / Start menu). */
export function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  } catch {
    return false
  }
}

export function platform() {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

/** { canPrompt, installed } — re-renders when the browser offers or finishes an install. */
export function useInstall() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => (deferred ? 'prompt' : installed ? 'installed' : 'none'),
  )
}

/** Show the browser's own install dialog. Resolves 'accepted' | 'dismissed' | 'unavailable'. */
export async function promptInstall() {
  if (!deferred) return 'unavailable'
  const e = deferred
  deferred = null
  notify()
  e.prompt()
  const { outcome } = await e.userChoice
  if (outcome === 'accepted') {
    installed = true
    notify()
  }
  return outcome
}

// Optional direct downloads of the native apps, set at build time on Vercel.
export const DOWNLOADS = {
  android: import.meta.env.VITE_DOWNLOAD_ANDROID || '',
  windows: import.meta.env.VITE_DOWNLOAD_WINDOWS || '',
}
