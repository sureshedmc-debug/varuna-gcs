import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSystem } from './SystemContext'
import { SwipeConfirm } from './ui'
import VarunaOrb from './VarunaOrb'
import LlmPicker from './LlmPicker'
import { useLivePosition, useLaptopGps, useHomePoint } from '../hooks/useLaptopGps'
import { createAssistantChat } from '../lib/assistant/assistantChat'
import { groqTranscribe } from '../lib/assistant/groqClient'
import { getLlmConfig, isLlmConfigReady } from '../lib/assistant/llmSettings'
import { listenUntilSilence, browserListenToText, browserSttSupported, chime, currentSttLang, noteUserText, speak, stopSpeaking } from '../lib/assistant/voice'
import VoiceSettings from './VoiceSettings'
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

// Shown under the orb right after the chime (not spoken — Varuna listens at once).
function greeting() {
  if (currentSttLang() === 'hi-IN') return ['हाँ, बोलिए।', 'जी, सुन रहा हूँ।', 'बताइए, क्या करना है?'][Math.floor(Math.random() * 3)]
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.'
  return [`${part} What can I do for you?`, 'Yes? I’m listening.', 'I’m here — go ahead.', 'At your service. What do you need?'][Math.floor(Math.random() * 4)]
}

export default function VoiceAssistant({ tab, wakeSignal, wakeWordOn, onWakeState }) {
  const { telemetry, simulated, backendReachable } = useSystem()
  const live = useLivePosition(telemetry.data)
  const laptop = useLaptopGps(true)
  const homePoint = useHomePoint(telemetry.data, live, simulated)

  const [awake, setAwake] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | listening | transcribing | thinking | speaking | noconfig | error
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const [showSettings, setShowSettings] = useState(false)
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
    if (!w) onWakeState?.('unsupported')
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
    if (!isLlmConfigReady(getLlmConfig('assistant'))) {
      setPhase('noconfig')
      setShowSettings(true)
      setSaid('Pick an AI provider to wake me up.')
      return
    }
    chime() // like Copilot: a soft tone says "I heard you", then straight to listening
    if (rest && rest.split(/\s+/).length >= 2) return handle(rest, sid) // "Varuna, plan a mission for this lake"
    setSaid(greeting())
    await new Promise((r) => setTimeout(r, 320)) // let the chime finish so the mic doesn't hear it
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
    // Whisper (Groq) if the assistant provider is Groq — its key is right
    // there and Whisper is far more accurate for Hinglish. Otherwise the
    // browser's native speech recognizer (e.g. when the operator picked
    // Gemini, OpenRouter, or a custom endpoint instead).
    const cfg = getLlmConfig('assistant')
    const useWhisper = cfg?.provider === 'groq' && !!cfg?.apiKey
    let text = null
    listenRef.current?.cancel() // never two recordings at once
    if (useWhisper) {
      const l = listenUntilSilence({ onLevel: (v) => (levelRef.current = v), startTimeoutMs: followUp ? 6000 : 8000 })
      listenRef.current = l
      let clip
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
        if (!followUp) await say('I didn’t catch that. Just say “Varuna” whenever you need me.', sid)
        if (sid === sessionRef.current) sleep()
        return
      }
      setPhase('transcribing')
      setSaid('')
      try {
        text = await groqTranscribe(clip.blob, { apiKey: cfg.apiKey })
      } catch (e) {
        return fail(e, sid)
      }
    } else if (browserSttSupported) {
      const l = browserListenToText({ onLevel: (v) => (levelRef.current = v), startTimeoutMs: followUp ? 6000 : 8000 })
      listenRef.current = l
      let result
      try {
        result = await l.done
      } catch (e) {
        if (sid !== sessionRef.current) return
        setPhase('error')
        setSaid(`Microphone unavailable — allow mic access. (${e?.message || e})`)
        return
      } finally {
        if (listenRef.current === l) listenRef.current = null
      }
      if (sid !== sessionRef.current) return
      if (!result) {
        if (!followUp) await say('I didn’t catch that. Just say “Varuna” whenever you need me.', sid)
        if (sid === sessionRef.current) sleep()
        return
      }
      text = result.text
    } else {
      // No STT at all — nudge the operator toward typing.
      setTyping(true)
      setPhase('idle')
      setSaid("This browser can't listen to voice. Type instead, or switch to a Groq provider for Whisper.")
      return
    }
    if (sid !== sessionRef.current) return
    if (!text) return listen(sid, true)
    noteUserText(text) // next listen follows the language they just used
    handle(text, sid)
  }

  async function handle(text, sid) {
    if (sid !== sessionRef.current) return
    setHeard(text)
    if (DISMISS_RE.test(text.trim())) {
      await say(/[ऀ-ॿ]/.test(text) ? 'ठीक है, ज़रूरत हो तो बस “वरुण” कहिए।' : 'Alright. Just say “Varuna” when you need me.', sid)
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
      msg === 'NO_KEY' || msg === 'NO_MODEL' || msg === 'NO_BASE_URL'
        ? 'Set up an AI provider first.'
        : /\b401\b/.test(msg)
          ? 'The AI service rejected the API key. Please check it.'
          : /\b429\b/.test(msg)
            ? 'I am being rate-limited. Try again in a few seconds.'
            : /Could not reach the AI service/.test(msg)
              ? msg
              : 'I could not reach my AI service. Check the internet connection or the provider settings.'
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

  function onProviderSaved(cfg) {
    // If the operator was blocked on "noconfig", start the conversation as
    // soon as they save a working config.
    if (isLlmConfigReady(cfg)) {
      setShowSettings(false)
      if (phase === 'noconfig') wake('')
    }
  }

  const orbMode = phase === 'transcribing' ? 'thinking' : phase === 'noconfig' ? 'idle' : phase
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
              style={{ background: 'rgba(5,16,28,0.93)', border: '1px solid rgba(14,165,164,0.4)', backdropFilter: 'blur(20px)', boxShadow: '0 0 32px rgba(14,165,164,0.12)' }}
            >
              <button type="button" onClick={tapOrb} title="Tap to talk" className="shrink-0 rounded-full focus:outline-none">
                <VarunaOrb mode={orbMode} levelRef={levelRef} size={mobile ? 64 : 76} />
              </button>

              <div className="min-w-0 flex-1">
                {showSettings ? (
                  <div className="max-h-[52vh] overflow-y-auto pr-1">
                    {phase === 'noconfig' && <div className="mb-2 text-[11px] text-muted">{said}</div>}
                    <VoiceSettings />
                    <LlmPicker kind="assistant" onSaved={onProviderSaved} compact />
                  </div>
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
                        className="line-clamp-3 text-[13px] leading-snug" style={{ color: '#86efac' }}
                      >
                        {said || (phase === 'listening' ? 'Go ahead, I’m listening.' : '')}
                      </motion.div>
                    </AnimatePresence>
                  </>
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setShowSettings((v) => !v)}
                  title={showSettings ? 'Close settings' : 'Voice & AI provider settings'}
                  className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/10"
                  style={{ color: showSettings ? 'var(--accent-hex)' : 'var(--muted)' }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.9l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                  </svg>
                </button>
                <button type="button" onClick={() => { setShowSettings(false); setTyping((v) => !v) }} title="Type instead" className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-ink">
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
