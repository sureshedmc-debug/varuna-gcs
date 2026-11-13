// "Download the VARUNA app": where the newest app files are.
//
// The newest GitHub release of the project is read at run time, so publishing
// a new release (with the .apk and/or .exe attached) updates the website's
// download button with no rebuild. VITE_DOWNLOAD_ANDROID / VITE_DOWNLOAD_WINDOWS,
// when set on Vercel, take priority. With neither, the button installs the
// website itself as an app (see pwa.js).
import { useEffect, useSyncExternalStore, useState } from 'react'
import { DOWNLOADS } from './pwa'

const REPO = import.meta.env.VITE_RELEASES_REPO || 'sureshedmc-debug/varuna-gcs'
const CACHE = 'varuna.latestRelease'
const RELEASES = `https://github.com/${REPO}/releases`

let request = null

function fromCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE))
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.data
  } catch {
    /* none */
  }
  return undefined
}

/** The newest release: { version, date, android?, windows?, page } or null. */
function loadRelease() {
  const cached = fromCache()
  if (cached !== undefined) return Promise.resolve(cached)
  request ||= fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) return null
      const assets = (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
      const pick = (re) => assets.find((a) => re.test(a.name))
      const data = {
        version: (j.tag_name || '').replace(/^v/i, ''),
        date: j.published_at || '',
        page: j.html_url || RELEASES,
        android: pick(/\.apk$/i) || null,
        windows: pick(/setup.*\.exe$/i) || pick(/\.exe$/i) || pick(/\.msi$/i) || null,
      }
      try {
        sessionStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), data }))
      } catch {
        /* private mode */
      }
      return data
    })
    .catch(() => null)
  return request
}

/** { loading, version, date, page, android, windows } — each file is { url, size?, name? } or null. */
export function useDownloads() {
  const [rel, setRel] = useState(fromCache)
  useEffect(() => {
    let live = true
    loadRelease().then((d) => live && setRel(d))
    return () => {
      live = false
    }
  }, [])
  const android = DOWNLOADS.android ? { url: DOWNLOADS.android } : rel?.android || null
  const windows = DOWNLOADS.windows ? { url: DOWNLOADS.windows } : rel?.windows || null
  return { loading: rel === undefined, version: rel?.version || '', date: rel?.date || '', page: rel?.page || RELEASES, android, windows }
}

export const mb = (bytes) => (bytes ? `${Math.round(bytes / 1048576)} MB` : '')

// Open / close the download dialog from anywhere on the site.
let open = false
const subs = new Set()
export function openDownloads() {
  open = true
  subs.forEach((fn) => fn())
}
export function closeDownloads() {
  open = false
  subs.forEach((fn) => fn())
}
export function useDownloadsOpen() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => open,
  )
}
