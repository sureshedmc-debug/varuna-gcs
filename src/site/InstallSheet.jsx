// The "get the official app" card that slides up from the bottom once a
// signed-in user opens the app from the website.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from './parts'
import { M } from './content'
import { useInstall, promptInstall, isStandalone, platform, DOWNLOADS } from './pwa'

const KEY = 'varuna.installSheet' // closed for this visit

function closedThisVisit() {
  try {
    return sessionStorage.getItem(KEY) === 'closed'
  } catch {
    return false
  }
}

export default function InstallSheet() {
  const state = useInstall()
  const os = platform()
  const [open, setOpen] = useState(false)
  const [how, setHow] = useState(false)

  useEffect(() => {
    if (isStandalone() || closedThisVisit()) return
    const t = setTimeout(() => setOpen(true), 1400)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    if (state === 'installed') setOpen(false)
  }, [state])

  function close() {
    setOpen(false)
    try {
      sessionStorage.setItem(KEY, 'closed')
    } catch {
      /* private mode */
    }
  }

  async function install() {
    if (state === 'prompt') {
      const r = await promptInstall()
      if (r === 'accepted') close()
      return
    }
    setHow((h) => !h)
  }

  const hasDownloads = DOWNLOADS.android || DOWNLOADS.windows

  return (
    <AnimatePresence>
      {open && (
        <div className="vs-sheet-wrap">
          <motion.div className="vs-sheet" role="dialog" aria-label="Install the VARUNA AI app"
            initial={{ y: '120%', opacity: 0.6 }} animate={{ y: 0, opacity: 1 }} exit={{ y: '130%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 210, damping: 26 }}
            drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, i) => (i.offset.y > 80 || i.velocity.y > 500) && close()}>
            <div className="vs-sheet-handle" />
            <button type="button" className="vs-sheet-x" onClick={close} aria-label="Not now"><Icon name="x" size={16} stroke={2.2} /></button>
            <div className="vs-sheet-top">
              <img src={M('icon-192.png')} alt="" />
              <div>
                <b>Install VARUNA AI</b>
                <span>Get the official app on your {os === 'desktop' ? 'computer' : 'phone'} for the full experience.</span>
                <small><Icon name="shield" size={12} /> Official app · free · opens full screen</small>
              </div>
            </div>
            <button type="button" className="vs-sheet-go" onClick={install}>
              <Icon name="download" size={18} stroke={2.2} /> {state === 'prompt' ? 'Install' : how ? 'Hide steps' : 'Install'}
            </button>
            {hasDownloads && (
              <div className="vs-sheet-alt">
                {DOWNLOADS.android && <a href={DOWNLOADS.android} rel="noopener"><Icon name="phone" size={16} /> Android app</a>}
                {DOWNLOADS.windows && <a href={DOWNLOADS.windows} rel="noopener"><Icon name="windows" size={15} /> Windows app</a>}
              </div>
            )}
            <AnimatePresence initial={false}>
              {how && (
                <motion.div className="vs-sheet-how" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  {os === 'ios' ? (
                    <>To add VARUNA AI to your iPhone or iPad:
                      <ol><li>Tap <b>Share</b> <Icon name="share" size={14} /> in Safari's toolbar.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol></>
                  ) : os === 'android' ? (
                    <>In Chrome:<ol><li>Tap the <b>⋮</b> menu at the top right.</li><li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li></ol></>
                  ) : (
                    <>In Chrome or Edge:<ol><li>Click the <b>install icon</b> at the right end of the address bar, or open the <b>⋮</b> menu.</li><li>Choose <b>Install VARUNA AI</b>.</li></ol></>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
