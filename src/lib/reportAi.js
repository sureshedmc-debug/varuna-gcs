// AI-written analysis for the Word trash report. Uses the operator's chosen
// LLM provider from llmSettings ('report' slot) — Groq, Gemini, OpenRouter,
// or a custom OpenAI-compatible endpoint. Its config is stored separately
// from the voice-assistant's config, so the operator can use a different
// provider/model for each.
//
// With no configured/reachable provider, the report falls back to the built-in
// narrative (reportDoc.fallbackNarrative), so a report always renders.

import { llmChat } from './assistant/llmClient'
import { getLlmConfig } from './assistant/llmSettings'

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
 * Ask the configured LLM for the report narrative. Throws on missing config,
 * network/HTTP error, or an empty reply (the caller then uses the built-in
 * narrative). Pass `config` to override the stored one (used when the
 * operator has just edited the picker but not saved).
 */
export async function generateReportNarrative(data, { config } = {}) {
  const cfg = config || getLlmConfig('report')
  let json
  try {
    json = await llmChat({
      config: cfg,
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
      throw new Error('The dataset is too large for this plan’s per-minute limit — try again in a minute')
    }
    throw e
  }
  const text = (json?.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error('The AI returned an empty response')
  // Not JSON → surface the raw text as the summary so the doc still has content.
  return { ...(parseJsonLoose(text) || { executiveSummary: text }), aiWritten: true }
}
