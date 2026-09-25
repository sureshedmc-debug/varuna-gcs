import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSystem } from './SystemContext'
import { SwipeConfirm } from './ui'
import VarunaOrb from './VarunaOrb'
import { useLivePosition, useLaptopGps, useHomePoint } from '../hooks/useLaptopGps'
import { createAssistantChat } from '../lib/assistant/assistantChat'
import { getGroqKey, setGroqKey, groqTranscribe } from '../lib/assistant/groqClient'
import { listenUntilSilence, speak, stopSpeaking } from '../lib/assistant/voice'
import { createWakeListener, wakeWordSupported } from '../lib/assistant/wakeWord'

// VARUNA voice co-pilot — a small floating orb (Copilot-style), not a window.
// Say "Hi Varuna" (or tap ✨ in the top bar): the orb rises at the bottom of the
// screen, greets you, listens, does the task (plan missions, answer, request
// flight commands behind the swipe-to-confirm), and keeps the conversation going
// until you stop talking — then it tucks itself away again.

const TOOL_CAPTION = {
  get_app_status: 'Checking the drone…',
  navigate: 'Opening the tab…',
  get_detections_summary: 'Reading the detections…',
  plan_mission: 'Finding the lake & planning the path…',
  plan_hotspot_mission: 'Finding the worst trash hotspots…',
  get_mission_debrief: 'Putting together the debrief…',
  query_trash_history: 'Checking the trash history…',
  request_flight_command: 'Swipe on the screen to confirm…',
}
// Where the orb sits per tab — always above that tab's bottom controls (never over STOP).
const BOTTOM = { home: 70, live: 232, mission: 172, detections: 24, system: 24 }
// Note: plain "stop" is NOT here — it's the emergency-stop flight command.
const DISMISS_RE = /^(bye|goodbye|bye bye|thank you|thanks|thank u|that'?s all|stop listening|go to sleep|sleep|bas|bas karo|ok bye|nothing|no thanks|dhanyavaad|shukriya)[.! ]*$/i

function greeting() {
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return `${part}! I'm Varuna. What would you like to do today?`
}

export default function VoiceAssistant({ tab, wakeSignal, wakeWordOn, onWakeState }) {
  const { telemetry, simulated, backendReachable } = useSystem()
  const live = useLivePosition(telemetry.data)
  const laptop = useLaptopGps(true)
  const homePoint = useHomePoint(telemetry.data, live, simulated)

  const [awake, setAwake] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | listening | transcribing | thinking | speaking | nokey | error
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)

  const levelRef = useRef(0)
  const sessionRef = useRef(0) // bumps on every wake/sleep: stale async steps bail out
  const turnSidRef = useRef(-1) // session that owns the chat turn currently running tools
  const listenRef = useRef(null)
  const wakeRef = useRef(null)
  const awakeRef = useRef(false)
  const lastConfirmRef = useRef(null)
  if (confirm) lastConfirmRef.current = confirm
  const shown = confirm || lastConfirmRef.current

  // Live app state for the assistant's tools.
  const ctxRef = useRef({})
  ctxRef.current = {
    telemetry: telemetry.data,
    simulated,
    backendReachable,
    live,
    laptopPos: laptop.pos ? [laptop.pos.lat, laptop.pos.lng] : null,
    homePoint,
    tab,
    requestConfirm,
    // Tools from a turn the operator has since dismissed/interrupted must not act.
    active: () => awakeRef.current && turnSidRef.current === sessionRef.current,
  }
  const chatRef = useRef(null)
  if (!chatRef.current) {
    chatRef.current = createAssistantChat(
      () => ctxRef.current,
      (ev) => {
        if (ev.type === 'tool') setSaid(TOOL_CAPTION[ev.name] || 'Working on it…')
      },
    )
  }

  useEffect(() => {
    const f = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])

  // ---- wake word ("Hi Varuna") in the background while asleep ----
  useEffect(() => {
    if (!wakeWordOn || !wakeWordSupported) {
      onWakeState?.(wakeWordSupported ? 'off' : 'unsupported')
      return undefined
    }
    const w = createWakeListener({ onWake: ({ rest }) => wake(rest), onState: (s) => onWakeState?.(s) })
    wakeRef.current = w
    if (awakeRef.current) w?.pause()
    return () => {
      w?.stop()
      wakeRef.current = null
    }
  }, [wakeWordOn]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tap-to-wake from the top bar.
  const firstSignal = useRef(wakeSignal)
  useEffect(() => {
    if (wakeSignal === firstSignal.current) return
    if (awakeRef.current) sleep()
    else wake('')
  }, [wakeSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stopEverything(), []) // eslint-disable-line react-hooks/exhaustive-deps

  function stopEverything() {
    listenRef.current?.cancel()
    listenRef.current = null
    stopSpeaking()
    levelRef.current = 0
  }

  // ---- the conversation loop ----
  async function wake(rest) {
    const sid = ++sessionRef.current
    wakeRef.current?.pause()
    awakeRef.current = true
    setAwake(true)
    setTyping(false)
    setHeard('')
    setSaid('')
    if (!getGroqKey()) {
      setPhase('nokey')
      setSaid('Add your Groq API key to wake me up.')
      return
    }
    if (rest && rest.split(/\s+/).length >= 2) return handle(rest, sid) // "Hi Varuna, plan a mission for this lake"
    await say(greeting(), sid)
    if (sid === sessionRef.current) listen(sid, false)
  }

  function sleep() {
    sessionRef.current++
    stopEverything()
    awakeRef.current = false
    setAwake(false)
    setPhase('idle')
    setConfirm((c) => {
      c?.finish('cancelled')
      return null
    })
    setTimeout(() => {
      if (!awakeRef.current) wakeRef.current?.resume()
    }, 600)
  }

  async function say(text, sid) {
    if (sid !== sessionRef.current) return
    setPhase('speaking')
    setSaid(text)
    // Speaking animation: a gentle random "mouth" plus a kick on every word.
    const iv = setInterval(() => {
      levelRef.current = Math.max(levelRef.current, 0.25 + Math.random() * 0.35)
    }, 160)
    try {
      await speak(text, { onWord: () => (levelRef.current = 0.75 + Math.random() * 0.25) })
    } finally {
      clearInterval(iv)
      levelRef.current = 0
    }
  }

  async function listen(sid, followUp) {
    if (sid !== sessionRef.current) return
    setPhase('listening')
    let clip
    listenRef.current?.cancel() // never two recordings at once
    const l = listenUntilSilence({ onLevel: (v) => (levelRef.current = v), startTimeoutMs: followUp ? 6000 : 8000 })
    listenRef.current = l
    try {
      clip = await l.done
    } catch (e) {
      if (sid !== sessionRef.current) return
      setPhase('error')
      setSaid(`Microphone unavailable — allow mic access. (${e?.message || e})`)
      return
    } finally {
      if (listenRef.current === l) listenRef.current = null
    }
    if (sid !== sessionRef.current) return
    if (!clip) {
      // Nothing said: end quietly after a follow-up, or say so after the greeting.
      if (!followUp) await say("I didn't catch that. Say “Hi Varuna” whenever you need me.", sid)
      if (sid === sessionRef.current) sleep()
      return
    }
    setPhase('transcribing')
    setSaid('')
    let text
    try {
      text = await groqTranscribe(clip.blob)
    } catch (e) {
      return fail(e, sid)
    }
    if (sid !== sessionRef.current) return
    if (!text) return listen(sid, true)
    handle(text, sid)
  }

  async function handle(text, sid) {
    if (sid !== sessionRef.current) return
    setHeard(text)
    if (DISMISS_RE.test(text.trim())) {
      await say('Okay! Say “Hi Varuna” whenever you need me.', sid)
      if (sid === sessionRef.current) sleep()
      return
    }
    setPhase('thinking')
    setSaid('')
    let reply
    try {
      turnSidRef.current = sid
      reply = await chatRef.current.send(text)
    } catch (e) {
      return fail(e, sid)
    }
    await say(reply, sid)
    // Keep the conversation going, like Copilot: listen for a follow-up.
    if (sid === sessionRef.current) listen(sid, true)
  }

  async function fail(e, sid) {
    if (sid !== sessionRef.current) return
    const msg = String(e?.message || e)
    const line =
      msg === 'NO_KEY'
        ? 'Add your Groq API key first.'
        : /Groq 401/.test(msg)
          ? 'Groq rejected the API key. Please check it.'
          : /Groq 429/.test(msg)
            ? 'I am being rate-limited. Try again in a few seconds.'
            : 'I could not reach my AI service. Check the internet connection.'
    setPhase('error')
    await say(line, sid)
    if (sid === sessionRef.current) setPhase('error')
  }

  // Opens the swipe-to-confirm pop-up for ONE request (see Assistant review notes):
  // resolves 'confirmed' | 'cancelled' | 'timeout'; the voice can never confirm by itself.
  function requestConfirm(cmdKey, detail) {
    return new Promise((resolve) => {
      if (!ctxRef.current.active()) return resolve('cancelled') // Varuna was dismissed/interrupted
      const req = { cmd: cmdKey, detail, openId: Date.now() + Math.random(), done: false, swiped: false }
      req.finish = (v) => {
        if (req.done) return
        req.done = true
        clearTimeout(req.timer)
        resolve(v)
      }
      req.timer = setTimeout(() => {
        if (req.swiped) return
        setConfirm((c) => (c === req ? null : c))
        req.finish('timeout')
      }, 90000)
      setConfirm(req)
    })
  }

  function submitTyped(e) {
    e.preventDefault()
    const t = typed.trim()
    if (!t || phase === 'thinking' || phase === 'transcribing') return
    setTyped('')
    setTyping(false)
    stopEverything()
    const sid = ++sessionRef.current
    handle(t, sid)
  }

  function tapOrb() {
    // Tap the orb to talk now (interrupts speaking), or retry after an error.
    const sid = ++sessionRef.current
    stopEverything()
    listen(sid, false)
  }

  function saveKey(e) {
    e.preventDefault()
    if (!keyDraft.trim()) return
    setGroqKey(keyDraft.trim())
    setKeyDraft('')
    wake('')
  }

  const orbMode = phase === 'transcribing' ? 'thinking' : phase === 'nokey' ? 'idle' : phase
  const status =
    phase === 'listening' ? 'Listening…' : phase === 'transcribing' || phase === 'thinking' ? 'Thinking…' : phase === 'speaking' ? 'Varuna' : phase === 'error' ? 'Tap the orb to try again' : ''
  const bottom = (BOTTOM[tab] ?? 24) + (mobile && (tab === 'detections' || tab === 'system') ? 72 : 0)

  return (
    <>
      <AnimatePresence>
        {awake && (
          <motion.div
            key="orb"
            initial={{ opacity: 0, y: 40, scale: 0.6 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.6 }}
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-2 md:pl-[80px]"
            style={{ bottom }}
            role="dialog"
            aria-label="Varuna voice assistant"
          >
            <div
              className="pointer-events-auto flex w-[min(92vw,520px)] items-center gap-3 rounded-[28px] py-2 pl-2 pr-3 shadow-elev"
              style={{ background: 'rgba(12,14,18,0.82)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(18px)' }}
            >
              <button type="button" onClick={tapOrb} title="Tap to talk" className="shrink-0 rounded-full focus:outline-none">
                <VarunaOrb mode={orbMode} levelRef={levelRef} size={mobile ? 64 : 76} />
              </button>

              <div className="min-w-0 flex-1">
                {phase === 'nokey' ? (
                  <form onSubmit={saveKey} className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted">{said} Free at console.groq.com.</span>
                    <div className="flex gap-1.5">
                      <input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} type="password" placeholder="gsk_…" className="inp min-w-0 flex-1 px-2 py-1 text-xs" />
                      <button className="rounded-md bg-accent px-2.5 text-xs font-bold text-white">Save</button>
                    </div>
                  </form>
                ) : typing ? (
                  <form onSubmit={submitTyped} className="flex gap-1.5">
                    <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type to Varuna…" className="inp min-w-0 flex-1 px-2.5 py-1.5 text-sm" />
                    <button disabled={phase === 'thinking' || phase === 'transcribing'} className="rounded-md bg-accent px-2.5 text-xs font-bold text-white disabled:opacity-40">Send</button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest" style={{ color: phase === 'error' ? '#FF9F0A' : 'var(--accent-hex)' }}>
                      {status}
                      {phase === 'listening' && (
                        <span className="flex h-3 items-end gap-[2px]">
                          {[0, 1, 2, 3].map((i) => (
                            <motion.span key={i} className="w-[2px] rounded bg-current" animate={{ height: [3, 11, 5, 9, 3] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12 }} />
                          ))}
                        </span>
                      )}
                    </div>
                    {heard && <div className="truncate text-[11px] text-muted">You: “{heard}”</div>}
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={said}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="line-clamp-3 text-[13px] leading-snug text-ink"
                      >
                        {said || (phase === 'listening' ? 'Go ahead, I’m listening.' : '')}
                      </motion.div>
                    </AnimatePresence>
                  </>
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-1">
                <button type="button" onClick={() => setTyping((v) => !v)} title="Type instead" className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-ink">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8" /></svg>
                </button>
                <button type="button" onClick={sleep} title="Close" className="flex h-7 w-7 items-center justify-center rounded-full text-lg leading-none text-muted hover:bg-white/10 hover:text-ink">
                  ×
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Flight commands the assistant asks for still need the operator's swipe. */}
      <SwipeConfirm
        open={!!confirm}
        openId={shown?.openId}
        cmd={shown?.cmd || 'rth'}
        detail={shown?.detail}
        onSwiped={() => shown && (shown.swiped = true)}
        onCancel={() => shown?.finish('cancelled')}
        onClose={() => setConfirm(null)}
        onConfirm={() => shown?.finish('confirmed')}
      />
    </>
  )
}
