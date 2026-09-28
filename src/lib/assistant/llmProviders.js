// AI provider registry. Every provider here speaks the OpenAI-compatible
// /chat/completions API — one code path in llmClient.js handles them all.
// Adding a new provider is a matter of dropping in another entry (baseUrl +
// requiresKey + suggested models); no per-provider forking.

export const PROVIDERS = {
  groq: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    signupUrl: 'https://console.groq.com',
    defaultModel: 'llama-3.3-70b-versatile',
    suggestedModels: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'meta-llama/llama-4-scout-17b-16e-instruct',
    ],
    description: 'Very fast cloud inference. Free tier available.',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    signupUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-flash',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    description: 'Google\'s Gemini via its OpenAI-compatible endpoint.',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    signupUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    suggestedModels: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-001',
    ],
    description: 'One API, hundreds of models (Claude, GPT, Llama, etc.).',
  },
  custom: {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '', // operator provides
    requiresKey: true,
    signupUrl: '',
    defaultModel: '',
    suggestedModels: [],
    description: 'Any endpoint that speaks the OpenAI /chat/completions API.',
  },
}

export const PROVIDER_LIST = Object.values(PROVIDERS)
export const DEFAULT_PROVIDER = 'groq'

/** Look up a provider by id, falling back to the default one for unknown ids. */
export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER]
}
