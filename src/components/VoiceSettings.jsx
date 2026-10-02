import { useEffect, useState } from 'react'
import { getVoicePrefs, setVoicePrefs, speakSample, stopSpeaking, voicesFor } from '../lib/assistant/voice'

// Voice picker for the assistant: one voice for English, one for Hindi, a speed
// and a male/female leaning. "Automatic" lets the app choose the best installed
// voice (neural/natural voices first). Stored in this browser only.

function useVoiceList() {
  const [, bump] = useState(0)
  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return undefined
    const on = () => bump((n) => n + 1)
    synth.addEventListener?.('voiceschanged', on)
    return () => synth.removeEventListener?.('voiceschanged', on)
  }, [])
  return { en: voicesFor('en'), hi: voicesFor('hi') }
}

const label = (v) => `${v.name.replace(/^(Microsoft|Google)\s+/i, '')} · ${v.lang}${/natural|neural|online/i.test(v.name) ? ' ★' : ''}`

export default function VoiceSettings() {
  const voices = useVoiceList()
  const [prefs, setPrefs] = useState(getVoicePrefs)
  const [playing, setPlaying] = useState(false)

  function update(patch) {
    setVoicePrefs(patch)
    setPrefs(getVoicePrefs())
  }
  async function test() {
    setPlaying(true)
    try {
      await speakSample()
    } finally {
      setPlaying(false)
    }
  }

  const row = 'mb-2 flex flex-col gap-1 text-[11px] text-muted'
  const sel = 'inp w-full px-2 py-1 text-[12px]'
  return (
    <div className="mb-3 rounded-lg border border-line p-2.5">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-faint">Voice</div>

      <label className={row}>
        English voice
        <select className={sel} value={prefs.en} onChange={(e) => update({ en: e.target.value })}>
          <option value="">Automatic (best available)</option>
          {voices.en.map((v) => (
            <option key={v.name} value={v.name}>{label(v)}</option>
          ))}
        </select>
      </label>

      <label className={row}>
        Hindi voice
        <select className={sel} value={prefs.hi} onChange={(e) => update({ hi: e.target.value })}>
          <option value="">Automatic (best available)</option>
          {voices.hi.map((v) => (
            <option key={v.name} value={v.name}>{label(v)}</option>
          ))}
        </select>
      </label>
      {!voices.hi.length && (
        <div className="mb-2 text-[11px]" style={{ color: '#FF9F0A' }}>
          No Hindi voice is installed. On Windows: Settings → Time &amp; language → Speech → Add voices → Hindi (India). Without it, Hindi replies are read by an English voice.
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="shrink-0">Prefer</span>
        {['male', 'female'].map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => update({ gender: g })}
            className="rounded-md px-2 py-0.5 font-semibold capitalize"
            style={{ background: prefs.gender === g ? 'var(--accent-hex)' : 'var(--chip)', color: prefs.gender === g ? '#fff' : 'var(--muted)' }}
          >
            {g}
          </button>
        ))}
      </div>

      <label className={row}>
        Speed · {Number(prefs.rate).toFixed(2)}×
        <input type="range" min="0.7" max="1.3" step="0.05" value={prefs.rate} onChange={(e) => update({ rate: Number(e.target.value) })} />
      </label>

      <div className="flex gap-2">
        <button type="button" onClick={test} disabled={playing} className="rounded-md bg-accent px-3 py-1 text-[11px] font-bold text-white disabled:opacity-50">
          {playing ? 'Speaking…' : 'Test voice (हिंदी + English)'}
        </button>
        {playing && (
          <button type="button" onClick={() => { stopSpeaking(); setPlaying(false) }} className="rounded-md bg-chip px-3 py-1 text-[11px] font-semibold text-muted">
            Stop
          </button>
        )}
      </div>
      <div className="mt-1.5 text-[10px] text-faint">★ = natural / neural voice (sounds most human).</div>
    </div>
  )
}
