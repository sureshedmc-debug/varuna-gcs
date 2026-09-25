import { useEffect, useState } from 'react'

/** Live `window.matchMedia(query).matches` (re-renders only when it flips). */
export function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on)
    return () => (mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on))
  }, [query])
  return matches
}

/** Tailwind's `md` breakpoint (≥ 768 px). */
export const useIsDesktop = () => useMediaQuery('(min-width: 768px)')
