import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSystem } from './SystemContext'
import { SwipeConfirm } from './ui'
import { useLivePosition, useLaptopGps, useHomePoint } from '../hooks/useLaptopGps'
import { createAssistantChat } from '../lib/assistant/assistantChat'
import { startRecording, speak, stopSpeaking } from '../lib/assistant/voice'
import { getGroqKey, setGroqKey, groqTranscribe } from '../lib/assistant/groqClient'
import { navigateTo } from '../lib/planDraftStore'

// VARUNA Assist — the in-app AI co-pilot (voice + text). Answers questions
// about the app/drone, plans missions over real lakes onto the Missions tab,
// and can request flight commands (each one still needs the operator's swipe).

const SUGGESTIONS = [
  'Plan a mission for this lake',
  'Is lake ke kinaare ka round banao',
  'Battery aur GPS kaisa hai?',
  'How do I upload and start a mission?',
]
const TOOL_LABEL = {
  get_app_status: 'Checking the drone…',
  navigate: 'Switching tab…',
  get_detections_summary: 'Reading detections…',
  plan_mission: 'Finding the lake & planning the path…',
  request_flight_command: 'Waiting for you to swipe…',
}
const CMD_LABEL = { arm: 'Arm', disarm: 'Disarm', takeoff: 'Take off', rth: 'Return to Home', land: 'Land', stop: 'Emergency stop', start_mission: 'Start mission' }

let msgSeq = 0
const mk = (m) => ({ id: ++msgSeq, ...m })

export default function Assistant({ open, onClose, tab }) {
  const { telemetry, simulated, backendReachable } = useSystem()
  const live = useLivePosition(telemetry.data)
  const laptop = useLaptopGps(true)
  const homePoint = useHomePoint(telemetry.data, live, simulated)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(null) // status label while thinking
  const [recording, setRecording] = useState(null) // { startedAt }
  const [voiceOut, setVoiceOut] = useState(() => {
    try {
      return localStorage.getItem('varuna.assistVoice') !== '0'
    } catch {
      return true
    }
  })
  const [hasKey, setHasKey] = useState(() => !!getGroqKey())
  const [keyDraft, setKeyDraft] = useState('')
  const [confirm, setConfirm] = useState(null) // { cmd, openId }
  const [now, setNow] = useState(Date.now())

  const recRef = useRef(null)
  const listRef = useRef(null)
  // Keep the last request after the pop-up closes: SwipeConfirm runs onConfirm
  // only after its close animation, which needs the command still set.
  const lastConfirmRef = useRef(null)
  if (confirm) lastConfirmRef.current = confirm
  const shown = confirm || lastConfirmRef.current
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
  }

  const push = (m) => setMessages((s) => [...s, mk(m)])
  const chatRef = useRef(null)
  if (!chatRef.current) {
    chatRef.current = createAssistantChat(
      () => ctxRef.current,
      (ev) => {
        if (ev.type === 'tool') setBusy(TOOL_LABEL[ev.name] || 'Working…')
        if (ev.type === 'tool_result' && ev.name === 'plan_mission' && ev.result?.ok) push({ role: 'card', kind: 'plan', data: ev.result })
        if (ev.type === 'tool_result' && ev.name === 'request_flight_command') push({ role: 'card', kind: 'cmd', data: { ...ev.result, label: CMD_LABEL[ev.args?.command] } })
      },
    )
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])
  useEffect(() => {
    if (!recording) return undefined
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [recording])
  useEffect(() => {
    if (open) setHasKey(!!getGroqKey())
    if (!open) {
      stopSpeaking()
      // Closing the panel discards an unsent recording and releases the mic.
      recRef.current?.cancel()
      recRef.current = null
      setRecording(null)
    }
  }, [open])
  useEffect(() => () => recRef.current?.cancel(), []) // unmount

  // Opens the swipe-to-confirm pop-up for ONE request; resolves 'confirmed' |
  // 'cancelled' | 'timeout'. Each pop-up carries its own request object, so a
  // swipe can only ever confirm the command it was shown for.
  function requestConfirm(cmdKey, detail) {
    return new Promise((resolve) => {
      const req = { cmd: cmdKey, detail, openId: Date.now() + Math.random(), done: false, swiped: false }
      req.finish = (v) => {
        if (req.done) return
        req.done = true
        clearTimeout(req.timer)
        resolve(v)
      }
      // Give up if the operator ignores it — but never once they've started the swipe.
      req.timer = setTimeout(() => {
        if (req.swiped) return
        setConfirm((c) => (c === req ? null : c))
        req.finish('timeout')
      }, 90000)
      setConfirm(req)
    })
  }

  function friendlyError(e) {
    const msg = String(e?.message || e)
    if (msg === 'NO_KEY') return 'Add your Groq API key first.'
    if (/Groq 401/.test(msg)) return 'Groq rejected the API key — check it and paste it again.'
    if (/Groq 429/.test(msg)) return 'Groq is rate-limiting (free tier). Wait a few seconds and try again.'
    return `Couldn't reach Groq — ${msg}`
  }

  // `text` = typed message, or `blob` = recorded voice (transcribed by Groq Whisper first).
  async function send({ text, blob }) {
    if (busy) return
    if (!getGroqKey()) {
      setHasKey(false)
      return
    }
    stopSpeaking()
    try {
      if (blob) {
        setBusy('Listening to your voice…')
        text = await groqTranscribe(blob)
        if (!text) {
          push({ role: 'error', text: "I couldn't hear anything — try again a bit closer to the mic." })
          return
        }
        push({ role: 'user', text: `🎤 “${text}”` })
      } else {
        push({ role: 'user', text })
      }
      setBusy('Thinking…')
      const reply = await chatRef.current.send(text)
      push({ role: 'ai', text: reply })
      if (voiceOut) speak(reply)
    } catch (e) {
      push({ role: 'error', text: friendlyError(e) })
    } finally {
      setBusy(null)
    }
  }

  function submitText(e) {
    e?.preventDefault()
    const t = input.trim()
    if (!t) return
    setInput('')
    send({ text: t })
  }

  const micBusyRef = useRef(false) // blocks double-taps while the mic permission prompt is open
  async function toggleMic() {
    if (micBusyRef.current) return
    if (recording) {
      const r = recRef.current
      recRef.current = null
      setRecording(null)
      const clip = await r?.stop()
      if (clip) send({ blob: clip.blob })
      return
    }
    if (busy) return
    micBusyRef.current = true
    try {
      stopSpeaking()
      recRef.current = await startRecording()
      setRecording({ startedAt: Date.now() })
    } catch (e) {
      push({ role: 'error', text: `Microphone unavailable: ${e?.message || e}. Allow mic access in the browser.` })
    } finally {
      micBusyRef.current = false
    }
  }

  function saveKey() {
    if (!keyDraft.trim()) return
    setGroqKey(keyDraft.trim())
    setKeyDraft('')
    setHasKey(true)
  }

  function toggleVoice() {
    const next = !voiceOut
    setVoiceOut(next)
    if (!next) stopSpeaking()
    try {
      localStorage.setItem('varuna.assistVoice', next ? '1' : '0')
    } catch {
      /* private mode */
    }
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.aside
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="glass fixed bottom-[86px] left-2 top-[60px] z-[60] flex w-[calc(100vw-16px)] flex-col overflow-hidden shadow-elev sm:w-[380px] md:bottom-3 md:left-[88px]"
            aria-label="VARUNA Assist"
          >
            {/* header */}
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-accent">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13z" fill="currentColor" /></svg>
              </span>
              <div className="flex-1">
                <div className="text-sm font-bold text-ink">VARUNA Assist</div>
                <div className="text-[10px] text-muted">{simulated ? 'Simulator · plans & commands fly the virtual drone' : 'Voice & chat co-pilot'}</div>
              </div>
              <button onClick={toggleVoice} title={voiceOut ? 'Mute spoken replies' : 'Speak replies'} className="rounded-md px-2 py-1 text-sm text-muted hover:text-ink">
                {voiceOut ? '🔊' : '🔇'}
              </button>
              <button
                onClick={() => {
                  chatRef.current.reset()
                  setMessages([])
                  stopSpeaking()
                }}
                title="New conversation"
                className="rounded-md px-2 py-1 text-[11px] font-semibold text-muted hover:text-ink"
              >
                New
              </button>
              <button onClick={onClose} title="Close" className="rounded-md px-2 py-1 text-lg leading-none text-muted hover:text-ink">×</button>
            </div>

            {/* messages */}
            <div ref={listRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
              {!hasKey ? (
                <div className="rounded-lg bg-chip p-3 text-xs text-muted">
                  <div className="mb-2 font-semibold text-ink">Add your Groq API key to start</div>
                  Get a free key at console.groq.com → API Keys. It stays only in this browser.
                  <div className="mt-2 flex gap-2">
                    <input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} type="password" placeholder="Paste Groq API key (gsk_…)" className="inp flex-1 px-2 py-1.5 text-xs" />
                    <button onClick={saveKey} className="rounded-md bg-accent px-3 text-xs font-bold text-white">Save</button>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <div className="mt-2 flex flex-col gap-2">
                  <p className="px-1 text-xs text-muted">
                    Ask me anything about VARUNA, or tap 🎤 and say it — English, Hindi or Hinglish. I can plan a mission over a real lake and help you fly it.
                  </p>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send({ text: s })} className="rounded-lg bg-chip px-3 py-2 text-left text-xs text-ink transition-colors hover:bg-chip2">
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                messages.map((m) => <Bubble key={m.id} m={m} />)
              )}
              {busy && (
                <div className="flex items-center gap-2 px-1 text-xs text-muted">
                  <span className="inline-flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-accent" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} />
                    ))}
                  </span>
                  {busy}
                </div>
              )}
            </div>

            {/* input */}
            <form onSubmit={submitText} className="flex items-center gap-2 border-t border-line p-3">
              <button
                type="button"
                onClick={toggleMic}
                disabled={!hasKey || (!!busy && !recording)}
                title={recording ? 'Stop and send' : 'Speak'}
                className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40"
                style={{ background: recording ? '#FF453A' : 'var(--accent-hex)' }}
              >
                {recording && <motion.span className="absolute inset-0 rounded-full" style={{ background: '#FF453A' }} animate={{ scale: [1, 1.5], opacity: [0.5, 0] }} transition={{ duration: 1.1, repeat: Infinity }} />}
                <svg viewBox="0 0 24 24" width="18" height="18" className="relative">
                  {recording ? <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /> : <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-3.1A7 7 0 0019 11h-2z" fill="currentColor" />}
                </svg>
              </button>
              {recording ? (
                <div className="flex-1 text-xs font-semibold text-bad">
                  Listening… {((now - recording.startedAt) / 1000).toFixed(0)} s — tap ■ to send
                </div>
              ) : (
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={!hasKey}
                  placeholder={hasKey ? 'Type or tap 🎤 to speak…' : 'Add your Groq key above'}
                  className="inp min-w-0 flex-1 px-3 py-2 text-sm"
                />
              )}
              {!recording && (
                <button type="submit" disabled={!hasKey || !!busy || !input.trim()} className="rounded-lg bg-accent px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
                  Send
                </button>
              )}
            </form>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Flight commands requested by the assistant still need the operator's swipe. */}
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

function Bubble({ m }) {
  if (m.role === 'card' && m.kind === 'plan') {
    const d = m.data
    return (
      <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs">
        <div className="mb-1 font-bold text-accent">✨ Mission draft ready</div>
        <div className="text-ink">
          {d.pattern === 'shoreline' ? 'Shoreline loop' : 'Full sweep'} · {d.lake}
        </div>
        <div className="font-mono tnum text-muted">
          {d.waypoints} WP · {d.path_length_km} km · ~{d.estimated_minutes} min · {d.altitude_m} m · {d.speed_kmh} km/h
        </div>
        {d.warnings?.map((w) => (
          <div key={w} className="mt-1 text-warn">⚠ {w}</div>
        ))}
        <button onClick={() => navigateTo('mission')} className="mt-2 font-semibold text-accent">Open Missions tab →</button>
      </div>
    )
  }
  if (m.role === 'card' && m.kind === 'cmd') {
    const d = m.data
    const ok = d.status === 'sent' && d.success
    return (
      <div className="self-center rounded-full px-3 py-1 text-[11px] font-semibold" style={{ background: ok ? 'rgba(50,215,75,0.15)' : 'rgba(255,159,10,0.15)', color: ok ? '#32D74B' : '#FF9F0A' }}>
        {ok ? `✓ ${d.message}` : d.status === 'cancelled' ? 'Command cancelled' : d.status === 'rejected' ? `Not sent — ${d.reason}` : `✗ ${d.message}`}
      </div>
    )
  }
  const mine = m.role === 'user'
  return (
    <div
      className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${mine ? 'self-end rounded-br-md bg-accent text-white' : 'self-start rounded-bl-md bg-chip text-ink'}`}
      style={m.role === 'error' ? { background: 'rgba(255,69,58,0.15)', color: '#FF453A' } : undefined}
    >
      {m.text}
    </div>
  )
}
