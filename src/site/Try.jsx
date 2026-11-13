// /try — anyone can test VARUNA's plastic detection with their own webcam,
// no sign-in. The same detector as the app's Live tab, running in the browser.
import { lazy, Suspense } from 'react'
import { motion } from 'framer-motion'
import { EASE, Icon, Nav, Footer } from './parts'
import { navigate } from './router'
import { useRecommendedConf } from '../components/BackgroundDetect'

const WebcamDetect = lazy(() => import('../components/WebcamDetect'))

const TIPS = [
  ['1', 'Start the camera', 'Press Start and allow the camera. On a phone the back camera is used.'],
  ['2', 'Show it plastic', 'A bottle, a wrapper, a bag or a cup. Hold it 30–100 cm from the camera.'],
  ['3', 'Watch the boxes', 'Each find gets a box and a confidence. People are recognised too, and never counted as plastic.'],
]

export default function Try() {
  const [conf] = useRecommendedConf()
  return (
    <>
      <Nav active="/try" />
      <section className="vs-try">
        <div className="vs-wrap">
          <motion.div className="vs-try-head" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: EASE, delay: 0.2 }}>
            <span className="vs-kicker">Live demo · no sign-in</span>
            <h1 className="vs-h2">Try the AI on <span className="vs-grad">your webcam.</span></h1>
            <p className="vs-lead">
              This is the same detector that runs on VARUNA's drone feed, trained to find floating plastic.
              It runs entirely in your browser: your video never leaves your device.
            </p>
          </motion.div>

          <motion.div className="vs-try-stage" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease: EASE, delay: 0.35 }}>
            <Suspense fallback={<div className="vs-try-wait">Loading the AI…</div>}>
              <WebcamDetect confThr={conf} demo />
            </Suspense>
          </motion.div>

          <div className="vs-try-tips">
            {TIPS.map(([n, t, s]) => (
              <div key={n} className="vs-try-tip"><i>{n}</i><b>{t}</b><span>{s}</span></div>
            ))}
          </div>
          <p className="vs-try-note">
            The first visit downloads the AI models (about 60 MB), then they are cached. Works best in Chrome or Edge.
          </p>
          <div className="vs-try-cta">
            <button type="button" className="vs-btn primary" onClick={() => navigate('/app')}>Open the full app <Icon name="arrow" size={16} className="arrow" /></button>
            <button type="button" className="vs-btn ghost" onClick={() => navigate('/#how')}>How VARUNA works</button>
          </div>
        </div>
      </section>
      <Footer />
    </>
  )
}
