import type { Env } from './types'

// --- URL Construction ---

export function buildGeminiUrl(env: Env, model: string): string {
  if (env.AI_GATEWAY_NAME && env.AI_GATEWAY_TOKEN) {
    return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/google-ai-studio/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`
}

export function buildDirectGeminiUrl(env: Env, model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`
}

// --- Request Construction ---

export function buildGeminiHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.AI_GATEWAY_NAME && env.AI_GATEWAY_TOKEN) {
    headers['cf-aig-authorization'] = `Bearer ${env.AI_GATEWAY_TOKEN}`
  }
  return headers
}

export function buildGeminiBody(prompt: string, temperature = 0.2) {
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
    },
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
  env: Env,
  model: string,
  prompt: string,
  temperature = 0.2
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const url = buildGeminiUrl(env, model)
    const headers = buildGeminiHeaders(env)
    const body = buildGeminiBody(prompt, temperature)

    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    // Gateway 401 fallback: try direct URL
    if (response.status === 401 && env.AI_GATEWAY_NAME) {
      const directUrl = buildDirectGeminiUrl(env, model)
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
