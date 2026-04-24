// Circuit breaker: KV-backed provider health tracking.
// After 3 consecutive failures within 5 minutes, skip provider for 15 minutes.
// Copied from workers/grimoire/src/circuit-breaker.ts (shared PROVIDER_HEALTH KV).
//
// PHASE-3: Circuit breaker audit findings (Phase 1 step 6)
// KV key format: MATCH - both use `provider:health:${providerKey}`
// Thresholds: MATCH - 3 failures in 5 min (WINDOW_MS=300000), cooldown TTL=900s (15 min)
// Reset behavior: MATCH - both delete KV key on success
// Sub-threshold TTL: MATCH - both use 600s TTL when failures < 3
// Recommendation: Unify in Phase 3. Extract to shared module, both workers import it.
//   Chat's version is identical to call-with-json-parse.ts lines 24-53.

export interface ProviderHealth {
  failures: number
  lastFailure: number // Unix ms
}

const FAILURE_THRESHOLD = 3
const WINDOW_MS = 5 * 60 * 1000       // 5 minutes
const COOLDOWN_TTL = 900               // 15 minutes (KV TTL in seconds)

function kvKey(providerKey: string): string {
  return `provider:health:${providerKey}`
}

export async function isHealthy(
  kv: KVNamespace,
  providerKey: string
): Promise<boolean> {
  const raw = await kv.get(kvKey(providerKey))
  if (!raw) return true

  const health: ProviderHealth = JSON.parse(raw)
  if (Date.now() - health.lastFailure > WINDOW_MS) return true
  return health.failures < FAILURE_THRESHOLD
}

export async function recordFailure(
  kv: KVNamespace,
  providerKey: string
): Promise<void> {
  const raw = await kv.get(kvKey(providerKey))
  const now = Date.now()

  let health: ProviderHealth
  if (raw) {
    health = JSON.parse(raw)
    if (now - health.lastFailure > WINDOW_MS) {
      health = { failures: 1, lastFailure: now }
    } else {
      health.failures++
      health.lastFailure = now
    }
  } else {
    health = { failures: 1, lastFailure: now }
  }

  const ttl = health.failures >= FAILURE_THRESHOLD ? COOLDOWN_TTL : 600
  await kv.put(kvKey(providerKey), JSON.stringify(health), { expirationTtl: ttl })
}

export async function recordSuccess(
  kv: KVNamespace,
  providerKey: string
): Promise<void> {
  await kv.delete(kvKey(providerKey))
}
