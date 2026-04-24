// Chat service: Workers AI + DashScope/Qwen integration with streaming + Grimoire tool loop
// Workers AI primary: gpt-oss-120b, fallback: qwen3-30b. DashScope: qwen3-max.

import { createGrimoireHandle } from '@shared/grimoire/handle'
import { buildSystemPrompt } from '../chat/system-prompt'
import { getWorkersAITools, executeTool } from '../chat/tool-catalog'
import { addMessage, getGrimoireSummary } from '../state/chat'
import { CHAT } from '@shared/config'
import { MODELS } from '@shared/models'
import { resolveApiKey } from '@shared/providers'
import { isHealthy, recordFailure, recordSuccess } from '../circuit-breaker'
import { createLogger } from '@shared/logger'
import type { ChatMessage, ChatProvider } from '../chat/types'

const log = createLogger('hobbot-chat')

// --- Types ---

interface WAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

interface WAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string | Record<string, unknown> }
}

interface WAIResponse {
  response?: string
  tool_calls?: WAIToolCall[]
}

// --- Timeout helper ---

const AI_TIMEOUT_MS = 60_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

// --- Think block stripping (Qwen3 produces <think>...</think>) ---

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

// --- Workers AI call ---

async function callWorkersAI(
  ai: Ai,
  model: string,
  messages: WAIMessage[],
  stream: false,
): Promise<WAIResponse>
async function callWorkersAI(
  ai: Ai,
  model: string,
  messages: WAIMessage[],
  stream: true,
): Promise<ReadableStream>
async function callWorkersAI(
  ai: Ai,
  model: string,
  messages: WAIMessage[],
  stream: boolean,
): Promise<WAIResponse | ReadableStream> {
  const params: Record<string, unknown> = {
    messages,
    tools: getWorkersAITools(),
    max_tokens: CHAT.MAX_TOKENS,
    temperature: 0.7,
    stream,
  }

  const result = await withTimeout(
    ai.run(model as Parameters<Ai['run']>[0], params),
    AI_TIMEOUT_MS,
    `Workers AI chat (${model})`,
  )

  if (stream) {
    if (result instanceof ReadableStream) return result
    // Some models may not support streaming; fall back to wrapping
    const text = typeof result === 'object' && result !== null && 'response' in result
      ? (result as WAIResponse).response ?? ''
      : JSON.stringify(result)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`))
        controller.close()
      },
    })
  }

  // Non-streaming: extract response (handles both legacy {response} and OpenAI {choices} formats)
  if (typeof result === 'object' && result !== null) {
    let resp: WAIResponse

    if ('choices' in result) {
      // OpenAI-compatible format (gpt-oss-120b, newer Workers AI models)
      const oai = result as { choices: Array<{ message: { content?: string; tool_calls?: WAIToolCall[] } }> }
      const msg = oai.choices?.[0]?.message
      resp = {
        response: msg?.content ?? '',
        tool_calls: msg?.tool_calls,
      }
    } else if ('response' in result) {
      // Legacy Workers AI format
      resp = result as WAIResponse
    } else {
      return { response: JSON.stringify(result) }
    }

    // Parse tool_calls arguments if they come as strings
    if (resp.tool_calls) {
      for (const tc of resp.tool_calls) {
        if (typeof tc.function.arguments === 'string') {
          try { tc.function.arguments = JSON.parse(tc.function.arguments) } catch {}
        }
      }
    }
    return resp
  }

  return { response: typeof result === 'string' ? result : JSON.stringify(result) }
}

// --- DashScope/Qwen call (OpenAI-compatible endpoint) ---

async function callDashScope(
  apiKey: string,
  model: string,
  messages: WAIMessage[],
  stream: false,
): Promise<WAIResponse>
async function callDashScope(
  apiKey: string,
  model: string,
  messages: WAIMessage[],
  stream: true,
): Promise<ReadableStream>
async function callDashScope(
  apiKey: string,
  model: string,
  messages: WAIMessage[],
  stream: boolean,
): Promise<WAIResponse | ReadableStream> {
  const body = {
    model,
    messages,
    tools: getWorkersAITools(),
    max_tokens: CHAT.MAX_TOKENS,
    temperature: 0.7,
    stream,
  }

  const resp = await withTimeout(
    fetch(CHAT.DASHSCOPE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }),
    AI_TIMEOUT_MS,
    `DashScope chat (${model})`,
  )

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'unknown')
    throw new Error(`DashScope ${resp.status}: ${errText.slice(0, 200)}`)
  }

  if (stream) {
    if (!resp.body) throw new Error('DashScope returned no stream body')
    return resp.body
  }

  // Non-streaming: parse OpenAI response format
  const json = await resp.json() as {
    choices: Array<{
      message: { content?: string; tool_calls?: WAIToolCall[] }
    }>
  }
  const choice = json.choices?.[0]?.message
  const result: WAIResponse = {
    response: choice?.content ?? '',
    tool_calls: choice?.tool_calls,
  }
  if (result.tool_calls) {
    for (const tc of result.tool_calls) {
      if (typeof tc.function.arguments === 'string') {
        try { tc.function.arguments = JSON.parse(tc.function.arguments) } catch {}
      }
    }
  }
  return result
}

// --- Parse Workers AI SSE stream ---

async function* parseWorkersAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ response?: string; tool_calls?: WAIToolCall[] }> {
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          // Skip malformed
        }
      }
    }
  }
}

// --- Parse DashScope SSE stream (OpenAI-compatible with incremental tool calls) ---

async function* parseDashScopeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ response?: string; tool_calls?: WAIToolCall[] }> {
  const decoder = new TextDecoder()
  let buffer = ''
  // Accumulate tool calls across chunks (keyed by index)
  const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        // Flush accumulated tool calls with parsed arguments
        if (toolCallAccum.size > 0) {
          const toolCalls: WAIToolCall[] = [...toolCallAccum.values()].map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tryParseArgs(tc.arguments),
            },
          }))
          yield { tool_calls: toolCalls }
        }
        return
      }

      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta
        if (!delta) continue

        // Content tokens
        if (delta.content) {
          yield { response: delta.content }
        }

        // Incremental tool calls: first chunk has id+name, subsequent chunks append arguments
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, {
                id: tc.id ?? `tc_${idx}`,
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              })
            } else {
              const acc = toolCallAccum.get(idx)!
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name += tc.function.name
              if (tc.function?.arguments) acc.arguments += tc.function.arguments
            }
          }
        }

        // finish_reason: flush tool calls mid-stream if model signals stop
        if (parsed.choices?.[0]?.finish_reason === 'tool_calls' || parsed.choices?.[0]?.finish_reason === 'stop') {
          if (toolCallAccum.size > 0) {
            const toolCalls: WAIToolCall[] = [...toolCallAccum.values()].map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tryParseArgs(tc.arguments),
              },
            }))
            toolCallAccum.clear()
            yield { tool_calls: toolCalls }
          }
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }

  // Flush on stream end if no [DONE] received
  if (toolCallAccum.size > 0) {
    const toolCalls: WAIToolCall[] = [...toolCallAccum.values()].map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: tryParseArgs(tc.arguments),
      },
    }))
    yield { tool_calls: toolCalls }
  }
}

/** Parse accumulated arguments string, returning parsed object or raw string */
function tryParseArgs(args: string): string | Record<string, unknown> {
  try { return JSON.parse(args) } catch { return args }
}

// --- Model candidates and cross-provider fallback ---

interface ModelCandidate {
  provider: ChatProvider
  model: string
}

function getModelCandidates(preferred: ChatProvider): ModelCandidate[] {
  const primary = MODELS['chat.primary'].primary.model
  const fallback = MODELS['chat.fallback'].primary.model
  const dashscope = MODELS['chat.dashscope'].primary.model

  if (preferred === 'dashscope') {
    return [
      { provider: 'dashscope', model: dashscope },
      { provider: 'workers-ai', model: primary },
      { provider: 'workers-ai', model: fallback },
    ]
  }
  return [
    { provider: 'workers-ai', model: primary },
    { provider: 'workers-ai', model: fallback },
    { provider: 'dashscope', model: dashscope },
  ]
}

interface FallbackResult {
  result: WAIResponse | ReadableStream
  model: string
  provider: ChatProvider
}

async function callWithFallback(
  env: Env,
  messages: WAIMessage[],
  stream: false,
  preferred: ChatProvider,
  dashscopeKey: string,
): Promise<FallbackResult & { result: WAIResponse }>
async function callWithFallback(
  env: Env,
  messages: WAIMessage[],
  stream: true,
  preferred: ChatProvider,
  dashscopeKey: string,
): Promise<FallbackResult & { result: ReadableStream }>
async function callWithFallback(
  env: Env,
  messages: WAIMessage[],
  stream: boolean,
  preferred: ChatProvider,
  dashscopeKey: string,
): Promise<FallbackResult> {
  const candidates = getModelCandidates(preferred)

  for (const { provider, model } of candidates) {
    const providerKey = `${provider}:${model}`

    const healthy = await isHealthy(env.PROVIDER_HEALTH, providerKey)
    if (!healthy) {
      log.warn('circuit open, skipping', { provider, model })
      continue
    }

    try {
      let result: WAIResponse | ReadableStream
      if (provider === 'dashscope') {
        if (!dashscopeKey) {
          log.warn('no DashScope API key, skipping', { model })
          continue
        }
        result = await callDashScope(dashscopeKey, model, messages, stream as never)
      } else {
        result = await callWorkersAI(env.AI, model, messages, stream as never)
      }
      await recordSuccess(env.PROVIDER_HEALTH, providerKey)
      return { result, model, provider }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('model call failed', { provider, model, error: msg })
      await recordFailure(env.PROVIDER_HEALTH, providerKey)
    }
  }

  throw new Error('All chat models failed (circuit breaker open or errors on all providers)')
}

// --- Stream entry point ---

export interface ChatStreamResult {
  readable: ReadableStream
  messageId: string
}

export function streamChatResponse(
  env: Env,
  conversationId: string,
  history: ChatMessage[],
  userContent: string,
  preferredProvider: ChatProvider = 'workers-ai',
): ChatStreamResult {
  const messageId = crypto.randomUUID()
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  function writeSSE(data: Record<string, unknown>) {
    return writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
  }

  const pipeline = async () => {
    try {
      // Resolve DashScope API key once for the request lifetime
      const dashscopeKey = await resolveApiKey(env.DASHSCOPE_API_KEY).catch(() => '')

      // Build system prompt with live Grimoire stats
      const summary = await getGrimoireSummary(env.GRIMOIRE_DB)
      const systemPrompt = buildSystemPrompt(summary)

      // Build messages in OpenAI/Workers AI format
      const messages: WAIMessage[] = [
        { role: 'system', content: systemPrompt },
      ]

      // Add history (capped). Include BART summaries as system context.
      const filtered = history.filter(m =>
        m.role === 'user' ||
        m.role === 'assistant' ||
        (m.role === 'system' && m.agent_id === 'bart-summary')
      ).slice(-CHAT.MAX_HISTORY_MESSAGES)

      for (const m of filtered) {
        if (m.agent_id === 'bart-summary') {
          messages.push({ role: 'system', content: `[Summary of earlier conversation]\n${m.content}` })
        } else {
          messages.push({ role: m.role as 'user' | 'assistant', content: m.content })
        }
      }

      // Add current user message
      messages.push({ role: 'user', content: userContent })

      const allRefs: string[] = []
      let fullResponse = ''
      let lastUsedProvider: ChatProvider = preferredProvider
      let lastUsedModel = ''
      let iterations = 0

      while (iterations < CHAT.MAX_TOOL_ITERATIONS) {
        iterations++

        if (iterations === 1) {
          // First iteration: stream tokens to client
          const { result: stream, model, provider: usedProvider } = await callWithFallback(env, messages, true, preferredProvider, dashscopeKey)
          lastUsedProvider = usedProvider
          lastUsedModel = model
          const reader = (stream as ReadableStream).getReader()

          let streamedText = ''
          const toolCalls: WAIToolCall[] = []

          // Select the right stream parser based on which provider actually responded
          const chunks = usedProvider === 'dashscope'
            ? parseDashScopeStream(reader)
            : parseWorkersAIStream(reader)

          for await (const chunk of chunks) {
            if (chunk.response) {
              const cleaned = stripThinkBlocks(chunk.response)
              if (cleaned) {
                streamedText += cleaned
                await writeSSE({ type: 'token', text: cleaned })
              }
            }
            if (chunk.tool_calls) {
              toolCalls.push(...chunk.tool_calls)
            }
          }

          fullResponse += streamedText

          if (toolCalls.length === 0) {
            break // Done, no tool calls
          }

          // Build assistant message with tool calls for history
          messages.push({
            role: 'assistant',
            content: streamedText || '',
          })

          // Execute tools
          for (const tc of toolCalls) {
            let args: Record<string, unknown>
            if (typeof tc.function.arguments === 'string') {
              try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
            } else {
              args = tc.function.arguments as Record<string, unknown>
            }

            await writeSSE({ type: 'tool_call', name: tc.function.name, input: args })

            const toolResult = await executeTool(handle, tc.function.name, args)
            if (toolResult) {
              allRefs.push(...toolResult.refs)
              await writeSSE({
                type: 'tool_result',
                name: tc.function.name,
                summary: toolResult.result.length > 200
                  ? toolResult.result.slice(0, 200) + '...'
                  : toolResult.result,
              })
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolResult.result,
              })
            } else {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: 'unknown_tool', name: tc.function.name }),
              })
            }
          }

          fullResponse = '' // Reset for next iteration
        } else {
          // Subsequent iterations: non-streaming for tool loop
          const { result, model, provider: usedProvider } = await callWithFallback(env, messages, false, preferredProvider, dashscopeKey)
          lastUsedProvider = usedProvider
          lastUsedModel = model
          const resp = result as WAIResponse

          const text = stripThinkBlocks(resp.response ?? '')
          if (text) {
            fullResponse += text
            await writeSSE({ type: 'token', text })
          }

          const toolCalls = resp.tool_calls ?? []
          if (toolCalls.length === 0) {
            break // Done
          }

          messages.push({
            role: 'assistant',
            content: text || '',
          })

          for (const tc of toolCalls) {
            let args: Record<string, unknown>
            if (typeof tc.function.arguments === 'string') {
              try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
            } else {
              args = tc.function.arguments as Record<string, unknown>
            }

            await writeSSE({ type: 'tool_call', name: tc.function.name, input: args })

            const toolResult = await executeTool(handle, tc.function.name, args)
            if (toolResult) {
              allRefs.push(...toolResult.refs)
              await writeSSE({
                type: 'tool_result',
                name: tc.function.name,
                summary: toolResult.result.length > 200
                  ? toolResult.result.slice(0, 200) + '...'
                  : toolResult.result,
              })
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolResult.result,
              })
            } else {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: 'unknown_tool', name: tc.function.name }),
              })
            }
          }
        }
      }

      const uniqueRefs = [...new Set(allRefs)]

      // Save assistant message to D1 with provider:model telemetry
      if (fullResponse) {
        try {
          await addMessage(env.HOBBOT_DB, {
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: fullResponse,
            provider: `${lastUsedProvider}:${lastUsedModel}`,
            agent_id: 'hobbot-chat',
            grimoire_refs: uniqueRefs,
            structured_data: {},
          })
        } catch (saveErr) {
          log.warn('failed to save assistant message', { error: saveErr instanceof Error ? saveErr.message : String(saveErr) })
        }
      }

      await writeSSE({
        type: 'done',
        message_id: messageId,
        grimoire_refs: uniqueRefs,
        content: fullResponse,
      })
    } catch (err) {
      try {
        await writeSSE({ type: 'error', message: (err as Error).message })
      } catch {
        // Writer may be closed
      }
    } finally {
      try {
        await writer.close()
      } catch {
        // Already closed
      }
    }
  }

  pipeline()

  return { readable, messageId }
}
