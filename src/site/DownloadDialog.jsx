// The "Download the VARUNA app" dialog: Android, Windows, or install on this
// device. The option for the visitor's own device comes first.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE, Icon } from './parts'
import { M } from './content'
import { useDownloads, useDownloadsOpen, closeDownloads, mb } from './downloads'
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
                <p>{dl.version ? `Latest version ${dl.version}` : 'The latest version'} · free · by Aditya Gautam</p>
              </div>
            </div>
            <div className="vs-dl-list">
              {opts.map((o, i) => <Option key={o.key} {...o} primary={i === firstOn} badge={o.os === os && !o.disabled ? 'Your device' : ''} />)}
            </div>
            <AnimatePresence initial={false}>
              {how && (
                <motion.div className="vs-dl-how" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  {os === 'ios'
                    ? <>In Safari, tap <b>Share</b> <Icon name="share" size={14} />, then <b>Add to Home Screen</b>.</>
                    : os === 'android'
                      ? <>In Chrome, tap the <b>⋮</b> menu, then <b>Install app</b> (or <b>Add to Home screen</b>).</>
                      : <>In Chrome or Edge, click the <b>install icon</b> at the right of the address bar, or open the <b>⋮</b> menu and choose <b>Install VARUNA AI</b>.</>}
                </motion.div>
              )}
            </AnimatePresence>
            {dl.version && <a className="vs-dl-all" href={dl.page} target="_blank" rel="noopener noreferrer">All versions and release notes →</a>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
