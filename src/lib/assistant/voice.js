// Voice in/out for the assistant.
//  - Recording: MediaRecorder; the clip (webm/opus in Chrome) goes straight to
//    Groq Whisper for speech-to-text (see groqClient.js).
//  - Speaking: the browser's speechSynthesis, picking an Indian English /
//    Hindi voice when available so Hinglish replies sound natural.

const MAX_SECONDS = 30

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  let rec
  try {
    rec = new MediaRecorder(stream)
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop()) // never leave the mic live
    throw e
  }
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const startedAt = Date.now()
  rec.start()
  const autoStop = setTimeout(() => rec.state !== 'inactive' && rec.stop(), MAX_SECONDS * 1000)
  const done = new Promise((resolve) => {
    rec.onstop = () => {
      clearTimeout(autoStop)
      stream.getTracks().forEach((t) => t.stop())
      resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
    }
  })
  return {
    /** Stop and get { blob, seconds } (null if too short / empty). */
    async stop() {
      if (rec.state !== 'inactive') rec.stop()
      const blob = await done
      const seconds = (Date.now() - startedAt) / 1000
      if (seconds < 0.5 || !blob.size) return null
      return { blob, seconds }
    },
    cancel() {
      if (rec.state !== 'inactive') rec.stop()
    },
  }
}

// Devanagari → Hindi voice; otherwise Indian English (reads Hinglish well).
function pickVoice(text) {
  const voices = window.speechSynthesis?.getVoices?.() || []
  const hindi = /[ऀ-ॿ]/.test(text)
  const want = hindi ? ['hi-IN'] : ['en-IN', 'hi-IN', 'en-GB', 'en-US']
  for (const lang of want) {
    const v = voices.find((x) => x.lang === lang) || voices.find((x) => x.lang?.startsWith(lang.split('-')[0]) && lang.startsWith('hi'))
    if (v) return v
  }
  return null
}

export function speak(text) {
  const synth = window.speechSynthesis
  if (!synth || !text) return
  synth.cancel()
  const clean = text.replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, '')
  const u = new SpeechSynthesisUtterance(clean)
  const voice = pickVoice(clean)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  }
  u.rate = 1.05
  synth.speak(u)
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel()
}
