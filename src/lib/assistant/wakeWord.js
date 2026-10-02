// "Varuna" / "Hi Varuna" wake word, Copilot-style: always listening in the
// background, reacting only to the name.
//
// Two engines, picked automatically:
//  1. The browser's built-in speech recognition (Chrome / Edge in a normal
//     browser tab) — free and instant.
//  2. Whisper on Groq, for where (1) can't work: the Electron desktop app (its
//     Chromium has no Google speech service, so recognition fails with
//     "network"), or after repeated network failures. A local voice-activity
//     detector records only short bursts of speech and only those are sent, at
//     most 12 a minute. Needs a Groq API key (the assistant's or the report's).
//
// Privacy note: engine (1) sends background audio to the browser vendor's
// speech service and engine (2) sends short speech clips to Groq. The operator
// can switch the wake word off; tap-to-talk keeps working.

import { getGroqKey, groqTranscribe } from './groqClient'
import { getLlmConfig } from './llmSettings'

const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null
const isElectron = typeof navigator !== 'undefined' && /Electron\//i.test(navigator.userAgent || '')
const canRecord = typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia

export const wakeWordSupported = (!!Recognition && !isElectron) || canRecord

/** Whether the operator has the wake word switched on (default on). */
export function wakeWordEnabled() {
  try {
    return localStorage.getItem('varuna.wakeWord') !== '0'
  } catch {
    return true
  }
}

// ── Matching ────────────────────────────────────────────────────────────────
// Tolerant to how "Varuna" gets heard in Indian English / Hindi, in Latin or
// Devanagari. \b doesn't work with Devanagari, so word edges are explicit.
const NAME =
  '(?:varuna+|waruna+|baruna+|bharuna|veruna|varun|barun|warun|verona|varona|barona|aruna|varna|warna|buruna|' +
  'वरुण[ा]?|वरूण[ा]?|वरुना|बरुण[ा]?|वरना)'
const GREET = '(?:hi+|high|hey+|hai|hay|hello|helo|hallo|ok|okay|oye|yo|हाय|हेलो|हैलो|हे|ओके|अरे)'
const L = '(?:^|[\\s,.!?।])' // left edge
const R = '(?=$|[\\s,.!?।])' // right edge
const GREET_RE = new RegExp(`${L}${GREET}[\\s,.!]*${NAME}${R}[\\s,.!?।]*(.*)$`, 'i')
// The bare name works too, when it opens what was said ("Varuna, plan a mission").
const BARE_RE = new RegExp(`^[\\s,.!]*(?:(?:uh|um|so|acha|achha|arre|are|ok|okay)[\\s,]+)?${NAME}${R}[\\s,.!?।]*(.*)$`, 'i')

/** If `text` contains the wake phrase, returns { rest } (words said after it); else null. */
export function matchWake(text) {
  const t = String(text || '').trim()
  const m = t.match(GREET_RE) || t.match(BARE_RE)
  return m ? { rest: (m[1] || '').trim() } : null
}

// Groq key usable for Whisper: the assistant's (if Groq), else the report's, else the legacy one.
function whisperKey() {
  for (const kind of ['assistant', 'report']) {
    const c = getLlmConfig(kind)
    if (c?.provider === 'groq' && c.apiKey) return c.apiKey
  }
  return getGroqKey()
}

/**
 * Start listening for the wake phrase. Returns a controller:
 *   { stop(), pause(), resume(), isRunning(), engine() }
 * `onWake({ rest })` fires once per wake; listening pauses until resume().
 * `onState` gets 'listening' | 'blocked' | 'off' | 'unsupported' | 'needs-key'.
 */
export function createWakeListener({ onWake, onState = () => {}, lang = 'en-IN' }) {
  let impl = null
  let state = { wanted: true, paused: false }
  let keyPoll = 0

  const startWhisper = () => {
    if (!canRecord) {
      onState('unsupported')
      return
    }
    if (!whisperKey()) {
      // Wait for a Groq key to be configured, then start by itself.
      onState('needs-key')
      clearInterval(keyPoll)
      keyPoll = setInterval(() => {
        if (whisperKey()) {
          clearInterval(keyPoll)
          impl = createWhisperWake({ onWake, onState, state })
        }
      }, 4000)
      return
    }
    impl = createWhisperWake({ onWake, onState, state })
  }

  if (Recognition && !isElectron) {
    impl = createBrowserWake({
      onWake,
      onState,
      lang,
      state,
      // Recognition keeps failing ("network"): hand over to Whisper.
      onDead: () => {
        impl?.halt()
        impl = null
        startWhisper()
      },
    })
  } else {
    startWhisper()
  }

  return {
    stop() {
      state.wanted = false
      clearInterval(keyPoll)
      impl?.halt()
      onState('off')
    },
    pause() {
      state.paused = true
      impl?.halt()
    },
    resume() {
      state.paused = false
      if (state.wanted) impl?.start()
    },
    isRunning: () => state.wanted && !state.paused,
    engine: () => impl?.name || 'none',
  }
}

// ── Engine 1: browser speech recognition ────────────────────────────────────
function createBrowserWake({ onWake, onState, lang, state, onDead }) {
  let rec = null
  let restartTimer = null
  let fails = 0
  let netFails = 0
  let recent = [] // final transcripts from the last few seconds: "hi" + "varuna" may arrive split

  function start() {
    if (!state.wanted || state.paused || rec) return
    try {
      rec = new Recognition()
    } catch {
      return
    }
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3
    const r0 = rec
    let latest = null
    let settle = 0
    const fire = () => {
      clearTimeout(settle)
      if (!latest || rec !== r0) return
      const hit = latest
      latest = null
      recent = []
      fails = 0
      state.paused = true
      try {
        r0.abort()
      } catch {
        /* ignore */
      }
      onWake(hit)
    }
    r0.onresult = (e) => {
      const now = Date.now()
      recent = recent.filter((x) => now - x.t < 5000)
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        let hit = null
        for (let a = 0; a < r.length && !hit; a++) {
          const said = r[a].transcript
          // this fragment alone, or joined to what came just before it
          hit = matchWake(said) || matchWake(`${recent.map((x) => x.text).join(' ')} ${said}`)
        }
        if (r.isFinal) recent.push({ text: r[0].transcript, t: now })
        if (!hit) continue
        latest = hit
        // Final → act now. Interim → wait a moment: words usually keep coming
        // ("Varuna, plan a mission…"), so the command isn't cut off.
        if (r.isFinal) return fire()
        clearTimeout(settle)
        settle = setTimeout(fire, hit.rest ? 1400 : 700)
      }
    }
    r0.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        state.wanted = false
        onState('blocked')
      } else if (e.error === 'network') {
        netFails++
        fails++
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        fails++
      }
    }
    r0.onend = () => {
      clearTimeout(settle)
      if (rec !== r0) return
      rec = null
      if (netFails >= 2) return onDead() // no speech service here — switch engines
      // Chrome ends continuous recognition on silence / every minute: restart quickly.
      if (state.wanted && !state.paused) {
        clearTimeout(restartTimer)
        restartTimer = setTimeout(start, Math.min(5000, 250 * 2 ** Math.min(fails, 4)))
      }
    }
    try {
      rec.start()
      onState('listening')
    } catch {
      rec = null
    }
  }

  function halt() {
    clearTimeout(restartTimer)
    if (rec) {
      const r = rec
      rec = null
      try {
        r.abort()
      } catch {
        /* ignore */
      }
    }
  }

  start()
  return { name: 'browser', start, halt }
}

// ── Engine 2: local voice detection + Whisper ───────────────────────────────
const MAX_CLIPS_PER_MIN = 12

function createWhisperWake({ onWake, onState, state }) {
  let stream = null
  let ctx = null
  let iv = 0
  let rec = null
  let opening = false
  let recording = false
  let busy = false
  let startedAt = 0
  let lastVoice = 0
  let noise = 0.008
  let sent = []
  const buf = new Float32Array(1024)
  let analyser = null

  async function start() {
    if (!state.wanted || state.paused || stream || opening) return
    opening = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch {
      opening = false
      state.wanted = false
      onState('blocked')
      return
    }
    opening = false
    if (!state.wanted || state.paused) return release()
    const Ctx = window.AudioContext || window.webkitAudioContext
    ctx = new Ctx()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    iv = setInterval(tick, 30)
    onState('listening')
  }

  function tick() {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    const threshold = Math.max(0.012, noise * 3)
    const now = Date.now()
    if (!recording && rms < threshold) noise = noise * 0.97 + rms * 0.03 // learn the room's background level
    if (!recording) {
      if (rms > threshold && !busy) {
        try {
          const chunks = []
          const r = new MediaRecorder(stream)
          r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
          r.onstop = () => handleClip(chunks, r.mimeType)
          r.start()
          rec = r
          recording = true
          startedAt = lastVoice = now
        } catch {
          /* recorder busy — try on the next burst */
        }
      }
      return
    }
    if (rms > threshold) lastVoice = now
    if (now - lastVoice > 650 || now - startedAt > 6000) {
      recording = false
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    }
  }

  async function handleClip(chunks, mime) {
    if (!stream) return // released (paused/stopped) mid-clip — don't send it
    const speechSecs = (lastVoice - startedAt) / 1000
    if (!chunks.length || speechSecs < 0.25 || speechSecs > 6.5) return // a click, or someone talking at length
    const now = Date.now()
    sent = sent.filter((t) => now - t < 60000)
    if (sent.length >= MAX_CLIPS_PER_MIN) return
    sent.push(now)
    busy = true
    let text = ''
    try {
      text = await groqTranscribe(new Blob(chunks, { type: mime || 'audio/webm' }), { apiKey: whisperKey(), prompt: '' })
    } catch {
      /* network blip / rate limit — keep listening */
    } finally {
      busy = false
    }
    if (!state.wanted || state.paused) return
    const hit = matchWake(text)
    if (!hit) return
    state.paused = true
    release()
    onWake(hit)
  }

  function release() {
    clearInterval(iv)
    iv = 0
    if (recording) {
      recording = false
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    }
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* ignore */
    }
    try {
      ctx?.close()
    } catch {
      /* ignore */
    }
    stream = null
    ctx = null
  }

  start()
  return { name: 'whisper', start, halt: release }
}
