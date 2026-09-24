import { useEffect, useState, lazy, Suspense } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ToastProvider } from './components/Toast'
import { SystemProvider, useSystem } from './components/SystemContext'
import { WarningBanner, deriveWarnings } from './components/WarningBanner'
import { PinGate, getStoredSession } from './components/PinGate'
import { Rail } from './components/Rail'
import { TopBar } from './components/TopBar'
import { registerNavigator } from './lib/planDraftStore'

const Assistant = lazy(() => import('./components/Assistant'))
import IntroScreen from './screens/IntroScreen'
import MissionControlScreen from './screens/MissionControlScreen'
import SystemScreen from './screens/SystemScreen'

// Lazy load heavy screens with AI models
const LiveScreen = lazy(() => import('./screens/LiveScreen'))
const MissionScreen = lazy(() => import('./screens/MissionScreen'))
const DetectionsScreen = lazy(() => import('./screens/DetectionsScreen'))

const SCREENS = {
  home: MissionControlScreen,
  live: LiveScreen,
  mission: MissionScreen,
  detections: DetectionsScreen,
  system: SystemScreen,
}

function Shell({ onLock }) {
  const [tab, setTab] = useState('home')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const { pi, backendReachable } = useSystem()
  // Lets the AI assistant switch tabs (e.g. open Missions after planning).
  useEffect(() => registerNavigator(setTab), [])
  const Screen = SCREENS[tab]
  const warnings = deriveWarnings({ pi: pi.data, backendReachable })
  const isMap = tab === 'home'
  const fullBleed = tab === 'home' || tab === 'live' || tab === 'mission'

  return (
    <div className="relative min-h-screen">
      {!fullBleed && <div className="ambient" />}
      <TopBar onLock={onLock} onAssistant={() => setAssistantOpen((v) => !v)} assistantOpen={assistantOpen} />
      <Rail active={tab} onChange={setTab} onLock={onLock} />
      <WarningBanner warnings={warnings} />
      <main className={`relative z-10 pt-[56px] ${fullBleed ? 'px-2 pb-2 md:pl-[80px] md:pr-2' : 'px-2.5 pb-24 md:pb-4 md:pl-[86px] md:pr-4'}`}>
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ type: 'tween', ease: 'easeOut', duration: 0.2 }}
          >
            <Suspense fallback={
              <div className="flex h-[60vh] items-center justify-center">
                <div className="text-center">
                  <div className="mb-3 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" style={{ color: 'var(--accent-hex)' }} />
                  <p className="text-sm text-muted">Loading AI modules...</p>
                </div>
              </div>
            }>
              <Screen onNavigate={setTab} />
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>
      <Suspense fallback={null}>
        <Assistant open={assistantOpen} onClose={() => setAssistantOpen(false)} tab={tab} />
      </Suspense>
    </div>
  )
}

function entered() {
  try {
    return sessionStorage.getItem('varuna.entered') === '1'
  } catch {
    return false
  }
}

export default function App() {
  const [active, setActive] = useState(entered())
  const [session, setSession] = useState(getStoredSession())

  // Intro / activation screen first. Click anywhere → activate → home page.
  if (!active) {
    return (
      <IntroScreen
        onActivate={() => {
          try {
            sessionStorage.setItem('varuna.entered', '1')
          } catch {
            /* private mode */
          }
          setActive(true)
        }}
      />
    )
  }

  if (!session) return <PinGate onUnlock={setSession} />

  function lock() {
    try {
      sessionStorage.removeItem('varuna.entered')
    } catch {
      /* private mode */
    }
    setActive(false)
  }

  return (
    <ToastProvider>
      <SystemProvider>
        <Shell onLock={lock} />
      </SystemProvider>
    </ToastProvider>
  )
}
