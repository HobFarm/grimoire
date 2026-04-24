// Provider utility for grimoire-classifier.
// Uses shared callWithJsonParse (Workers AI primary, Gemini fallback, circuit breaker).
// Migrated from local provider implementation to shared registry in Phase 3C.

import { callWithJsonParse, type GatewayConfig, type CallOptions } from '@shared/providers/call-with-json-parse'
import { resolveApiKey, createTokenLogger } from '@shared/providers'
import { MODELS } from '@shared/models'

export interface ClassifierCallResult {
  text: string
  provider: string
  model: string
  durationMs: number
}

export async function callClassifier(
  env: {
    AI: Ai
    HOBBOT_DB?: D1Database
    GEMINI_API_KEY: unknown
    AI_GATEWAY_ACCOUNT_ID: string
    AI_GATEWAY_NAME: string
    AI_GATEWAY_TOKEN: unknown
    PROVIDER_HEALTH: KVNamespace
  },
  systemPrompt: string,
  userContent: string,
): Promise<ClassifierCallResult> {
  const geminiKey = await resolveApiKey(env.GEMINI_API_KEY as string | { get: () => Promise<string> })

  let gateway: GatewayConfig | undefined
  if (env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ACCOUNT_ID) {
    const token = await resolveApiKey(env.AI_GATEWAY_TOKEN as string | { get: () => Promise<string> })
    if (token) {
      gateway = { accountId: env.AI_GATEWAY_ACCOUNT_ID, name: env.AI_GATEWAY_NAME ?? 'hobfarm', token }
    }
  }

  const options: CallOptions = {
    health: env.PROVIDER_HEALTH,
    gateway,
    onUsage: env.HOBBOT_DB ? createTokenLogger(env.HOBBOT_DB, 'grimoire-classifier') : undefined,
  }

  const start = Date.now()
  const { result, modelUsed } = await callWithJsonParse<unknown>(
    'classifier.batch',
    systemPrompt,
    userContent,
    env.AI,
    geminiKey,
    MODELS['classifier.batch'],
    options,
  )

  // callWithJsonParse returns parsed JSON; re-stringify for the caller
  // (index.ts expects raw text to parse itself with normalization logic)
  return {
    text: JSON.stringify(result),
    provider: modelUsed.includes('@cf/') ? 'workers-ai' : 'gemini',
    model: modelUsed,
    durationMs: Date.now() - start,
  }
}
