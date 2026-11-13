// The public website (Vercel build, `--mode site`):
//   /            → home: Open the app / Explore Varuna, then the whole
//                  project, ending with feedback (/explore shows the same)
//   /try         → try the plastic detector on your own webcam, no sign-in
//   /login       → sign in (then back to ?next=)
//   /app         → the app's own cinematic intro, then the ground-control app
//                  for signed-in users (sign-in first otherwise), with the
//                  "install the official app" card sliding up
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import IntroScreen from '../screens/IntroScreen'
import { SystemProvider } from '../components/SystemContext'
import { BoatProvider } from '../components/BoatContext'
import LoginPage from '../components/launch/LoginPage'
import { ArrowLeft } from '../components/launch/icons'
import '../components/launch/launch.css'
import { useUser } from '../lib/auth'
import { usePath, navigate } from './router'
import { setupPwa, isStandalone } from './pwa'
import Explore from './Explore'
import Try from './Try'
import InstallSheet from './InstallSheet'
import DownloadDialog from './DownloadDialog'
import './site.css'

setupPwa()

const TITLES = {
  '/': 'VARUNA AI GCS by Aditya Gautam · AI drone and river-cleaning boat',
  '/explore': 'VARUNA AI GCS by Aditya Gautam · AI drone and river-cleaning boat',
  '/try': 'Try the AI on your webcam · VARUNA AI',
  '/login': 'Log in · VARUNA AI',
  '/app': 'VARUNA AI · Ground Control',
}

/** Where to go after signing in: a path on this site only. */
function nextPath() {
  const n = new URLSearchParams(window.location.search).get('next') || '/'
  return /^\/(?!\/)[\w\-/#]*$/.test(n) && n !== '/login' ? n : '/'
}

/** The app's own full-screen sign-in, with a way back to the website. */
function SignIn({ note, onBack }) {
  return (
    <SystemProvider>
      <BoatProvider>
        <div className="varuna-home vl-layer full">
          <div className="vl-page full" role="main">
            <button type="button" className="vl-back" onClick={onBack}><ArrowLeft /> Back</button>
            {note && <div className="vs-gate-note"><i /> {note}</div>}
            <LoginPage onOpen={null} onClose={onBack} />
          </div>
        </div>
      </BoatProvider>
    </SystemProvider>
  )
}

function LoginRoute() {
  const user = useUser()
  useEffect(() => {
    if (user) navigate(nextPath(), { replace: true })
  }, [user])
  if (user) return null
  return <SignIn onBack={() => (window.history.length > 1 ? window.history.back() : navigate('/'))} />
}

function AppRoute({ renderApp }) {
  const user = useUser()
  // Opening the app plays its intro each time; the installed app goes straight in.
  const [intro, setIntro] = useState(() => !isStandalone())
  if (intro) return <IntroScreen onActivate={() => setIntro(false)} />
  if (!user) return <SignIn note="Sign in to open the VARUNA app" onBack={() => navigate('/')} />
  return (
    <>
      {renderApp(() => navigate('/'))}
      <InstallSheet />
    </>
  )
}

export default function SiteApp({ renderApp }) {
  const path = usePath()

  useEffect(() => {
    document.title = TITLES[path] || TITLES['/']
  }, [path])

  if (path === '/app') return <AppRoute renderApp={renderApp} />
  if (path === '/login') return <LoginRoute />

  return (
    <div className="vs">
      <div className="vs-grain" aria-hidden="true" />
      <motion.div key={path === '/try' ? 'try' : 'home'} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
        {path === '/try' ? <Try /> : <Explore />}
      </motion.div>
      <DownloadDialog />
    </div>
  )
}
