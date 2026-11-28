// The "Download the VARUNA app" dialog: Android, Windows, or install on this
// device. The option for the visitor's own device comes first.
//
// Only visitors signed in with a Google (Gmail) account get the files; everyone
// else is asked to sign in with Google first, and comes back to this dialog.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE, Icon } from './parts'
import { M } from './content'
import { useDownloads, useDownloadsOpen, openDownloads, closeDownloads, mb, canDownload, AFTER_SIGN_IN } from './downloads'
import { useUser, logout } from '../lib/auth'
import { navigate } from './router'
import { useInstall, promptInstall, platform, isStandalone } from './pwa'

function Option({ icon, title, sub, href, onClick, disabled, badge, primary }) {
  const body = (
    <>
      <span className="vs-dl-ic"><Icon name={icon} size={22} /></span>
      <span className="vs-dl-txt">
        <b>{title}{badge && <em>{badge}</em>}</b>
        <small>{sub}</small>
      </span>
      <span className="vs-dl-go"><Icon name={disabled ? 'x' : 'download'} size={18} /></span>
    </>
  )
  const cls = `vs-dl-opt${primary ? ' primary' : ''}${disabled ? ' off' : ''}`
  if (href && !disabled) return <a className={cls} href={href} rel="noopener">{body}</a>
  return <button type="button" className={cls} onClick={onClick} disabled={disabled}>{body}</button>
}

export default function DownloadDialog() {
  const open = useDownloadsOpen()
  const dl = useDownloads()
  const install = useInstall()
  const os = platform()
  const [how, setHow] = useState(false)
  const user = useUser()
  const allowed = canDownload(user)

  // Back from the Google sign-in started below: open the dialog again.
  useEffect(() => {
    if (window.location.hash !== '#' + AFTER_SIGN_IN) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    if (allowed) openDownloads()
  }, [allowed])

  function signInWithGoogle() {
    closeDownloads()
    if (user) logout() // signed in with a password: Google is needed for downloads
    navigate(`/login?next=` + encodeURIComponent(`/#${AFTER_SIGN_IN}`))
  }

  useEffect(() => {
    if (!open) return
    setHow(false)
    const key = (e) => e.key === 'Escape' && closeDownloads()
    window.addEventListener('keydown', key)
    document.documentElement.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', key)
      document.documentElement.style.overflow = ''
    }
  }, [open])

  async function installHere() {
    if (install === 'prompt') {
      if ((await promptInstall()) === 'accepted') closeDownloads()
    } else setHow((h) => !h)
  }

  const installed = install === 'installed' || isStandalone()
  const opts = [
    {
      key: 'android', os: 'android', icon: 'phone', title: 'Android app',
      sub: dl.android ? ['APK', mb(dl.android.size), dl.version && `v${dl.version}`].filter(Boolean).join(' · ') : dl.loading ? 'Checking for the latest version…' : 'Coming soon',
      href: dl.android?.url, disabled: !dl.android,
    },
    {
      key: 'windows', os: 'desktop', icon: 'windows', title: 'Windows app',
      sub: dl.windows ? ['Installer', mb(dl.windows.size), dl.version && `v${dl.version}`].filter(Boolean).join(' · ') : dl.loading ? 'Checking for the latest version…' : 'Coming soon',
      href: dl.windows?.url, disabled: !dl.windows,
    },
    {
      key: 'web', os: '', icon: 'app', title: os === 'ios' ? 'iPhone and iPad' : 'Install on this device',
      sub: installed ? 'Already installed on this device' : 'Works everywhere · opens full screen · always up to date',
      onClick: installHere, disabled: installed,
    },
  ]
  // The visitor's own platform first, then whatever can be downloaded.
  opts.sort((a, b) => (b.os === os) - (a.os === os) || a.disabled - b.disabled)
  const firstOn = opts.findIndex((o) => !o.disabled)

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="vs-modal vs-dl-wrap" role="dialog" aria-modal="true" aria-label="Download the VARUNA app"
          onClick={(e) => e.target === e.currentTarget && closeDownloads()}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <motion.div className="vs-dl" initial={{ opacity: 0, y: 40, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.98 }} transition={{ duration: 0.5, ease: EASE }}>
            <button type="button" className="vs-dl-x" onClick={closeDownloads} aria-label="Close"><Icon name="x" size={18} /></button>
            <div className="vs-dl-head">
              <img src={M('icon-192.png')} alt="" />
              <div>
                <span className="vs-kicker">Official app</span>
                <h2>Download VARUNA AI</h2>
                <p>{dl.version ? `Latest version ${dl.version}` : 'The latest version'} · free · by Aditya Gautam &amp; Samar Garg</p>
              </div>
            </div>
            {!allowed ? (
              <div className="vs-dl-gate">
                <span className="vs-dl-lock"><Icon name="shield" size={22} /></span>
                <b>Sign in with Google to download</b>
                <p>{user
                  ? `You are signed in as ${user.email || user.username || user.name} with a password. The latest app is only for visitors signed in with a Google (Gmail) account.`
                  : 'The latest VARUNA app is free, but only for visitors signed in with their Google (Gmail) account. It takes one click.'}</p>
                <button type="button" className="vs-dl-google" onClick={signInWithGoogle}>
                  <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                  {user ? 'Switch to Google sign-in' : 'Continue with Google'}
                </button>
                <small>Choose <b>Continue with Google</b> on the next page. You come straight back here to download.</small>
              </div>
            ) : (
            <div className="vs-dl-list">
              {opts.map((o, i) => <Option key={o.key} {...o} primary={i === firstOn} badge={o.os === os && !o.disabled ? 'Your device' : ''} />)}
            </div>
            )}
            <AnimatePresence initial={false}>
              {allowed && how && (
                <motion.div className="vs-dl-how" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  {os === 'ios'
                    ? <>In Safari, tap <b>Share</b> <Icon name="share" size={14} />, then <b>Add to Home Screen</b>.</>
                    : os === 'android'
                      ? <>In Chrome, tap the <b>⋮</b> menu, then <b>Install app</b> (or <b>Add to Home screen</b>).</>
                      : <>In Chrome or Edge, click the <b>install icon</b> at the right of the address bar, or open the <b>⋮</b> menu and choose <b>Install VARUNA AI</b>.</>}
                </motion.div>
              )}
            </AnimatePresence>
            {allowed && dl.version && <a className="vs-dl-all" href={dl.page} target="_blank" rel="noopener noreferrer">All versions and release notes →</a>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
