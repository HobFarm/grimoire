// Anthropic provider (Claude Opus/Sonnet) via AI Gateway.

import type { ModelContext, ModelEntry } from './types'

function buildAnthropicUrl(ctx: ModelContext): string {
  if (ctx.gatewayName && ctx.gatewayToken) {
    return `https://gateway.ai.cloudflare.com/v1/${ctx.gatewayAccountId}/${ctx.gatewayName}/anthropic/v1/messages`
  }
  return 'https://api.anthropic.com/v1/messages'
}

function buildAnthropicHeaders(ctx: ModelContext): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': ctx.anthropicKey,
    'anthropic-version': '2023-06-01',
  }
  if (ctx.gatewayName && ctx.gatewayToken) {
    headers['cf-aig-authorization'] = `Bearer ${ctx.gatewayToken}`
  }
  return headers
}

export async function fetchAnthropicText(
  ctx: ModelContext,
  model: string,
  prompt: string,
  options?: ModelEntry['options']
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60_000)

  try {
    const gatewayUrl = buildAnthropicUrl(ctx)
    const gatewayHeaders = buildAnthropicHeaders(ctx)

    const body = JSON.stringify({
      model,
      max_tokens: options?.maxOutputTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      messages: [{ role: 'user', content: prompt }],
    })

    let response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: gatewayHeaders,
      body,
      signal: controller.signal,
    })

    // Fallback to direct Anthropic API on gateway auth failure
    if (response.status === 401 && gatewayUrl.includes('gateway.ai.cloudflare.com')) {
      console.log('[anthropic] Gateway 401, falling back to direct API')
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body,
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Anthropic ${response.status}: ${errorText.slice(0, 500)}`)
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = data.content?.find((c) => c.type === 'text')?.text
    if (!text) throw new Error('Empty response from Anthropic')
    return text
  } finally {
    clearTimeout(timeoutId)
  }
}
