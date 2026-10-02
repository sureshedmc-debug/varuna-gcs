// Voice in/out for the VARUNA assistant.
//  - listenUntilSilence(): records the operator's command and stops by itself
//    once they stop talking (simple energy-based voice-activity detection);
//    also streams the live mic level so the orb can react. The clip
//    (webm/opus in Chrome) goes to Groq Whisper (groqClient.js).
//  - speak(): the browser's speechSynthesis, sentence by sentence, each read by
//    a Hindi or Indian-English voice to match its script; resolves when
//    finished and reports word boundaries so the orb can "talk" in time.

const MAX_SECONDS = 20

/**
 * Record one utterance.
 * @param {object} o
 * @param {(level:number)=>void} [o.onLevel]  mic level 0..1, ~30×/s
 * @param {number} [o.startTimeoutMs]  give up if no speech starts within this
 * @param {number} [o.silenceMs]  stop after this much silence once speech started
 * @returns {{ done: Promise<{blob, seconds}|null>, cancel: () => void }}
 */
export function listenUntilSilence({ onLevel, startTimeoutMs = 7000, silenceMs = 1300 } = {}) {
  let cancelled = false
  let cancelFn = () => {
    cancelled = true
  }
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    if (cancelled) {
      stream.getTracks().forEach((t) => t.stop())
      return null
    }
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    let rec
    try {
      rec = new MediaRecorder(stream)
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      ctx.close()
      throw e
    }
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const startedAt = Date.now()
    let spoke = false
    let lastVoice = 0
    let iv = 0
    let hard = 0
    let noise = 0.01 // adaptive noise floor
    const buf = new Float32Array(an.fftSize)

    const stopped = new Promise((resolve) => (rec.onstop = resolve))
    const finish = () => {
      clearInterval(iv)
      clearTimeout(hard)
      if (rec.state !== 'inactive') rec.stop()
    }
    cancelFn = () => {
      cancelled = true
      finish()
    }

    const tick = () => {
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      if (!spoke) noise = noise * 0.95 + rms * 0.05
      const threshold = Math.max(0.015, noise * 2.6)
      const now = Date.now()
      if (rms > threshold) {
        spoke = true
        lastVoice = now
      }
      onLevel?.(Math.min(1, rms * 9))
      const elapsed = now - startedAt
      if ((!spoke && elapsed > startTimeoutMs) || (spoke && now - lastVoice > silenceMs) || elapsed > MAX_SECONDS * 1000) finish()
    }
    rec.start()
    // A timer, not requestAnimationFrame: rAF pauses in background tabs and would
    // leave the mic open. Plus a hard stop no matter what.
    iv = setInterval(tick, 33)
    hard = setTimeout(finish, MAX_SECONDS * 1000 + 500)
    await stopped
    stream.getTracks().forEach((t) => t.stop())
    ctx.close()
    onLevel?.(0)
    if (cancelled || !spoke || !chunks.length) return null
    return { blob: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), seconds: (Date.now() - startedAt) / 1000 }
  })()
  return { done, cancel: () => cancelFn() }
}

// Chrome loads the voice list asynchronously — warm it up so the first reply
// (the greeting) already gets the Indian English / Hindi voice.
let voicesReady = null
function loadVoices() {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
  if (!synth) return Promise.resolve()
  if (synth.getVoices().length) return Promise.resolve()
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const done = () => resolve()
      synth.addEventListener?.('voiceschanged', done, { once: true })
      setTimeout(done, 600)
    })
  }
  return voicesReady
}
loadVoices()

// ── Choosing a voice ────────────────────────────────────────────────────────
// Goal: a calm, natural voice that reads BOTH English and Hindi properly.
//  - Each sentence is read by a voice for its own script: Devanagari → a Hindi
//    voice, Latin → an Indian-English voice, so a reply that mixes the two never
//    gets English words mangled by a Hindi voice or Hindi read letter-by-letter.
//  - Voices are ranked: the operator's pick first, then neural/"Natural" voices
//    (Edge / Windows 11 online voices), then Google's, then local ones; a calm
//    male voice is preferred by default to match the VARUNA persona.
const PREF_KEY = 'varuna.voice'

function readPrefs() {
  try {
    return { en: '', hi: '', rate: 1, gender: 'male', ...(JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}) }
  } catch {
    return { en: '', hi: '', rate: 1, gender: 'male' }
  }
}
export function getVoicePrefs() {
  return readPrefs()
}
export function setVoicePrefs(patch) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...patch }))
  } catch {
    /* private mode */
  }
}

const MALE_NAMES = /\b(ravi|prabhat|hemant|madhur|guy|mark|david|daniel|ryan|george|rishi|male)\b/i
const FEMALE_NAMES = /\b(neerja|swara|heera|kalpana|zira|aria|jenny|samantha|susan|hazel|female)\b/i
const norm = (l) => String(l || '').replace('_', '-')

function allVoices() {
  return window.speechSynthesis?.getVoices?.() || []
}

/** Voices for a language ('en' | 'hi'), best first — also feeds the settings picker. */
export function voicesFor(lang) {
  const prefs = readPrefs()
  const chosen = lang === 'hi' ? prefs.hi : prefs.en
  const wantLocale = lang === 'hi' ? ['hi-IN'] : ['en-IN', 'en-GB', 'en-AU', 'en-US']
  const scored = []
  for (const v of allVoices()) {
    const l = norm(v.lang)
    if (!l.toLowerCase().startsWith(lang)) continue
    let score = 0
    if (v.name === chosen) score += 1000
    const idx = wantLocale.indexOf(l)
    score += idx >= 0 ? 60 - idx * 8 : 0
    if (/natural|neural|online/i.test(v.name)) score += 40
    else if (/google/i.test(v.name)) score += 18
    if (prefs.gender === 'male' && MALE_NAMES.test(v.name)) score += 45
    if (prefs.gender === 'female' && FEMALE_NAMES.test(v.name)) score += 45
    if (!v.localService) score += 2
    scored.push({ v, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.v)
}

// Say symbols and abbreviations the way a person would, in the sentence's language.
function forSpeech(text, hindi) {
  let t = text
    .replace(/[*_`#>~|]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bRTH\b/g, 'return to home')
    .replace(/\bUAV\b/g, 'drone')
    .replace(/\s+/g, ' ')
    .trim()
  t = t
    .replace(/(\d)\s?km\/h\b/gi, hindi ? '$1 किलोमीटर प्रति घंटा' : '$1 kilometres per hour')
    .replace(/(\d)\s?m\/s\b/gi, hindi ? '$1 मीटर प्रति सेकंड' : '$1 metres per second')
    .replace(/(\d)\s?°\s?C\b/g, hindi ? '$1 डिग्री सेल्सियस' : '$1 degrees Celsius')
    .replace(/(\d)\s?%/g, hindi ? '$1 प्रतिशत' : '$1 percent')
    .replace(/(\d)\s?m\b/g, hindi ? '$1 मीटर' : '$1 metres')
    .replace(/(\d)\s?km\b/gi, hindi ? '$1 किलोमीटर' : '$1 kilometres')
  return t
}

// Split a reply into chunks, each tagged with the language to read it in. Works
// word by word inside every sentence: Devanagari words always go to the Hindi
// voice (an English voice cannot read them); a run of 3+ Latin words becomes its
// own English chunk; a stray English word or two ("GPS", "mission") stays inside
// the Hindi chunk, where a Hindi voice reads it fine and the rhythm isn't broken.
function toChunks(text) {
  const sentences = text.split(/(?<=[.!?।])\s+|\n+/).filter((x) => x.trim())
  const out = []
  const push = (lang, words) => {
    const t = words.join(' ').trim()
    if (!t) return
    const last = out[out.length - 1]
    if (last && last.lang === lang && last.text.length + t.length < 220) last.text += ` ${t}`
    else out.push({ lang, text: t })
  }
  for (const raw of sentences) {
    const words = raw.trim().split(/\s+/).filter(Boolean)
    if (!words.length) continue
    if (!words.some((w) => /[ऀ-ॿ]/.test(w))) {
      push('en', words)
      continue
    }
    // runs of Latin words (digits and punctuation travel with their neighbour)
    const runs = []
    for (const w of words) {
      const lang = /[ऀ-ॿ]/.test(w) ? 'hi' : /[A-Za-z]/.test(w) ? 'en' : null
      const last = runs[runs.length - 1]
      if (last && (lang === null || lang === last.lang)) last.words.push(w)
      else if (lang === null) runs.push({ lang: 'hi', words: [w] })
      else runs.push({ lang, words: [w] })
    }
    for (const r of runs) {
      const latinWords = r.words.filter((w) => /[A-Za-z]/.test(w)).length
      push(r.lang === 'en' && latinWords >= 3 ? 'en' : 'hi', r.words)
    }
  }
  return out
}

let speakGen = 0

/**
 * Speak `text`. Resolves when done (or immediately if speech isn't available).
 * `onWord` fires on each word boundary (drives the orb's talking animation).
 */
export function speak(text, { onWord } = {}) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth || !text) return resolve()
    loadVoices().then(async () => {
      try {
        const gen = ++speakGen
        synth.cancel()
        noteSpokenLanguage(text)
        for (const c of toChunks(text)) {
          if (gen !== speakGen) break // interrupted (stopSpeaking / a newer reply)
          const clean = forSpeech(c.text, c.lang === 'hi')
          if (clean) await speakChunk(synth, clean, c.lang, onWord)
        }
      } catch {
        /* a speech failure must never leave the assistant waiting forever */
      } finally {
        resolve()
      }
    })
  })
}

function speakChunk(synth, clean, lang, onWord) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean)
    const voice = voicesFor(lang)[0]
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN'
    try {
      if (voice) {
        u.voice = voice
        u.lang = voice.lang
      }
    } catch {
      /* unusable voice object — fall back to the language default */
    }
    // Slightly lower than default and a touch slower: composed and clear.
    const rate = Number(readPrefs().rate) || 1
    u.rate = Math.min(1.4, Math.max(0.7, 0.97 * rate))
    u.pitch = 0.94
    let settled = false
    let guard = 0
    const startedAt = Date.now()
    const end = () => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve()
    }
    // Some browsers never fire onend. Only give up once the engine has really
    // gone quiet — resolving while it still talks would make the assistant
    // record (and answer) its own voice. Absolute cap per chunk: 60 s.
    const check = () => {
      if (settled) return
      if (Date.now() - startedAt > 60000) {
        synth.cancel()
        return end()
      }
      if (synth.speaking || synth.pending) guard = setTimeout(check, 500)
      else end()
    }
    u.onboundary = () => onWord?.()
    u.onend = end
    u.onerror = end
    guard = setTimeout(check, 1500 + clean.length * 70)
    synth.speak(u)
  })
}

export function stopSpeaking() {
  speakGen++
  window.speechSynthesis?.cancel()
}

/** A soft two-note "I'm listening" tone (~0.3 s), played the moment Varuna wakes. */
export function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const t0 = ctx.currentTime + 0.01
    ;[659.25, 987.77].forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const t = t0 + i * 0.11
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.16, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + 0.24)
    })
    setTimeout(() => ctx.close(), 600)
  } catch {
    /* no audio output — the orb still shows it's awake */
  }
}

/** Say a short sample in both languages (for the voice settings "Test" button). */
export async function speakSample() {
  await speak('नमस्ते, मैं वरुण हूँ। मैं आपकी ड्रोन उड़ान में मदद करूँगा।')
  await speak('Hello, I am Varuna, your co-pilot. Battery is at seventy percent, link is stable.')
}

// Which language the operator is using right now: lets the browser recogniser
// listen in Hindi after a Hindi exchange (it can only listen in one at a time).
let sttLang = 'en-IN'
function noteSpokenLanguage(text) {
  const dev = (text.match(/[ऀ-ॿ]/g) || []).length
  const lat = (text.match(/[A-Za-z]/g) || []).length
  sttLang = dev > lat * 0.25 ? 'hi-IN' : 'en-IN'
}
/** Tell the voice layer what the operator just said (so listening follows their language). */
export function noteUserText(text) {
  if (text) noteSpokenLanguage(text)
}
export function currentSttLang() {
  return sttLang
}

// -------- Browser-native speech-to-text (Chrome/Edge webkitSpeechRecognition) --
// Used when the assistant provider isn't Groq (no Whisper key), so the whole
// pipeline can stay off the network. Accuracy is lower than Whisper for
// Hinglish / accents, but it's genuinely free and offline.
const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null

export const browserSttSupported = !!Recognition

/**
 * Same shape as listenUntilSilence but returns TEXT instead of an audio blob.
 * @param {object} o
 * @param {(level:number)=>void} [o.onLevel]  mic level 0..1, ~10x/sec
 * @param {number} [o.startTimeoutMs]
 * @param {number} [o.silenceMs]
 * @param {string} [o.lang]  follows the current exchange: 'hi-IN' after Hindi, else 'en-IN'
 * @returns {{ done: Promise<{text:string, seconds:number}|null>, cancel: () => void }}
 */
export function browserListenToText({ onLevel, startTimeoutMs = 7000, silenceMs = 1300, lang = sttLang } = {}) {
  if (!Recognition) {
    return { done: Promise.resolve(null), cancel: () => {} }
  }
  let cancelled = false
  let cancelFn = () => {
    cancelled = true
  }
  const done = (async () => {
    // Run a parallel mic-level analyser so the orb still animates — the
    // browser's speech recognizer doesn't expose amplitude directly.
    let ctx, analyser, mediaStream, levelIv
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const Ctx = window.AudioContext || window.webkitAudioContext
      ctx = new Ctx()
      const src = ctx.createMediaStreamSource(mediaStream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      levelIv = setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 9))
      }, 60)
    } catch {
      /* mic unavailable — recognizer will still try but the orb won't react */
    }

    const rec = new Recognition()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    const startedAt = Date.now()
    let finalText = ''
    let interim = ''
    let anySpeech = false
    let lastSpeechAt = 0
    let silenceTimer = 0
    let startTimeout = 0
    let hardTimeout = 0

    const cleanup = () => {
      clearTimeout(silenceTimer)
      clearTimeout(startTimeout)
      clearTimeout(hardTimeout)
      clearInterval(levelIv)
      try { rec.abort() } catch { /* ignore */ }
      try { mediaStream?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      try { ctx?.close() } catch { /* ignore */ }
      onLevel?.(0)
    }

    let resolveDone
    const donePromise = new Promise((r) => (resolveDone = r))
    const finish = (text) => {
      cleanup()
      if (cancelled) return resolveDone(null)
      const seconds = (Date.now() - startedAt) / 1000
      resolveDone(text ? { text, seconds } : null)
    }

    cancelFn = () => {
      cancelled = true
      finish(null)
    }

    rec.onresult = (e) => {
      anySpeech = true
      lastSpeechAt = Date.now()
      interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += (finalText ? ' ' : '') + r[0].transcript
        else interim += r[0].transcript
      }
      // Rearm the silence timer whenever new speech comes in.
      clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => finish((finalText + ' ' + interim).trim()), silenceMs)
    }
    rec.onerror = (e) => {
      if (e.error === 'no-speech') return // silence is expected during pauses
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') return finish(null)
      // Any other error: finish with whatever we captured (may be nothing).
      finish((finalText + ' ' + interim).trim() || null)
    }
    rec.onend = () => {
      // Never fire before the silence-timer path — but as a safety net, resolve
      // with the accumulated text if the engine closes on its own.
      finish((finalText + ' ' + interim).trim() || null)
    }

    try {
      rec.start()
    } catch (e) {
      finish(null)
      return null
    }
    // No speech within the start window → give up.
    startTimeout = setTimeout(() => {
      if (!anySpeech) finish(null)
    }, startTimeoutMs)
    // Hard cap so a stuck engine can't hold the mic forever.
    hardTimeout = setTimeout(() => finish((finalText + ' ' + interim).trim() || null), 20000)

    return donePromise
  })()
  return { done, cancel: () => cancelFn() }
}
