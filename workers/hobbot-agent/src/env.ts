export interface Env {
  // Durable Object
  HOBBOT: DurableObjectNamespace

  // Bindings
  AI: Ai
  CDN: R2Bucket
  HOBBOT_DB: D1Database
  PROVIDER_HEALTH: KVNamespace
  GRIMOIRE: Fetcher

  // Vars
  ACCOUNT_ID: string
  GATEWAY_NAME: string

  // Secrets (Secrets Store bindings are RPC proxies in DOs, plain strings in Workers)
  AI_GATEWAY_TOKEN: string
  ANTHROPIC_API_KEY: string
  XAI_API_KEY: string
  GEMINI_API_KEY: string
  X_CONSUMER_KEY: string
  X_CONSUMER_SECRET: string
  X_ACCESS_TOKEN: string
  X_ACCESS_SECRET: string
}

/** Secret binding keys, shared between server.ts (writer) and agent.ts (reader). */
export const SECRET_KEYS = [
  'AI_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY',
  'X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET',
] as const

/** KV key used to relay resolved secrets from the stateless worker to the DO. */
export const KV_SECRETS_KEY = '_hobbot_resolved_secrets'

/** Resolved secrets cache. All values are plain strings. */
export interface ResolvedSecrets {
  AI_GATEWAY_TOKEN: string
  ANTHROPIC_API_KEY: string
  XAI_API_KEY: string
  GEMINI_API_KEY: string
  X_CONSUMER_KEY: string
  X_CONSUMER_SECRET: string
  X_ACCESS_TOKEN: string
  X_ACCESS_SECRET: string
}

/**
 * Resolve secrets. Tries two strategies:
 * 1. Direct .get() on the binding (works if binding supports RPC)
 * 2. KV cache (populated by stateless worker in server.ts)
 */
export async function resolveSecrets(env: Env): Promise<ResolvedSecrets> {
  // Strategy 1: try .get() directly on the binding
  const firstBinding = env[SECRET_KEYS[0]] as any
  if (typeof firstBinding?.get === 'function') {
    try {
      const test = await firstBinding.get()
      if (typeof test === 'string' && !test.startsWith('[object')) {
        const secrets: Record<string, string> = {}
        secrets[SECRET_KEYS[0]] = test
        for (let i = 1; i < SECRET_KEYS.length; i++) {
          secrets[SECRET_KEYS[i]] = await (env[SECRET_KEYS[i]] as any).get()
        }
        return secrets as unknown as ResolvedSecrets
      }
    } catch {
      // .get() not available in this context, fall through to KV
    }
  }

  // Strategy 2: read from KV cache
  const cached = await env.PROVIDER_HEALTH.get(KV_SECRETS_KEY)
  if (!cached) {
    throw new Error(
      'No cached secrets in KV. Hit any HTTP endpoint first so the stateless worker can resolve and cache Secrets Store bindings.'
    )
  }
  const parsed = JSON.parse(cached) as Record<string, string>

  for (const key of SECRET_KEYS) {
    if (!parsed[key] || parsed[key].startsWith('[object')) {
      throw new Error(`Secret ${key} is missing or unresolved in KV cache`)
    }
  }

  return parsed as unknown as ResolvedSecrets
}
