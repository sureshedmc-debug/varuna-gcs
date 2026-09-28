import { useEffect, useState } from 'react'
import { PROVIDER_LIST, getProvider } from '../lib/assistant/llmProviders'
import { getLlmConfig, setLlmConfig, useLlmConfig, isLlmConfigReady } from '../lib/assistant/llmSettings'
import { testLlmConfig } from '../lib/assistant/llmClient'

// Compact form for choosing an LLM provider + model + key for either the
// 'assistant' or 'report' slot in llmSettings. Renders inline (no modal), so
// it works inside the small voice-orb card AND inside the Detections tab's
// report panel.
export default function LlmPicker({ kind, onSaved, compact = false }) {
  const stored = useLlmConfig(kind)
  // Local draft while editing. Reset when the stored config changes underneath
  // (e.g. migrated from the old Groq-only key).
  const [draft, setDraft] = useState(stored)
  useEffect(() => setDraft(stored), [stored.provider, stored.model, stored.apiKey, stored.baseUrl])
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState(null)

  const provider = getProvider(draft.provider)
  const needsKey = provider.requiresKey
  const isCustom = draft.provider === 'custom'
  // "Saved" = the draft matches what's actually persisted.
  const dirty =
    draft.provider !== stored.provider ||
    (draft.model || '') !== (stored.model || '') ||
    (draft.apiKey || '') !== (stored.apiKey || '') ||
    (draft.baseUrl || '') !== (stored.baseUrl || '')

  function pickProvider(id) {
    const p = getProvider(id)
    // When switching providers, seed the model with the new provider's default
    // (unless the operator already typed something custom for it).
    setDraft((d) => ({
      provider: id,
      model: p.defaultModel || '',
      apiKey: id === d.provider ? d.apiKey : '',
      baseUrl: id === 'custom' ? d.baseUrl || '' : '',
    }))
    setResult(null)
  }

  async function runTest() {
    setTesting(true)
    setResult(null)
    try {
      const r = await testLlmConfig(draft)
      setResult(r)
    } finally {
      setTesting(false)
    }
  }
  function save() {
    setLlmConfig(kind, draft)
    setResult({ ok: true, saved: true })
    onSaved?.(getLlmConfig(kind))
  }
  const canTest = isLlmConfigReady(draft)
  const modelList = provider.suggestedModels || []

  const inputCls = `inp w-full px-2 py-1.5 ${compact ? 'text-xs' : 'text-sm'}`
  const labelCls = 'mb-1 block text-[10px] uppercase tracking-wider text-muted'

  return (
    <div className="flex flex-col gap-2">
      {/* Provider dropdown */}
      <div>
        <label className={labelCls}>Provider</label>
        <select value={draft.provider} onChange={(e) => pickProvider(e.target.value)} className={inputCls}>
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="mt-0.5 text-[10px] text-faint">{provider.description}</p>
      </div>

      {/* Custom base URL — only when provider = custom */}
      {isCustom && (
        <div>
          <label className={labelCls}>Base URL</label>
          <input
            value={draft.baseUrl || ''}
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            placeholder="https://your-endpoint/v1"
            className={`${inputCls} font-mono`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
      )}

      {/* Model — free text, with a datalist of suggestions per provider. */}
      <div>
        <label className={labelCls}>Model</label>
        <input
          value={draft.model || ''}
          onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          list={`llm-models-${provider.id}`}
          placeholder={provider.defaultModel || 'model-name'}
          className={`${inputCls} font-mono`}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <datalist id={`llm-models-${provider.id}`}>
          {modelList.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {/* API key — hidden for a provider that doesn't need one. */}
      {needsKey && (
        <div>
          <label className={labelCls}>
            API key{provider.signupUrl ? (
              <>
                {' '}·{' '}
                <a href={provider.signupUrl} target="_blank" rel="noreferrer" className="text-accent">
                  get one
                </a>
              </>
            ) : null}
          </label>
          <input
            type="password"
            value={draft.apiKey || ''}
            onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
            placeholder="Paste your API key"
            autoComplete="off"
            spellCheck={false}
            className={inputCls}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={save}
          disabled={!canTest || !dirty}
          className={`rounded-md px-2.5 py-1 ${compact ? 'text-[11px]' : 'text-xs'} font-bold text-white disabled:opacity-40`}
          style={{ background: 'linear-gradient(180deg, var(--accent2, #6BB8FF), var(--accent-hex, #3B9EFF))' }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={runTest}
          disabled={testing || !canTest}
          className={`rounded-md bg-chip px-2.5 py-1 ${compact ? 'text-[11px]' : 'text-xs'} font-semibold text-ink hover:bg-chip2 disabled:opacity-40`}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {!canTest && (
          <span className="text-[10px] text-warn">
            {needsKey && !draft.apiKey ? 'API key needed' : !draft.model ? 'Model name needed' : isCustom && !draft.baseUrl ? 'Base URL needed' : ''}
          </span>
        )}
      </div>

      {/* Test result / hints */}
      {result && (
        <div
          className={`rounded-md px-2 py-1.5 text-[11px] ${result.ok ? 'bg-[#32D74B]/12 text-[#7BE495]' : 'bg-[#FF453A]/12 text-[#FCA5A5]'}`}
        >
          {result.saved ? (
            'Saved.'
          ) : result.ok ? (
            <>
              Connected — {result.latencyMs} ms{result.sample ? ` · sample: "${result.sample}"` : ''}
            </>
          ) : (
            <>
              {result.error || 'Failed.'}
            </>
          )}
        </div>
      )}
    </div>
  )
}
