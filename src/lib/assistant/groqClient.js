// Groq API client for the VARUNA assistant (OpenAI-compatible endpoints):
//  - chat completions with tool calling (the assistant's brain)
//  - Whisper speech-to-text (voice commands in English / Hindi / Hinglish)
// The user supplies their own Groq API key, stored only in this browser.

const BASE = 'https://api.groq.com/openai/v1'
const KEY_STORE = 'varuna.groqKey'
const MODEL_STORE = 'varuna.groqModel'
export const DEFAULT_MODEL = 'llama-3.3-70b-versatile'
// Tried in order if the configured model is retired/unavailable on Groq.
const FALLBACK_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct']
const STT_MODEL = 'whisper-large-v3' // multilingual; handles Hindi + English mixing
// Biases Whisper toward Roman-script Hinglish and the app's vocabulary.
const STT_PROMPT = 'VARUNA drone app. Hinglish in Roman script, e.g.: is lake ka mission banao, kinaare ka round, drone ko wapas ghar lao, battery kitni hai, return to home, takeoff, Hussain Sagar.'

export function getGroqKey() {
  try {
    return localStorage.getItem(KEY_STORE) || ''
  } catch {
    return ''
  }
}
export function setGroqKey(k) {
  try {
    localStorage.setItem(KEY_STORE, k || '')
  } catch {
    /* private mode */
  }
}
export function getGroqModel() {
  try {
    return localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

async function errorOf(res) {
  let detail = ''
  try {
    detail = (await res.json())?.error?.message || ''
  } catch {
    /* ignore */
  }
  const err = new Error(`Groq ${res.status}${detail ? `: ${detail}` : ''}`)
  err.status = res.status
  err.detail = detail
  return err
}

const TIMEOUT_MS = 30000

// fetch that gives up after TIMEOUT_MS, so a stuck request can't freeze the assistant.
async function timedFetch(url, opts) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } catch (e) {
    throw e?.name === 'AbortError' ? new Error('Groq took too long to answer — check the internet connection and try again.') : e
  } finally {
    clearTimeout(t)
  }
}

let working = null // { model, forSetting } — the model that last worked for the current setting

/**
 * One chat-completions call; falls back through FALLBACK_MODELS if a model is gone.
 * `key` overrides the assistant's key (the Word report uses its own Groq key);
 * `json: true` asks for a JSON object reply.
 */
export async function groqChat({ messages, tools, key: keyOverride, temperature = 0.3, maxTokens = 800, json = false }) {
  const key = keyOverride || getGroqKey()
  if (!key) throw new Error('NO_KEY')
  const first = getGroqModel()
  if (working && working.forSetting !== first) working = null // setting changed
  const all = [first, ...FALLBACK_MODELS.filter((m) => m !== first)]
  const models = working ? [working.model, ...all.filter((m) => m !== working.model)] : all
  let lastErr
  for (const model of models) {
    const body = { model, messages, temperature, max_tokens: maxTokens }
    if (json) body.response_format = { type: 'json_object' }
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto' // only valid alongside tools
    }
    const res = await timedFetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      working = { model, forSetting: first }
      return res.json()
    }
    lastErr = await errorOf(res)
    // Only move on to another model for "model not found / decommissioned".
    if (!(res.status === 404 || (res.status === 400 && /model/i.test(lastErr.detail)))) throw lastErr
    if (working?.model === model) working = null
  }
  throw lastErr
}

/** Speech → text with Groq Whisper. `blob` is the browser recording (webm/ogg/wav are accepted).
 *  Pass `apiKey` explicitly (e.g. the assistant's LLM config key when it's Groq);
 *  falls back to the legacy stand-alone Groq key for backward compat. */
export async function groqTranscribe(blob, { apiKey } = {}) {
  const key = apiKey || getGroqKey()
  if (!key) throw new Error('NO_KEY')
  const ext = /ogg/.test(blob.type) ? 'ogg' : /wav/.test(blob.type) ? 'wav' : /mp4/.test(blob.type) ? 'm4a' : 'webm'
  const form = new FormData()
  form.append('file', blob, `voice.${ext}`)
  form.append('model', STT_MODEL)
  form.append('prompt', STT_PROMPT)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  const res = await timedFetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form })
  if (!res.ok) throw await errorOf(res)
  return ((await res.json())?.text || '').trim()
}
