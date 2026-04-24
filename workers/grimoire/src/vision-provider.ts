// Vision provider: callVisionWithFallback for image+text prompts.
// Mirrors callWithFallback from provider.ts but dispatches to vision-specific
// helpers (Workers AI multimodal messages, Gemini inline_data).

import type { ModelContext, ModelEntry, TaskType } from './models'
import { MODELS } from './models'
import { buildGeminiUrl, buildDirectGeminiUrl, buildGeminiHeaders } from './gemini'
import { isHealthy, recordFailure, recordSuccess } from './circuit-breaker'
import type { ProviderCallResult, CallWithFallbackOptions } from './provider'

// --- Image data input ---

export interface VisionImageData {
  base64: string
  mimeType: string
}

// --- Think block stripping ---

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

// --- Workers AI vision call ---

async function callWorkersAIVision(
  ctx: ModelContext,
  entry: ModelEntry,
  prompt: string,
  imageData: VisionImageData,
): Promise<string> {
  if (!ctx.ai) throw new Error('Workers AI binding not available')

  const params: Record<string, unknown> = {
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
        ],
      },
    ],
    max_tokens: entry.options?.maxOutputTokens ?? 4096,
    temperature: entry.options?.temperature ?? 0.1,
  }

  // Gemma 4: disable thinking for clean JSON, enforce structured output
  if (entry.options?.responseFormat === 'json') {
    params.response_format = { type: 'json_object' }
    params.chat_template_kwargs = { enable_thinking: false }
  }

  const result = await (ctx.ai as any).run(entry.model as Parameters<Ai['run']>[0], params)

  let text: string
  if (typeof result === 'object' && result !== null) {
    if ('response' in result) {
      text = (result as { response: string }).response
    } else if ('choices' in result) {
      const choices = (result as { choices: Array<{ message: { content: string } }> }).choices
      text = choices?.[0]?.message?.content ?? ''
    } else {
      throw new Error('Workers AI vision returned unexpected response shape')
    }
  } else {
    throw new Error('Workers AI vision returned non-object response')
  }

  return stripThinkBlocks(text)
}

// --- Gemini vision call ---

async function callGeminiVision(
  ctx: ModelContext,
  entry: ModelEntry,
  prompt: string,
  imageData: VisionImageData,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const url = buildGeminiUrl(ctx, entry.model)
    const headers = buildGeminiHeaders(ctx)

    const generationConfig: Record<string, unknown> = {
      temperature: entry.options?.temperature ?? 0.1,
      responseMimeType: 'application/json',
    }
    if (entry.options?.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = entry.options.maxOutputTokens
    }
    if (entry.options?.thinkingBudget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: entry.options.thinkingBudget }
    }

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: imageData.mimeType, data: imageData.base64 } },
        ],
      }],
      generationConfig,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }

    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    // Gateway 401 fallback: try direct URL
    if (response.status === 401 && ctx.gatewayName) {
      const directUrl = buildDirectGeminiUrl(ctx, entry.model)
      response = await fetch(directUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini Vision ${response.status}: ${errorText.slice(0, 500)}`)
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
    }

    const parts = data.candidates?.[0]?.content?.parts
    if (!parts || parts.length === 0) throw new Error('Empty response from Gemini Vision')

    // Filter out thinking parts, take last content part
    const contentParts = parts.filter(p => !p.thought)
    const text = (contentParts.length > 0 ? contentParts[contentParts.length - 1] : parts[parts.length - 1])?.text
    if (!text) throw new Error('No text content in Gemini Vision response')

    return text
  } finally {
    clearTimeout(timeoutId)
  }
}

// --- Core vision fallback chain ---

export async function callVisionWithFallback(
  ctx: ModelContext,
  taskType: TaskType,
  prompt: string,
  imageData: VisionImageData,
  options?: CallWithFallbackOptions,
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
        console.log(`[vision] Skipping ${providerKey} (circuit open)`)
        errors.push({ model: entry.model, error: 'circuit_open' })
        continue
      }
    }

    const start = Date.now()
    try {
      let result: string

      if (entry.provider === 'gemini') {
        result = await callGeminiVision(ctx, entry, prompt, imageData)
      } else if (entry.provider === 'workers-ai') {
        result = await callWorkersAIVision(ctx, entry, prompt, imageData)
      } else {
        throw new Error(`Unknown provider: ${entry.provider}`)
      }

      const durationMs = Date.now() - start
      console.log(`[vision] ${taskType} handled by ${entry.provider}/${entry.model} (${durationMs}ms)`)

      // Record success (resets failure counter)
      if (ctx.health) {
        await recordSuccess(ctx.health, providerKey)
      }

      // Token tracking (estimated from char counts; image tokens not counted here)
      const onUsage = options?.onUsage ?? ctx.onUsage
      if (onUsage) try {
        onUsage({
          taskType, model: entry.model, provider: entry.provider,
          inputTokens: Math.ceil(prompt.length / 4) + 1000, // +1000 estimate for image tokens
          outputTokens: Math.ceil(result.length / 4),
          estimatedCost: 0,
        })
      } catch {}

      return { result, provider: entry.provider, model: entry.model, durationMs }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ model: entry.model, error: msg })
      console.log(`[vision] ${taskType} failed on ${entry.provider}/${entry.model}: ${msg.slice(0, 200)}`)

      // Record failure
      if (ctx.health) {
        await recordFailure(ctx.health, providerKey)
      }
    }
  }

  throw new Error(
    `All vision providers failed for ${taskType}: ${errors.map(e => `${e.model}: ${e.error.slice(0, 100)}`).join(' | ')}`
  )
}
