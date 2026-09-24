// AI-written analysis for the Word trash report, via Groq. Uses its OWN Groq
// API key (separate from the VARUNA Assist chatbot's key), stored only in this
// browser. With no key, the report falls back to the built-in narrative
// (reportDoc.fallbackNarrative).

import { groqChat } from './assistant/groqClient'

const KEY_STORE = 'varuna.groqReportKey'

export function getReportKey() {
  try {
    return localStorage.getItem(KEY_STORE) || ''
  } catch {
    return ''
  }
}
export function setReportKey(k) {
  try {
    localStorage.setItem(KEY_STORE, k || '')
  } catch {
    /* private mode */
  }
}

const SCHEMA_HINT = `Respond with ONLY a single valid JSON object with exactly these string/array fields:
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

const SYSTEM = `You are a senior environmental data analyst working with VARUNA, an autonomous river-cleanup drone that uses onboard AI to detect floating trash (plastic bottles, bags, general debris) on waterways. You write professional, well-structured environmental reports in JSON.`

// The fixed prompt. No user input is injected beyond the dataset.
function buildPrompt(data) {
  return `Analyze the trash-detection dataset below and write a professional environmental report suitable for a government/NGO stakeholder. Requirements:
- Cite the actual numbers from the dataset (totals, per-class counts, average confidence, located vs unlocated, live-camera peak, survey area).
- Interpret spatial patterns from the GPS coordinates where present (clustering, hotspots) and temporal patterns from timestamps.
- Assess environmental impact of the detected debris on the river ecosystem.
- Give concrete, prioritized cleanup recommendations for drone operations.
- If the dataset is small or sparse, state that plainly in dataQualityNotes and still give best-effort analysis. Never invent data points that are not present.

${SCHEMA_HINT}

DATASET (JSON):
${JSON.stringify(data)}`
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

/**
 * Ask Groq for the report narrative. Throws on missing key, network/HTTP error,
 * or an empty reply (the caller then uses the built-in narrative).
 */
export async function generateReportNarrative(data, { key } = {}) {
  const apiKey = key || getReportKey()
  if (!apiKey) throw new Error('Missing Groq API key')
  let json
  try {
    json = await groqChat({
      key: apiKey,
      json: true,
      temperature: 0.4,
      maxTokens: 2500,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(data) },
      ],
    })
  } catch (e) {
    if (e?.status === 413 || /too large|tokens per minute|TPM/i.test(e?.message || '')) {
      throw new Error('The dataset is too large for your Groq plan’s per-minute limit — try again in a minute')
    }
    throw e
  }
  const text = (json?.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error('Groq returned an empty response')
  // Not JSON → surface the raw text as the summary so the doc still has content.
  return { ...(parseJsonLoose(text) || { executiveSummary: text }), aiWritten: true }
}
