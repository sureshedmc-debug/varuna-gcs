// Multi-turn chat with tool calling for the VARUNA assistant, on Groq's
// OpenAI-compatible API. Each user turn is sent with the recent history; when
// the model asks for tools they're executed (tools.js) and the results sent
// back, looping until it answers in plain text.

import { SYSTEM_PROMPT } from './appKnowledge'
import { TOOLS, runTool } from './tools'
import { llmChat } from './llmClient'
import { getLlmConfig } from './llmSettings'

const MAX_TOOL_ROUNDS = 5
const MAX_HISTORY = 30 // messages kept (older ones dropped to bound tokens)

function parseArgs(s) {
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/**
 * @param {() => object} ctx  live app-state getter handed to tools (see tools.js)
 * @param {(ev) => void} onEvent  {type:'tool', name, args} / {type:'tool_result', name, args, result}
 */
export function createAssistantChat(ctx, onEvent = () => {}) {
  // History as whole turns ([user, assistant/tool…]), trimmed by turn so a
  // tool_calls message is never separated from its tool results.
  let turns = []
  const flat = () => turns.flat()

  function remember(turn) {
    turns = [...turns, turn]
    while (turns.length > 1 && flat().length > MAX_HISTORY) turns = turns.slice(1)
  }

  // Turns run one at a time so two quick inputs never interleave the history.
  let chain = Promise.resolve()
  function send(text) {
    const p = chain.then(() => runTurn(text))
    chain = p.catch(() => {})
    return p
  }

  /** One user message (typed, or a voice transcript). Resolves with the reply text. */
  async function runTurn(text) {
    const turn = [{ role: 'user', content: text }]
    let reply = ''
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const json = await llmChat({
          config: getLlmConfig('assistant'),
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...flat(), ...turn],
          tools: round === MAX_TOOL_ROUNDS ? undefined : TOOLS, // last round: force a text answer
        })
        const msg = json?.choices?.[0]?.message || {}
        const calls = msg.tool_calls || []
        if (!calls.length) {
          reply = (msg.content || '').trim() || 'Sorry, I have no answer for that.'
          turn.push({ role: 'assistant', content: reply })
          break
        }
        turn.push({ role: 'assistant', content: msg.content || null, tool_calls: calls })
        for (const c of calls) {
          const name = c.function?.name
          const args = parseArgs(c.function?.arguments)
          onEvent({ type: 'tool', name, args })
          const result = await runTool(name, args, ctx)
          onEvent({ type: 'tool_result', name, args, result })
          turn.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
        }
      }
    } catch (e) {
      // Keep what already happened (e.g. a confirmed flight command) in the
      // model's memory even if a later round failed.
      if (turn.length > 1) {
        const last = turn[turn.length - 1]
        if (last.role === 'tool') turn.push({ role: 'assistant', content: '(The reply could not be completed because of a connection error.)' })
        remember(turn)
      }
      throw e
    }
    remember(turn)
    return reply
  }

  return { send, reset: () => (turns = []) }
}
