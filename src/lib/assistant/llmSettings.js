// LLM settings for the two AI consumers in the app:
//   - assistant: the voice/chat co-pilot (tools + multi-turn)
//   - report:    the Word-report narrative generator (one-shot JSON)
//
// They store the same shape independently, so the operator can use a
// different provider/model for each — matching the existing "assistant key
// ≠ report key" separation.
//
// Same pub/sub + localStorage + CustomEvent pattern as alertSettings.js.

import { useEffect, useState } from 'react'
import { DEFAULT_PROVIDER, PROVIDERS, getProvider } from './llmProviders'

const KEYS = {
  assistant: 'varuna.llm.assistant',
  report: 'varuna.llm.report',
}
const EVT = 'varuna:llmSettings'

function defaults() {
  const p = getProvider(DEFAULT_PROVIDER)
  return { provider: DEFAULT_PROVIDER, model: p.defaultModel, apiKey: '', baseUrl: '' }
}

// One-time migration from the pre-multi-provider Groq-only storage. The old
// keys are read so an existing operator keeps working after this update
// without re-entering anything.
function migrateFromLegacy(kind) {
  if (kind === 'assistant') {
    const key = safeGet('varuna.groqKey')
    if (!key) return null
    return {
      provider: 'groq',
      model: safeGet('varuna.groqModel') || PROVIDERS.groq.defaultModel,
      apiKey: key,
      baseUrl: '',
    }
  }
  if (kind === 'report') {
    const key = safeGet('varuna.groqReportKey')
    if (!key) return null
    return { provider: 'groq', model: PROVIDERS.groq.defaultModel, apiKey: key, baseUrl: '' }
  }
  return null
}

function safeGet(k) {
  try {
    return localStorage.getItem(k) || ''
  } catch {
    return ''
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode / quota */
  }
}

function readOne(kind) {
  const key = KEYS[kind]
  if (!key) return defaults()
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null')
    if (raw && typeof raw === 'object' && raw.provider) {
      return { ...defaults(), ...raw }
    }
  } catch {
    /* fall through */
  }
  // First read for this operator: migrate old Groq-only keys if present.
  const migrated = migrateFromLegacy(kind)
  if (migrated) {
    safeSet(key, JSON.stringify(migrated))
    return migrated
  }
  return defaults()
}

export function getLlmConfig(kind) {
  return readOne(kind)
}

export function setLlmConfig(kind, patch) {
  const key = KEYS[kind]
  if (!key) return null
  const next = { ...readOne(kind), ...(patch || {}) }
  // Snap unknown providers back to the default so a corrupted value never
  // leaves the app calling nowhere.
  if (!PROVIDERS[next.provider]) next.provider = DEFAULT_PROVIDER
  safeSet(key, JSON.stringify(next))
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { kind, config: next } }))
  } catch {
    /* SSR */
  }
  return next
}

/** True when the configured provider has everything it needs to answer. */
export function isLlmConfigReady(cfg) {
  if (!cfg) return false
  const p = getProvider(cfg.provider)
  if (!cfg.model) return false
  if (p.requiresKey && !cfg.apiKey) return false
  // Custom provider needs a base URL.
  if (cfg.provider === 'custom' && !(cfg.baseUrl || '').trim()) return false
  return true
}

/** React hook: the live config for `kind` ('assistant' | 'report'). */
export function useLlmConfig(kind) {
  const [cfg, setCfg] = useState(() => readOne(kind))
  useEffect(() => {
    const onEvt = (e) => {
      if (e.detail?.kind === kind) setCfg(e.detail.config)
    }
    const onStorage = (e) => {
      if (e.key === KEYS[kind]) setCfg(readOne(kind))
    }
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [kind])
  return cfg
}
