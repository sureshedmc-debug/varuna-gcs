// Google Gemini client (browser-side) for generating the trash-detection report.
//
// The user supplies their own Gemini API key (stored in localStorage). There is
// no user-facing prompt box: buildPrompt() below is a fixed, built-in default
// prompt that turns the detection dataset into a structured environmental report.

const DEFAULT_MODEL = 'gemini-2.0-flash'
const KEY_STORE = 'varuna.geminiKey'
const MODEL_STORE = 'varuna.geminiModel'

export function getGeminiKey() {
  try {
    return localStorage.getItem(KEY_STORE) || ''
  } catch {
    return ''
  }
}
export function setGeminiKey(k) {
  try {
    localStorage.setItem(KEY_STORE, k || '')
  } catch {
    /* private mode */
  }
}
export function getGeminiModel() {
  try {
    return localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}
export function setGeminiModel(m) {
  try {
    localStorage.setItem(MODEL_STORE, m || DEFAULT_MODEL)
  } catch {
    /* private mode */
  }
}

const SCHEMA_HINT = `Respond with ONLY a single valid JSON object (no markdown fences) with exactly these string/array fields:
{
  "title": string,
  "executiveSummary": string,
  "keyFindings": string[],
  "classAnalysis": string,
  "spatialAnalysis": string,
  "temporalAnalysis": string,
  "environmentalImpact": string,
  "recommendations": string[],
  "dataQualityNotes": string
}`

// The fixed default prompt. No user input is injected beyond the dataset.
function buildPrompt(data) {
  return `You are a senior environmental data analyst working with VARUNA, an autonomous river-cleanup drone that uses onboard AI to detect floating trash (plastic bottles, bags, general debris) on waterways.

Analyze the trash-detection dataset below and write a professional, well-structured environmental report suitable for a government/NGO stakeholder. Requirements:
- Cite the actual numbers from the dataset (totals, per-class counts, average confidence, located vs unlocated, live-camera peak).
- Interpret spatial patterns from the GPS coordinates where present (clustering, hotspots) and temporal patterns from timestamps.
- Assess environmental impact of the detected debris on the river ecosystem.
- Give concrete, prioritized cleanup recommendations for drone operations.
- If the dataset is small or sparse, state that plainly in dataQualityNotes and still give best-effort analysis. Never invent data points that are not present.

${SCHEMA_HINT}

DATASET (JSON):
${JSON.stringify(data)}`
}

/**
 * Call Gemini and return the parsed report object.
 * Throws on missing key, network error, HTTP error, or empty response.
 */
export async function generateReportNarrative(data, { key, model, signal } = {}) {
  const apiKey = key || getGeminiKey()
  if (!apiKey) throw new Error('Missing Gemini API key')
  const useModel = model || getGeminiModel()
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    useModel,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(data) }] }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || ''
    } catch {
      /* ignore */
    }
    throw new Error(`Gemini API error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const json = await res.json()
  const cand = json?.candidates?.[0]
  const text = (cand?.content?.parts || [])
    .map((p) => p?.text || '')
    .join('')
    .trim()
  if (!text) {
    const blocked = json?.promptFeedback?.blockReason
    throw new Error(blocked ? `Gemini blocked the request (${blocked})` : 'Gemini returned an empty response')
  }

  const parsed = parseJsonLoose(text)
  if (!parsed) {
    // Not JSON — surface the raw text as the summary so the doc still has content.
    return { executiveSummary: text }
  }
  return parsed
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    /* fall through */
  }
  // Strip ```json fences if present, then grab the outermost {...} block.
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    /* fall through */
  }
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch {
      /* give up */
    }
  }
  return null
}
