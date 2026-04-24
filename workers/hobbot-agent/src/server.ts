import { routeAgentRequest } from 'agents'
import type { Env } from './env'
import { SECRET_KEYS, KV_SECRETS_KEY } from './env'

export { HobBotAgent } from './agent'

/**
 * Resolve Secrets Store bindings to plain strings in the stateless worker context
 * (where they're directly accessible), then cache in KV for the DO to read.
 * In the stateless worker, Secrets Store bindings are plain strings.
 * In the DO, they become unresolvable RPC proxies.
 */
async function cacheSecretsToKV(env: Env): Promise<void> {
  const secrets: Record<string, string> = {}

  for (const key of SECRET_KEYS) {
    const binding = env[key] as any
    // Secrets Store bindings expose .get() to retrieve the plaintext value
    secrets[key] = typeof binding === 'string' ? binding : await binding.get()
  }

  await env.PROVIDER_HEALTH.put(KV_SECRETS_KEY, JSON.stringify(secrets), { expirationTtl: 86400 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Cache resolved secrets in KV so the DO can read them
    await cacheSecretsToKV(env)

    const response = await routeAgentRequest(request, env)
    if (response) return response

    return new Response('HobBot Agent v2', { status: 200 })
  },
} satisfies ExportedHandler<Env>
