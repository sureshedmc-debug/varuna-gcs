// Whether this PC has an internet connection, as the OS reports it. The app
// works offline; this only greys out the few extras that need the internet
// (Google sign-in, the cloud assistant and detector, email alerts, map
// downloads).

import { useSyncExternalStore } from 'react'

function subscribe(fn) {
  window.addEventListener('online', fn)
  window.addEventListener('offline', fn)
  return () => {
    window.removeEventListener('online', fn)
    window.removeEventListener('offline', fn)
  }
}

export const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)

export function useOnline() {
  return useSyncExternalStore(subscribe, isOnline, () => true)
}
