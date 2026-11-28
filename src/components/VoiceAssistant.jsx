import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSystem } from './SystemContext'
import { SwipeConfirm } from './ui'
import VarunaBot from './bot/VarunaBot'
import { KIND_WHO, LevelIcon } from './bot/botUi'
import LlmPicker from './LlmPicker'
import { useLivePosition, useLaptopGps, useHomePoint } from '../hooks/useLaptopGps'
import { createAssistantChat } from '../lib/assistant/assistantChat'
import { groqTranscribe } from '../lib/assistant/groqClient'
import { getLlmConfig, isLlmConfigReady } from '../lib/assistant/llmSettings'
import { listenUntilSilence, browserListenToText, browserSttSupported, chime, currentSttLang, noteUserText, speak, stopSpeaking } from '../lib/assistant/voice'
import VoiceSettings from './VoiceSettings'
import { createWakeListener, wakeWordSupported } from '../lib/assistant/wakeWord'
import {
  botLevel, dismissPopup, gesture, getBot, onBoatMessage, postBoatMessage, setAwake, setCaption, setDemo, setHeard, setMood, setMuted, useBotState,
} from '../lib/assistant/botStore'
import { matchBoatIntent, runBoatCommand } from '../lib/assistant/boatCommands'

// The VARUNA Assistant: a floating 3D robot on every tab.
//   - Say "Varuna", click the robot, or press Alt+V: it wakes, listens, does the
//     job (boat commands, questions, drone missions) and keeps the conversation
//     going until you stop talking, then docks in the corner again.
//   - It also relays what the boat and its AI captain do (BoatEventWatcher),
//     as pop-ups next to the dock and, unless muted, out loud.
// On the Boat Vision tab the same robot is shown big inside the tab, so the
// dock, the pop-ups and the panel are hidden there (the brain keeps running).

const TOOL_CAPTION = {
  get_app_status: 'Checking the drone…',
  navigate: 'Opening the tab…',
  get_boat_vision_summary: 'Looking through the boat camera…',
  get_detections_summary: 'Reading the detections…',
  plan_mission: 'Finding the lake and planning the path…',
  plan_hotspot_mission: 'Finding the worst trash hotspots…',
  get_mission_debrief: 'Putting together the debrief…',
  query_trash_history: 'Checking the trash history…',
  request_flight_command: 'Swipe on the screen to confirm…',
}
// Dock height above the bottom edge per tab: always above that tab's own bottom controls.
const DOCK_BOTTOM = { home: 18, live: 236, mission: 18, boat: 18, detections: 18, replay: 18, data: 18, system: 18 }
const BOAT_TABS = new Set(['boat', 'vision'])
// Note: plain "stop" is NOT here: it stops the boat (see boatCommands).
const DISMISS_RE = /^(bye|goodbye|bye bye|thank you|thanks|thank u|that'?s all|stop listening|go to sleep|sleep|bas|bas karo|ok bye|nothing|no thanks|dhanyavaad|shukriya)[.! ]*$/i
function greeting() {
  if (currentSttLang() === 'hi-IN') return ['हाँ, बोलिए।', 'जी, सुन रहा हूँ।', 'बताइए, क्या करना है?'][Math.floor(Math.random() * 3)]
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.'
  return [`${part} What can I do for you?`, 'Yes? I’m listening.', 'I’m here. Go ahead.', 'At your service. What do you need?'][Math.floor(Math.random() * 4)]
}

export default function VoiceAssistant({ tab, showTelemetry = true, wakeSignal, wakeWordOn, onWakeState }) {
  const { telemetry, simulated, backendReachable } = useSystem()
  const live = useLivePosition(telemetry.data)
  const laptop = useLaptopGps(true)
  const homePoint = useHomePoint(telemetry.data, live, simulated)

  const awake = useBotState((s) => s.awake)
  const mood = useBotState((s) => s.mood)
  const caption = useBotState((s) => s.caption)
  const heard = useBotState((s) => s.heard)
  const gest = useBotState((s) => s.gesture)
  const popups = useBotState((s) => s.popups)
  const muted = useBotState((s) => s.muted)
  const demo = useBotState((s) => s.demo)
  const summon = useBotState((s) => s.summon)
  const [phase, setPhaseState] = useState('idle') // idle | listening | transcribing | thinking | speaking | noconfig | error
  const [typed, setTyped] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640)
  const [drowsy, setDrowsy] = useState(false)

  const sessionRef = useRef(0) // bumps on every wake/sleep: stale async steps bail out
  const turnSidRef = useRef(-1) // session that owns the chat turn currently running tools
  const listenRef = useRef(null)
  const wakeRef = useRef(null)
  const awakeRef = useRef(false)
  const lastConfirmRef = useRef(null)
  const tabRef = useRef(tab)
  tabRef.current = tab
  if (confirm) lastConfirmRef.current = confirm
  const shown = confirm || lastConfirmRef.current

  function setPhase(p) {
    setPhaseState(p)
    setMood(p === 'transcribing' ? 'thinking' : p === 'noconfig' ? 'idle' : p)
  }

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
        if (ev.type === 'tool') setCaption(TOOL_CAPTION[ev.name] || 'Working on it…')
      },
    )
  }

  useEffect(() => {
    const f = () => setMobile(window.innerWidth < 640)
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])

  // ---- wake word ("Varuna") in the background while asleep ----
  // Not on the Live tab: always-on speech recognition takes one to two CPU
  // cores, which the live video and the AI detection need (tap-to-talk works).
  const liveRef = useRef(tab === 'live')
  liveRef.current = tab === 'live'
  useEffect(() => {
    if (tab === 'live') wakeRef.current?.pause()
    else if (!awakeRef.current) wakeRef.current?.resume()
  }, [tab])

  useEffect(() => {
    if (!wakeWordOn || !wakeWordSupported) {
      onWakeState?.(wakeWordSupported ? 'off' : 'unsupported')
      return undefined
    }
    const w = createWakeListener({ onWake: ({ rest }) => wake(rest), onState: (s) => onWakeState?.(s) })
    if (!w) onWakeState?.('unsupported')
    wakeRef.current = w
    if (awakeRef.current || liveRef.current) w?.pause()
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

  // Summoned from a tab (Boat Vision mic, quick commands).
  const firstSummon = useRef(summon.id)
  useEffect(() => {
    if (summon.id === firstSummon.current) return
    if (summon.text) {
      if (!awakeRef.current) openSession()
      handle(summon.text, sessionRef.current)
    } else if (awakeRef.current && phase !== 'listening') tapTalk()
    else if (!awakeRef.current) wake('')
  }, [summon.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Alt+V anywhere: talk / close. Esc closes.
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        if (awakeRef.current) sleep()
        else wake('')
      } else if (e.key === 'Escape' && awakeRef.current && !getBot().confirm) sleep()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stopEverything(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // A friendly hello once per session.
  useEffect(() => {
    let done = false
    try {
      done = sessionStorage.getItem('varuna.bot.hello') === '1'
      sessionStorage.setItem('varuna.bot.hello', '1')
    } catch {
      /* private mode */
    }
    if (done) return undefined
    const id = setTimeout(() => {
      gesture('wave')
      postBoatMessage({ text: 'Hi, I’m VARUNA. Click me, press Alt+V or say “Varuna” whenever you need me.', level: 'info', kind: 'assistant', key: 'hello', speak: false })
    }, 1800)
    return () => clearTimeout(id)
  }, [])

  // ---- boat messages: pop-ups, and spoken one at a time unless muted ----
  const queueRef = useRef([])
  const speakingMsgRef = useRef(false)
  useEffect(() => onBoatMessage((msg) => {
    if (msg.mood === 'happy') gesture('bounce')
    else if (msg.level === 'bad') gesture('alert')
    if (msg.kind === 'assistant' || !msg.speak || getBot().muted) return
    if (awakeRef.current) return // mid-conversation: shown, not spoken
    const q = queueRef.current
    if (msg.level === 'bad') {
      q.length = 0 // urgent: drop the backlog and cut in
      if (speakingMsgRef.current) stopSpeaking()
    }
    q.push(msg)
    while (q.length > 3) q.splice(q.findIndex((m) => m.level !== 'bad'), 1)
    drainMessages()
  }), []) // eslint-disable-line react-hooks/exhaustive-deps

  async function drainMessages() {
    if (speakingMsgRef.current) return
    speakingMsgRef.current = true
    try {
      while (queueRef.current.length && !awakeRef.current && !getBot().muted) {
        const msg = queueRef.current.shift()
        setMood('speaking')
        setCaption(msg.text)
        await talk(msg.say)
        if (awakeRef.current) break
        if (msg.mood) {
          setMood(msg.mood)
          await new Promise((r) => setTimeout(r, 1600))
        }
      }
    } finally {
      speakingMsgRef.current = false
      if (!awakeRef.current) setMood('idle')
    }
  }

  // Dozes off after two quiet minutes in the dock; wakes on any message or hover.
  useEffect(() => {
    setDrowsy(false)
    if (awake) return undefined
    const id = setTimeout(() => setDrowsy(true), 120000)
    return () => clearTimeout(id)
  }, [awake, popups, mood])

  function stopEverything() {
    listenRef.current?.cancel()
    listenRef.current = null
    stopSpeaking()
    botLevel.current = 0
  }

  // Speaking animation: a gentle random "mouth" plus a kick on every word.
  async function talk(text) {
    const iv = setInterval(() => {
      botLevel.current = Math.max(botLevel.current, 0.25 + Math.random() * 0.35)
    }, 160)
    try {
      await speak(text, { onWord: () => (botLevel.current = 0.75 + Math.random() * 0.25) })
    } finally {
      clearInterval(iv)
      botLevel.current = 0
    }
  }

  // ---- the conversation loop ----
  function openSession() {
    const sid = ++sessionRef.current
    queueRef.current.length = 0
    stopEverything()
    wakeRef.current?.pause()
    awakeRef.current = true
    setAwake(true)
    setHeard('')
    setCaption('')
    return sid
  }

  async function wake(rest) {
    const sid = openSession()
    gesture('wave')
    chime() // a soft tone says "I heard you", then straight to listening
    if (rest && rest.split(/\s+/).length >= 2) return handle(rest, sid) // "Varuna, bring the boat home"
    setCaption(greeting())
    await new Promise((r) => setTimeout(r, 320)) // let the chime finish so the mic doesn't hear it
    if (sid === sessionRef.current) listen(sid, false)
  }

  function sleep() {
    sessionRef.current++
    stopEverything()
    awakeRef.current = false
    setAwake(false)
    setShowSettings(false)
    setPhase('idle')
    setConfirm((c) => {
      c?.finish('cancelled')
      return null
    })
    setTimeout(() => {
      if (!awakeRef.current && !liveRef.current) wakeRef.current?.resume()
    }, 600)
  }

  async function say(text, sid) {
    if (sid !== sessionRef.current) return
    setPhase('speaking')
    setCaption(text)
    await talk(text)
  }

  async function listen(sid, followUp) {
    if (sid !== sessionRef.current) return
    setPhase('listening')
    // Whisper (Groq) if the assistant provider is Groq: more accurate for
    // Hinglish. Otherwise the browser's own speech recognizer.
    const cfg = getLlmConfig('assistant')
    const useWhisper = cfg?.provider === 'groq' && !!cfg?.apiKey
    let text = null
    listenRef.current?.cancel() // never two recordings at once
    if (useWhisper) {
      const l = listenUntilSilence({ onLevel: (v) => (botLevel.current = v), startTimeoutMs: followUp ? 6000 : 8000 })
      listenRef.current = l
      let clip
      try {
        clip = await l.done
      } catch (e) {
        if (sid !== sessionRef.current) return
        setPhase('error')
        setCaption(`I can’t use the microphone. Allow mic access, or type below. (${e?.message || e})`)
        return
      } finally {
        if (listenRef.current === l) listenRef.current = null
      }
      if (sid !== sessionRef.current) return
      if (!clip) return quiet(sid, followUp)
      setPhase('transcribing')
      try {
        text = await groqTranscribe(clip.blob, { apiKey: cfg.apiKey })
      } catch (e) {
        return fail(e, sid)
      }
    } else if (browserSttSupported) {
      const l = browserListenToText({ onLevel: (v) => (botLevel.current = v), startTimeoutMs: followUp ? 6000 : 8000 })
      listenRef.current = l
      let result
      try {
        result = await l.done
      } catch (e) {
        if (sid !== sessionRef.current) return
        setPhase('error')
        setCaption(`I can’t use the microphone. Allow mic access, or type below. (${e?.message || e})`)
        return
      } finally {
        if (listenRef.current === l) listenRef.current = null
      }
      if (sid !== sessionRef.current) return
      if (!result) return quiet(sid, followUp)
      text = result.text
    } else {
      setPhase('idle')
      setCaption('This browser can’t listen to voice. Type your question below.')
      return
    }
    if (sid !== sessionRef.current) return
    if (!text) return listen(sid, true)
    noteUserText(text) // next listen follows the language they just used
    handle(text, sid)
  }

  // Nothing heard: stay open (typing still works) but stop the mic.
  async function quiet(sid, followUp) {
    if (!followUp) await say('I didn’t catch that. Tap the mic, or type below.', sid)
    if (sid === sessionRef.current) {
      setPhase('idle')
      if (followUp) setCaption('Anything else? Tap the mic or type below.')
    }
  }

  async function handle(text, sid) {
    if (sid !== sessionRef.current) return
    setHeard(text)
    if (DISMISS_RE.test(text.trim())) {
      gesture('wave')
      await say(/[ऀ-ॿ]/.test(text) ? 'ठीक है, ज़रूरत हो तो बस “वरुण” कहिए।' : 'Alright. Just call me when you need me.', sid)
      if (sid === sessionRef.current) sleep()
      return
    }
    // Boat commands first: instant, and they work without any AI provider.
    const cmd = matchBoatIntent(text, { boatContext: BOAT_TABS.has(tabRef.current) })
    if (cmd) {
      setPhase('thinking')
      setCaption(cmd === 'stop' ? 'Stopping the boat…' : 'One moment…')
      const res = await runBoatCommand(cmd)
      if (sid !== sessionRef.current) return
      if (res.ok && ['collect', 'home', 'ramp_down', 'ramp_up'].includes(cmd)) {
        setMood('happy')
        await new Promise((r) => setTimeout(r, 700))
      }
      await say(res.text, sid)
      if (sid === sessionRef.current) listen(sid, true)
      return
    }
    if (!isLlmConfigReady(getLlmConfig('assistant'))) {
      setPhase('noconfig')
      setShowSettings(true)
      gesture('shake')
      await say('I can run the boat for you: try “boat status”, “go collect” or “come home”. To answer anything else, pick an AI provider in my settings.', sid)
      if (sid === sessionRef.current) setPhase('idle')
      return
    }
    setPhase('thinking')
    setCaption('')
    let reply
    try {
      turnSidRef.current = sid
      reply = await chatRef.current.send(text)
    } catch (e) {
      return fail(e, sid)
    }
    await say(reply, sid)
    // Keep the conversation going: listen for a follow-up.
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
    gesture('shake')
    setPhase('error')
    await say(line, sid)
    if (sid === sessionRef.current) setPhase('error')
  }

  // Swipe-to-confirm for drone flight commands the assistant asks for:
  // resolves 'confirmed' | 'cancelled' | 'timeout'; the voice can never confirm by itself.
  function requestConfirm(cmdKey, detail) {
    return new Promise((resolve) => {
      if (!ctxRef.current.active()) return resolve('cancelled')
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
    stopEverything()
    const sid = ++sessionRef.current
    handle(t, sid)
  }

  function tapTalk() {
    // Talk now (interrupts speaking), or retry after an error.
    const sid = ++sessionRef.current
    stopEverything()
    listen(sid, false)
  }
  function quick(text) {
    stopEverything()
    const sid = ++sessionRef.current
    handle(text, sid)
  }

  function onProviderSaved(cfg) {
    if (isLlmConfigReady(cfg)) {
      setShowSettings(false)
      setCaption('All set. What would you like to know?')
      setPhase('idle')
    }
  }

  const onVision = tab === 'vision'
  const dockBottom = (DOCK_BOTTOM[tab] ?? 18) + (mobile && tab === 'boat' ? 8 : 0)
  const status =
    phase === 'listening' ? ['Listening', 'info'] : phase === 'transcribing' || phase === 'thinking' ? ['Thinking', 'info'] : phase === 'speaking' ? ['Speaking', 'ok'] : phase === 'error' ? ['Needs attention', 'warn'] : ['Ready', '']
  const chips = BOAT_TABS.has(tab) || demo
    ? [['How is the boat?', 'boat status'], ['Go collect', 'go collect'], ['Come home', 'come home'], ['Battery?', 'boat battery']]
    : [['What can you do?', 'What can you do?'], ['Boat status', 'boat status'], ['Plan a mission', 'Plan a cleanup mission for the nearest lake']]
  const dockMood = drowsy && mood === 'idle' ? 'sleep' : mood

  return (
    <>
      {/* ── dock (asleep) ── */}
      <AnimatePresence>
        {!awake && !onVision && (
          <motion.div key="dock" initial={{ opacity: 0, scale: 0.6, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.6, y: 20 }}
            transition={{ type: 'spring', stiffness: 260, damping: 22 }} className="vb-dock" style={{ bottom: dockBottom }}
            onMouseEnter={() => { if (drowsy) setDrowsy(false); else if (Math.random() < 0.5) gesture('wave') }}>
            <VarunaBot state={dockMood} gesture={gest} levelRef={botLevel} className="h-full w-full" onClick={() => wake('')} title="Talk to VARUNA (Alt+V)" />
            <span className="vb-tip">Talk to VARUNA · Alt+V</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── pop-ups next to the dock ── */}
      {!awake && !onVision && (
        <div className="vb-pops" style={{ bottom: dockBottom + 8 }} aria-live="polite">
          <AnimatePresence initial={false}>
            {/* Boat pop-ups on the Live and Boat tabs; elsewhere only real alarms. */}
            {popups.filter((p) => showTelemetry || p.level === 'bad').map((p) => <Popup key={p.id} msg={p} />)}
          </AnimatePresence>
        </div>
      )}

      {/* ── conversation panel (awake) ── */}
      <AnimatePresence>
        {awake && !onVision && (
          <motion.div key="panel" role="dialog" aria-label="VARUNA Assistant"
            initial={{ opacity: 0, y: 30, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 280, damping: 26 }} className="vb-panel" style={{ bottom: Math.max(12, dockBottom - 6), transformOrigin: 'bottom right' }}>
            <div className="vb-panel-head">
              <b>VARUNA Assistant</b>
              <span className={`sx-pill ${status[1]} ${phase === 'listening' ? 'pulse' : ''}`}><i />{status[0]}</span>
              <span className="flex-1" />
              <button type="button" className={`vb-iconbtn ${muted ? '' : 'on'}`} onClick={() => setMuted(!muted)} title={muted ? 'Boat messages are muted: tap to hear them' : 'Boat messages are spoken: tap to mute'} aria-pressed={!muted}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z" />{muted ? <path d="M22 9l-6 6M16 9l6 6" /> : <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" />}</svg>
              </button>
              <button type="button" className={`vb-iconbtn ${showSettings ? 'on' : ''}`} onClick={() => setShowSettings((v) => !v)} title="Settings" aria-pressed={showSettings}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
              </button>
              <button type="button" className="vb-iconbtn" onClick={sleep} title="Close (Esc)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            {showSettings ? (
              <div className="vb-settings">
                <Toggle on={!muted} onChange={(v) => setMuted(!v)} label="Speak boat messages" hint="Pop-ups always show; this reads them out loud." />
                <Toggle on={demo} onChange={setDemo} label="Demo mode" hint="Plays a pretend boat run, to try the assistant without the boat." />
                <div className="pt-3 text-[13px] font-bold">Voice</div>
                <VoiceSettings />
                <div className="pt-2 text-[13px] font-bold">AI provider (for questions)</div>
                <LlmPicker kind="assistant" onSaved={onProviderSaved} compact />
              </div>
            ) : (
              <>
                <div className="vb-stage">
                  <VarunaBot state={mood} gesture={gest} levelRef={botLevel} size={mobile ? 128 : 150} onClick={tapTalk} title="Tap to talk" />
                  <AnimatePresence mode="wait">
                    <motion.div key={caption} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="vb-say">
                      {caption || (phase === 'listening' ? 'Go ahead, I’m listening.' : phase === 'thinking' || phase === 'transcribing' ? 'Thinking…' : '')}
                    </motion.div>
                  </AnimatePresence>
                  {heard && <div className="vb-heard">You said: “{heard}”</div>}
                </div>
                <div className="vb-chips">
                  <button type="button" className="vb-chip stop" onClick={() => quick('stop the boat')}>■ Stop boat</button>
                  {chips.map(([l, q]) => <button key={l} type="button" className="vb-chip" onClick={() => quick(q)}>{l}</button>)}
                </div>
                <form onSubmit={submitTyped} className="vb-input">
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Ask or tell VARUNA…" aria-label="Message to VARUNA" />
                  <button type="button" onClick={tapTalk} className={`vb-mic ${phase === 'listening' ? 'live' : ''}`} title={phase === 'listening' ? 'Listening…' : 'Talk'} aria-label="Talk">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>
                  </button>
                </form>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <BoatConfirm />

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

function Toggle({ on, onChange, label, hint }) {
  return (
    <label className="vb-toggle">
      <span>{label}{hint && <small>{hint}</small>}</span>
      <button type="button" role="switch" aria-checked={on} className={`vb-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
    </label>
  )
}

function Popup({ msg }) {
  useEffect(() => {
    const id = setTimeout(() => dismissPopup(msg.id), msg.level === 'bad' ? 14000 : msg.level === 'warn' ? 10000 : 7000)
    return () => clearTimeout(id)
  }, [msg.id, msg.level])
  return (
    <motion.div layout initial={{ opacity: 0, x: 40, scale: 0.95 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 30, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }} className={`vb-pop lv-${msg.level}`} role={msg.level === 'bad' ? 'alert' : 'status'}>
      <span className="vb-pop-ic"><LevelIcon level={msg.level} /></span>
      <div className="min-w-0">
        <div className="vb-pop-who">{KIND_WHO[msg.kind] || 'Boat'}</div>
        <div className="vb-pop-txt">{msg.text}</div>
      </div>
      <button type="button" className="x" onClick={() => dismissPopup(msg.id)} aria-label="Dismiss">×</button>
    </motion.div>
  )
}

/** "Are you sure?" for anything that moves the boat (botStore.askConfirm). */
export function BoatConfirm() {
  const c = useBotState((s) => s.confirm)
  const okRef = useRef(null)
  useEffect(() => {
    if (!c) return undefined
    okRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') c.resolve(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [c])
  return (
    <AnimatePresence>
      {c && (
        <motion.div key="cf" className="vb-confirm-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => c.resolve(false)}>
          <motion.div className="vb-confirm" role="alertdialog" aria-modal="true" aria-labelledby="vb-cf-t" initial={{ y: 20, scale: 0.96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 10, scale: 0.97 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <span className="sx-head-icon" aria-hidden><LevelIcon level="warn" size={22} /></span>
              <h2 id="vb-cf-t">{c.title}</h2>
            </div>
            {c.detail && <p>{c.detail}</p>}
            <div className="row">
              <button type="button" className="sx-btn ghost lg" onClick={() => c.resolve(false)}>Cancel</button>
              <button ref={okRef} type="button" className={`sx-btn lg ${c.danger ? 'danger' : ''}`} onClick={() => c.resolve(true)}>{c.okLabel}</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
