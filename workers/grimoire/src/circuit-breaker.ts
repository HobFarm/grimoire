// Circuit breaker: KV-backed provider health tracking.
// After 3 consecutive failures within 5 minutes, skip provider for 15 minutes.

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

/**
 * Check if a provider is currently healthy.
 * Returns true if healthy (should be called), false if circuit is open.
 */
export async function isHealthy(
  kv: KVNamespace,
  providerKey: string
): Promise<boolean> {
  const raw = await kv.get(kvKey(providerKey))
  if (!raw) return true

  const health: ProviderHealth = JSON.parse(raw)
  // If failures are old (outside window), treat as healthy
  if (Date.now() - health.lastFailure > WINDOW_MS) return true
  // If under threshold, still healthy
  return health.failures < FAILURE_THRESHOLD
}

/**
 * Record a failure for a provider.
 * If threshold reached, the KV entry persists for COOLDOWN_TTL (circuit opens).
 */
export async function recordFailure(
  kv: KVNamespace,
  providerKey: string
): Promise<void> {
  const raw = await kv.get(kvKey(providerKey))
  const now = Date.now()

  let health: ProviderHealth
  if (raw) {
    health = JSON.parse(raw)
    // Reset counter if last failure was outside the window
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

/**
 * Record a success. Clears the failure counter.
 */
export async function recordSuccess(
  kv: KVNamespace,
  providerKey: string
): Promise<void> {
  await kv.delete(kvKey(providerKey))
}
