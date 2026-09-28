// Voice in/out for the VARUNA assistant.
//  - listenUntilSilence(): records the operator's command and stops by itself
//    once they stop talking (simple energy-based voice-activity detection);
//    also streams the live mic level so the orb can react. The clip
//    (webm/opus in Chrome) goes to Groq Whisper (groqClient.js).
//  - speak(): the browser's speechSynthesis with an Indian English / Hindi
//    voice; resolves when finished and reports word boundaries so the orb
//    can "talk" in time with the voice.

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

// A calmer, more composed-sounding voice than the OS default, when one of
// these happens to be installed — purely a taste preference (a measured,
// unhurried co-pilot tone), never required; falls straight through to the
// ordinary language-matched pick below if none of these exist on this device.
const CALM_VOICE_NAMES = ['Microsoft Ravi', 'Microsoft Guy', 'Microsoft Mark', 'Google UK English Male', 'Daniel']

// Devanagari → Hindi voice; otherwise Indian English (reads Hinglish well).
function pickVoice(text) {
  const voices = window.speechSynthesis?.getVoices?.() || []
  const hindi = /[ऀ-ॿ]/.test(text)
  if (!hindi) {
    for (const name of CALM_VOICE_NAMES) {
      const v = voices.find((x) => x.name === name)
      if (v) return v
    }
  }
  const want = hindi ? ['hi-IN'] : ['en-IN', 'hi-IN', 'en-GB', 'en-US']
  for (const lang of want) {
    const v = voices.find((x) => (x.lang || '').replace('_', '-') === lang)
    if (v) return v
  }
  return null
}

/**
 * Speak `text`. Resolves when done (or immediately if speech isn't available).
 * `onWord` fires on each word boundary (drives the orb's talking animation).
 */
export function speak(text, { onWord } = {}) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth || !text) return resolve()
    loadVoices().then(() => speakNow(synth, text, onWord, resolve))
  })
}

function speakNow(synth, text, onWord, resolve) {
  synth.cancel()
  const clean = text.replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, '')
  const u = new SpeechSynthesisUtterance(clean)
  const voice = pickVoice(clean)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  }
  // Slightly slower and a touch lower than the default — reads as composed
  // and measured rather than rushed; still comfortably intelligible.
  u.rate = 0.97
  u.pitch = 0.92
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
  // record (and answer) its own voice. Absolute cap: 2 minutes, then cancel.
  const check = () => {
    if (settled) return
    if (Date.now() - startedAt > 120000) {
      synth.cancel()
      return end()
    }
    if (synth.speaking || synth.pending) guard = setTimeout(check, 500)
    else end()
  }
  u.onboundary = () => onWord?.()
  u.onend = end
  u.onerror = end
  guard = setTimeout(check, 1500 + clean.length * 60)
  synth.speak(u)
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel()
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
 * @param {string} [o.lang]  'en-IN' by default (Whisper's Hinglish substitute)
 * @returns {{ done: Promise<{text:string, seconds:number}|null>, cancel: () => void }}
 */
export function browserListenToText({ onLevel, startTimeoutMs = 7000, silenceMs = 1300, lang = 'en-IN' } = {}) {
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
