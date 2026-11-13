// The public website (Vercel build, `--mode site`):
//   first visit  → the app's own cinematic intro
//   /            → landing: Open the app / Explore Varuna
//   /explore     → the whole project, ending with feedback
//   /login       → sign in (then back to ?next=)
//   /app         → the ground-control app, signed-in users only, with the
//                  "install the official app" card sliding up
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import IntroScreen from '../screens/IntroScreen'
import { SystemProvider } from '../components/SystemContext'
import { BoatProvider } from '../components/BoatContext'
import LoginPage from '../components/launch/LoginPage'
import { ArrowLeft } from '../components/launch/icons'
import '../components/launch/launch.css'
import { useUser } from '../lib/auth'
import { usePath, navigate } from './router'
import { setupPwa, isStandalone } from './pwa'
import Landing from './Landing'
import Explore from './Explore'
import InstallSheet from './InstallSheet'
import './site.css'

setupPwa()

const INTRO_KEY = 'varuna.siteIntro'
function introSeen() {
  if (isStandalone()) return true // opened as the installed app: straight in
  try {
    return sessionStorage.getItem(INTRO_KEY) === '1'
  } catch {
    return false
  }
}

const TITLES = {
  '/': 'VARUNA AI · AI drone and autonomous boat for cleaner rivers',
  '/explore': 'Explore Varuna · VARUNA AI',
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
  const [intro, setIntro] = useState(() => !introSeen())

  useEffect(() => {
    document.title = TITLES[path] || TITLES['/']
  }, [path])

  if (intro) {
    return (
      <IntroScreen
        onActivate={() => {
          try {
            sessionStorage.setItem(INTRO_KEY, '1')
          } catch {
            /* private mode */
          }
          setIntro(false)
        }}
      />
    )
  }

  if (path === '/app') return <AppRoute renderApp={renderApp} />
  if (path === '/login') return <LoginRoute />

  return (
    <div className="vs">
      <div className="vs-grain" aria-hidden="true" />
      <AnimatePresence mode="wait">
        <motion.div key={path} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.45 }}>
          {path === '/explore' ? <Explore /> : <Landing />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
