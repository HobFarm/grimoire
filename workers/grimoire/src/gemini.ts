import type { ModelContext, ModelEntry } from './models'

// --- URL Construction ---

export function buildGeminiUrl(ctx: ModelContext, model: string): string {
  if (ctx.gatewayName && ctx.gatewayToken) {
    return `https://gateway.ai.cloudflare.com/v1/${ctx.gatewayAccountId}/${ctx.gatewayName}/google-ai-studio/v1beta/models/${model}:generateContent?key=${ctx.geminiKey}`
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ctx.geminiKey}`
}

export function buildDirectGeminiUrl(ctx: ModelContext, model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ctx.geminiKey}`
}

// --- Request Construction ---

export function buildGeminiHeaders(ctx: ModelContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ctx.gatewayName && ctx.gatewayToken) {
    headers['cf-aig-authorization'] = `Bearer ${ctx.gatewayToken}`
  }
  return headers
}

export function buildGeminiBody(prompt: string, options?: ModelEntry['options']) {
  const generationConfig: Record<string, unknown> = {
    temperature: options?.temperature ?? 0.2,
    responseMimeType: 'application/json',
  }
  if (options?.maxOutputTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxOutputTokens
  }
  if (options?.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget }
  }

  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  }
}

// --- Fetch ---

export async function fetchGeminiText(
  ctx: ModelContext,
  model: string,
  prompt: string,
  options?: ModelEntry['options']
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    const url = buildGeminiUrl(ctx, model)
    const headers = buildGeminiHeaders(ctx)
    const body = buildGeminiBody(prompt, options)

    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    // Gateway 401 fallback: try direct URL
    if (response.status === 401 && ctx.gatewayName) {
      const directUrl = buildDirectGeminiUrl(ctx, model)
      response = await fetch(directUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini ${response.status}: ${errorText.slice(0, 500)}`)
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('Empty response from Gemini')
    return text
  } finally {
    clearTimeout(timeoutId)
  }
}

// --- JSON Parsing ---

/**
 * Strip markdown fences, parse JSON, optionally validate shape.
 * Returns parsed result or null on failure.
 */
export function tryParseJson<T>(
  raw: string,
  validator?: (parsed: unknown) => T | null
): T | null {
  try {
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    const parsed = JSON.parse(cleaned)

    if (validator) {
      return validator(parsed)
    }

    return parsed as T
  } catch {
    return null
  }
}
