import type { ModelContext, ModelEntry, TaskType, ProviderCallResult, CallWithFallbackOptions } from './types'
import { MODELS } from '../models'
import { isHealthy, recordFailure, recordSuccess } from './circuit-breaker'
import { fetchGeminiText } from './gemini'
import { fetchAnthropicText } from './anthropic'
import { fetchXaiText, fetchXaiWithSearch } from './xai'
import { callWorkersAIText } from './workers-ai'
import type { Env } from '../env'

async function callProvider(
  ctx: ModelContext,
  entry: ModelEntry,
  prompt: string,
  taskType: TaskType
): Promise<string> {
  switch (entry.provider) {
    case 'anthropic':
      return fetchAnthropicText(ctx, entry.model, prompt, entry.options)
    case 'xai':
      // Signal task uses X Search; other xai tasks use plain chat
      if (taskType === 'signal') {
        return fetchXaiWithSearch(ctx, entry.model, prompt, entry.options)
      }
      return fetchXaiText(ctx, entry.model, prompt, entry.options)
    case 'gemini':
      return fetchGeminiText(ctx, entry.model, prompt, entry.options)
    case 'workers-ai':
      return callWorkersAIText(ctx, entry, prompt)
    case 'inline':
      // Inline provider returns the prompt as-is (used for rules-only validation)
      return prompt
    default:
      throw new Error(`Unknown provider: ${entry.provider}`)
  }
}

/**
 * Execute a text generation task through the fallback chain defined in MODELS config.
 * Checks circuit breaker health before each provider attempt.
 * Returns the first successful result with provider metadata.
 * Returns null if all providers fail and onAllFail is 'skip'.
 * Throws if all providers fail and onAllFail is 'throw' (default).
 */
export async function callWithFallback(
  ctx: ModelContext,
  taskType: TaskType,
  prompt: string,
  options?: CallWithFallbackOptions
): Promise<ProviderCallResult<string> | null> {
  const config = MODELS[taskType]
  let chain = [config.primary, ...config.fallbacks]

  if (options?.skipPrimary && chain.length > 1) {
    chain = chain.slice(1)
  }

  const errors: Array<{ model: string; error: string }> = []

  for (const entry of chain) {
    const providerKey = `${entry.provider}:${entry.model}`

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
      const result = await callProvider(ctx, entry, prompt, taskType)
      const durationMs = Date.now() - start
      console.log(`[provider] ${taskType} handled by ${entry.provider}/${entry.model} (${durationMs}ms)`)

      if (ctx.health) {
        await recordSuccess(ctx.health, providerKey)
      }

      // Token tracking (estimated from char counts since providers return raw text)
      if (options?.onUsage) try {
        options.onUsage({
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

      if (ctx.health) {
        await recordFailure(ctx.health, providerKey)
      }
    }
  }

  if (config.onAllFail === 'skip') {
    console.log(`[provider] All providers failed for ${taskType}, skipping (onAllFail: skip)`)
    return null
  }

  throw new Error(
    `All providers failed for ${taskType}: ${errors.map((e) => `${e.model}: ${e.error.slice(0, 100)}`).join(' | ')}`
  )
}

/** Build a ModelContext from the agent's env + pre-resolved secrets. */
export function buildModelContext(env: Env, secrets: import('../env').ResolvedSecrets): ModelContext {
  return {
    ai: env.AI,
    health: env.PROVIDER_HEALTH,
    gatewayAccountId: env.ACCOUNT_ID,
    gatewayName: env.GATEWAY_NAME,
    gatewayToken: secrets.AI_GATEWAY_TOKEN,
    anthropicKey: secrets.ANTHROPIC_API_KEY,
    xaiKey: secrets.XAI_API_KEY,
    geminiKey: secrets.GEMINI_API_KEY,
  }
}
