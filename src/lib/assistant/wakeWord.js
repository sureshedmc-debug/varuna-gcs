// "Hi Varuna" wake word, using the browser's built-in speech recognition
// (Chrome / Edge: webkitSpeechRecognition). It listens continuously in the
// background and only reacts to the wake phrase; everything after waking is
// recorded separately and transcribed by Groq Whisper (see VoiceAssistant).
//
// Privacy note: in Chrome/Edge the browser's recognizer sends this background
// audio to the browser vendor's speech service — the user can switch the wake
// word off (tap-to-talk keeps working).

const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null

export const wakeWordSupported = !!Recognition

/** Whether the operator has the wake word switched on (default on). */
export function wakeWordEnabled() {
  try {
    return localStorage.getItem('varuna.wakeWord') !== '0'
  } catch {
    return true
  }
}

// Tolerant to common mis-hearings of "Varuna" in Indian English / Hindi.
const NAME = '(?:varuna|waruna|baruna|veruna|varunaa|varun|barun|warna|varna|buruna|bharuna|wardha)'
const WAKE_RE = new RegExp(`\\b(?:hi|high|hey|hai|hay|hello|helo|ok|okay|oye|hii)\\s*[,.!]?\\s*${NAME}\\b[\\s,.!]*(.*)$`, 'i')

/** If `text` contains the wake phrase, returns { rest } (words said after it); else null. */
export function matchWake(text) {
  const m = String(text || '').match(WAKE_RE)
  return m ? { rest: (m[1] || '').trim() } : null
}

/**
 * Start listening for the wake phrase. Returns a controller:
 *   { stop(), pause(), resume(), isRunning() }
 * `onWake({ rest })` fires once per wake; listening pauses until resume().
 */
export function createWakeListener({ onWake, onState = () => {}, lang = 'en-IN' }) {
  if (!Recognition) {
    // eslint-disable-next-line no-console
    console.warn('[wakeWord] SpeechRecognition is not available in this runtime — wake word cannot work here.')
    return null
  }
  let rec = null
  let wanted = false // should be listening
  let paused = false
  let restartTimer = null
  let fails = 0

  function start() {
    if (!wanted || paused || rec) return
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
    let latest = null // newest wake hit seen in this utterance
    let settle = 0
    const fire = () => {
      clearTimeout(settle)
      if (!latest || rec !== r0) return
      const hit = latest
      latest = null
      fails = 0
      paused = true
      try {
        r0.abort()
      } catch {
        /* ignore */
      }
      onWake(hit)
    }
    r0.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        for (let a = 0; a < r.length; a++) {
          // eslint-disable-next-line no-console
          console.debug('[wakeWord] heard:', JSON.stringify(r[a].transcript), r.isFinal ? '(final)' : '(interim)')
          const hit = matchWake(r[a].transcript)
          if (!hit) continue
          latest = hit
          // Final result → act now. Interim → wait a moment: words usually keep
          // arriving ("Hi Varuna, plan a mission…"), so the command isn't lost.
          if (r.isFinal) return fire()
          clearTimeout(settle)
          settle = setTimeout(fire, hit.rest ? 1500 : 800)
          break
        }
      }
    }
    r0.onerror = (e) => {
      // eslint-disable-next-line no-console
      console.warn('[wakeWord] recognition error:', e.error)
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wanted = false
        onState('blocked')
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        fails++
      }
    }
    r0.onend = () => {
      clearTimeout(settle)
      if (rec !== r0) return // an older instance ending — the current one is fine
      rec = null
      // eslint-disable-next-line no-console
      console.debug('[wakeWord] recognition ended', wanted && !paused ? '(restarting)' : '(staying stopped)')
      // Chrome ends continuous recognition every ~minute or on silence: restart.
      if (wanted && !paused) {
        clearTimeout(restartTimer)
        restartTimer = setTimeout(start, Math.min(10000, 300 * 2 ** Math.min(fails, 5)))
      }
    }
    try {
      rec.start()
      // eslint-disable-next-line no-console
      console.debug('[wakeWord] recognition started')
      onState('listening')
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wakeWord] rec.start() threw:', e?.message || e)
      rec = null
    }
  }

  function halt() {
    clearTimeout(restartTimer)
    if (rec) {
      try {
        rec.abort()
      } catch {
        /* ignore */
      }
      rec = null
    }
  }

  wanted = true
  start()
  return {
    stop() {
      wanted = false
      halt()
      onState('off')
    },
    pause() {
      paused = true
      halt()
    },
    resume() {
      paused = false
      if (wanted) start()
    },
    isRunning: () => wanted && !paused,
  }
}
