import type { ModelContext, ModelEntry, TaskType } from './models'
import { MODELS } from './models'
import { fetchGeminiText } from './gemini'
import { isHealthy, recordFailure, recordSuccess } from './circuit-breaker'

// --- Result type ---

export interface ProviderCallResult<T> {
  result: T
  provider: string
  model: string
  durationMs: number
}

// --- Options ---

export interface CallWithFallbackOptions {
  /** Skip the primary and start from fallback 1. For testing fallback paths. */
  skipPrimary?: boolean
  /** Token usage callback. Fired after each successful AI call. Fire-and-forget. */
  onUsage?: (usage: { taskType: string; model: string; provider: string; inputTokens: number; outputTokens: number; estimatedCost: number }) => void
}

// --- Think block stripping (Qwen3, Nemotron) ---

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

// --- Workers AI text generation ---

async function callWorkersAI(
  ctx: ModelContext,
  entry: ModelEntry,
  prompt: string
): Promise<string> {
  if (!ctx.ai) throw new Error('Workers AI binding not available')

  const params: Record<string, unknown> = {
    messages: [{ role: 'user' as const, content: prompt }],
    max_tokens: entry.options?.maxOutputTokens ?? 1024,
    temperature: entry.options?.temperature ?? 0.2,
  }
  if (entry.options?.responseFormat === 'json') {
    params.response_format = { type: 'json_object' }
  }
  const result = await ctx.ai.run(entry.model as Parameters<Ai['run']>[0], params)

  // Handle both legacy (.response) and OpenAI-compatible (choices[]) formats
  let text: string
  if (typeof result === 'object' && result !== null) {
    if ('response' in result) {
      text = (result as { response: string }).response
    } else if ('choices' in result) {
      const choices = (result as { choices: Array<{ message: { content: string } }> }).choices
      text = choices?.[0]?.message?.content ?? ''
    } else {
      throw new Error('Workers AI returned unexpected response shape')
    }
  } else {
    throw new Error('Workers AI returned unexpected response shape')
  }

  return stripThinkBlocks(text)
}

// --- Core fallback chain ---

/**
 * Execute a text generation task through the fallback chain defined in MODELS config.
 * Checks circuit breaker health before each provider attempt.
 * Records success/failure for circuit breaker tracking.
 * Tries primary first, then each fallback in order.
 * Returns the first successful result with provider metadata.
 * Throws if all providers fail.
 */
export async function callWithFallback(
  ctx: ModelContext,
  taskType: TaskType,
  prompt: string,
  options?: CallWithFallbackOptions
): Promise<ProviderCallResult<string>> {
  const config = MODELS[taskType]
  let chain = [config.primary, ...config.fallbacks]

  if (options?.skipPrimary && chain.length > 1) {
    chain = chain.slice(1)
  }

  const errors: Array<{ model: string; error: string }> = []

  for (const entry of chain) {
    const providerKey = `${entry.provider}:${entry.model}`

    // Circuit breaker check
    if (ctx.health) {
      const healthy = await isHealthy(ctx.health, providerKey)
      if (!healthy) {
        console.log(`[provider] Skipping ${providerKey} (circuit open)`)
        errors.push({ model: entry.model, error: 'circuit_open' })
        continue
      }
    }

    const start = Date.now()
    try {
      let result: string

      if (entry.provider === 'gemini') {
        result = await fetchGeminiText(ctx, entry.model, prompt, entry.options)
      } else if (entry.provider === 'workers-ai') {
        result = await callWorkersAI(ctx, entry, prompt)
      } else {
        throw new Error(`Unknown provider: ${entry.provider}`)
      }

      const durationMs = Date.now() - start
      console.log(`[provider] ${taskType} handled by ${entry.provider}/${entry.model} (${durationMs}ms)`)

      // Record success (resets failure counter)
      if (ctx.health) {
        await recordSuccess(ctx.health, providerKey)
      }

      // Token tracking (estimated from char counts)
      const onUsage = options?.onUsage ?? ctx.onUsage
      if (onUsage) try {
        onUsage({
          taskType, model: entry.model, provider: entry.provider,
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: Math.ceil(result.length / 4),
          estimatedCost: 0,
        })
      } catch {}

      return { result, provider: entry.provider, model: entry.model, durationMs }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ model: entry.model, error: msg })
      console.log(`[provider] ${taskType} failed on ${entry.provider}/${entry.model}: ${msg.slice(0, 200)}`)

      // Record failure
      if (ctx.health) {
        await recordFailure(ctx.health, providerKey)
      }
    }
  }

  throw new Error(
    `All providers failed for ${taskType}: ${errors.map(e => `${e.model}: ${e.error.slice(0, 100)}`).join(' | ')}`
  )
}
