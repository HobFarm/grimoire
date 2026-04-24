// xAI Grok provider via AI Gateway. OpenAI-compatible format.

import type { ModelContext, ModelEntry } from './types'

function buildXaiUrl(ctx: ModelContext): string {
  if (ctx.gatewayName && ctx.gatewayToken) {
    return `https://gateway.ai.cloudflare.com/v1/${ctx.gatewayAccountId}/${ctx.gatewayName}/grok/v1/chat/completions`
  }
  return 'https://api.x.ai/v1/chat/completions'
}

function buildXaiHeaders(ctx: ModelContext): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ctx.xaiKey}`,
  }
  if (ctx.gatewayName && ctx.gatewayToken) {
    headers['cf-aig-authorization'] = `Bearer ${ctx.gatewayToken}`
  }
  return headers
}

export interface XaiToolResult {
  text: string
  toolCalls?: Array<{
    name: string
    arguments: string
    result?: string
  }>
}

export async function fetchXaiText(
  ctx: ModelContext,
  model: string,
  prompt: string,
  options?: ModelEntry['options']
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const url = buildXaiUrl(ctx)
    const headers = buildXaiHeaders(ctx)

    const body: Record<string, unknown> = {
      model,
      temperature: options?.temperature ?? 0.5,
      max_tokens: options?.maxOutputTokens ?? 2048,
      messages: [{ role: 'user', content: prompt }],
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`xAI ${response.status}: ${errorText.slice(0, 500)}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: unknown[] }
      }>
    }
    const text = data.choices?.[0]?.message?.content
    if (!text) throw new Error('Empty response from xAI')
    return text
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Grok with X Search tool enabled.
 * Returns text response that incorporates live X search results.
 */
export async function fetchXaiWithSearch(
  ctx: ModelContext,
  model: string,
  prompt: string,
  options?: ModelEntry['options']
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const url = buildXaiUrl(ctx)
    const headers = buildXaiHeaders(ctx)

    const body = {
      model,
      temperature: options?.temperature ?? 0.5,
      max_tokens: options?.maxOutputTokens ?? 2048,
      messages: [{ role: 'user', content: prompt }],
      search_parameters: {
        mode: 'auto',
        sources: [{ type: 'x' }],
      },
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`xAI Search ${response.status}: ${errorText.slice(0, 500)}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = data.choices?.[0]?.message?.content
    if (!text) throw new Error('Empty response from xAI Search')
    return text
  } finally {
    clearTimeout(timeoutId)
  }
}
