// One unified OpenAI-compatible chat client for every provider in
// llmProviders.js. Talks to /chat/completions with the standard shape
// (messages, tools, tool_choice, response_format, temperature, max_tokens).
// Response shape is passed through unchanged so callers can keep reading
// `json.choices[0].message` exactly as they did with the old Groq client.

import { getProvider } from './llmProviders'

const TIMEOUT_MS = 30000

async function errorOf(res, providerId) {
  // Read the body ONCE as text — a Response body can only be consumed once,
  // so a failed res.json() leaves nothing for a fallback res.text() to read
  // (it throws "body already used", silently swallowed, detail stays '').
  let detail = ''
  try {
    const raw = (await res.text()).trim()
    try {
      const body = JSON.parse(raw)
      detail = body?.error?.message || body?.error || body?.message || raw
    } catch {
      detail = raw // not JSON — surface the raw text itself (e.g. an HTML gateway-error page's title, a plain-text error)
    }
    if (detail && typeof detail !== 'string') detail = JSON.stringify(detail)
    detail = detail.slice(0, 300)
  } catch {
    /* body unreadable (already consumed by the caller, or a stream error) */
  }
  const err = new Error(`${providerId} ${res.status}${detail ? `: ${detail}` : ''}`)
  err.status = res.status
  err.detail = detail
  err.providerId = providerId
  return err
}

async function timedFetch(url, opts) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('The AI service took too long to answer — try again.')
    throw e
  } finally {
    clearTimeout(t)
  }
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '')
}

/**
 * One chat-completions call against the configured provider.
 * @param {object} p
 * @param {object} p.config    {provider, model, apiKey, baseUrl}
 * @param {Array}  p.messages  OpenAI-shaped messages
 * @param {Array}  [p.tools]   OpenAI-shaped tool declarations
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {boolean}[p.json]    ask the model for a JSON object reply
 * @returns The raw provider response (same shape as OpenAI chat completions).
 */
// Some models (e.g. reasoning models available through OpenRouter) spend part
// of max_tokens on an internal reasoning trace before emitting the actual
// answer, which counts against the same budget as `content`. 2048 gives that
// headroom without meaningfully increasing cost on models that don't reason.
export async function llmChat({ config, messages, tools, temperature = 0.3, maxTokens = 2048, json = false }) {
  if (!config?.model) throw new Error('NO_MODEL')
  const provider = getProvider(config.provider)
  if (provider.requiresKey && !config.apiKey) throw new Error('NO_KEY')
  const baseUrl = trimSlash(config.baseUrl || provider.baseUrl)
  if (!baseUrl) throw new Error('NO_BASE_URL')

  const body = { model: config.model, messages, temperature, max_tokens: maxTokens }
  if (json) body.response_format = { type: 'json_object' }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const headers = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  // OpenRouter wants a Referer/Title for the free-tier attribution, doesn't
  // fail without them but is friendlier with them.
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = typeof window !== 'undefined' ? window.location.origin : 'https://varuna.local'
    headers['X-Title'] = 'VARUNA GCS'
  }

  const fetchOpts = { method: 'POST', headers, body: JSON.stringify(body) }

  const res = await timedFetch(`${baseUrl}/chat/completions`, fetchOpts)
  if (!res.ok) throw await errorOf(res, provider.id)
  return res.json()
}

/**
 * Ping a config to see whether it can actually answer. Returns
 * { ok, error?, latencyMs? }. Used by the settings UI's "Test" button.
 */
export async function testLlmConfig(config) {
  const t0 = Date.now()
  try {
    const json = await llmChat({
      config,
      messages: [{ role: 'user', content: 'Reply with a single word: ok' }],
      // Generous even for a thinking model's reasoning preamble — this is a
      // one-off connectivity check, not a hot path, so cost doesn't matter.
      maxTokens: 300,
      temperature: 0,
    })
    const msg = json?.choices?.[0]?.message || {}
    const finishReason = json?.choices?.[0]?.finish_reason
    const text = (msg.content || '').trim()
    if (text) return { ok: true, latencyMs: Date.now() - t0, sample: text.slice(0, 60) }
    // A thinking model can still exhaust the budget on reasoning alone. Surface
    // that plainly instead of a bare "empty response" — the fix is the same
    // budget knob, just needs to go higher for this particular model.
    if (finishReason === 'length') {
      return {
        ok: false,
        error: `${config.model} used its whole reply budget on internal reasoning before answering (finish_reason: length). This is a thinking model — it still works, it just needs more headroom. Try a shorter prompt or a smaller/faster model if this keeps happening in real use.`,
      }
    }
    return { ok: false, error: 'The model returned an empty response.' }
  } catch (e) {
    return { ok: false, error: e?.message || String(e), status: e?.status }
  }
}
