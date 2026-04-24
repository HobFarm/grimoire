// Worker entry point: cron routing, fetch handler (MCP signals endpoint + manual trigger)

import type { Env } from './types'
import { TIER_CRONS, ROLLUP_CRON, RETENTION_CRON } from './config'
import { scanTier } from './scanner'
import { runDailyRollup } from './rollup'
import { runRetention } from './retention'
import { getLatestTrend, querySignalsBySubreddit, querySignalsByTopic } from './storage'

// --- KV Cron Instrumentation ---

const CRON_TTL = 7 * 24 * 60 * 60 // 7 days

async function trackCron(
  env: { PROVIDER_HEALTH: KVNamespace },
  phase: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const start = Date.now()
  let status: 'success' | 'error' = 'success'
  let error: string | undefined
  let meta: Record<string, unknown> = {}
  try {
    meta = await fn()
  } catch (e) {
    status = 'error'
    error = e instanceof Error ? e.message : String(e)
    console.log(`[cron] ${phase} failed: ${error}`)
  } finally {
    try {
      await env.PROVIDER_HEALTH.put(
        `cron:last:reddit-scanner:${phase}`,
        JSON.stringify({ worker: 'reddit-scanner', phase, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - start, status, error, meta }),
        { expirationTtl: CRON_TTL },
      )
    } catch { /* don't break cron for KV write failure */ }
  }
}

// --- JSON Response Helpers ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorJson(message: string, status = 400): Response {
  return json({ error: message }, status)
}

// --- Fetch Handler ---

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  // Health check
  if (url.pathname === '/' && request.method === 'GET') {
    return json({ worker: 'reddit-scanner', ok: true })
  }

  // MCP signals endpoint
  if (url.pathname === '/api/signals' && request.method === 'POST') {
    return handleSignals(request, env)
  }

  // Manual scan trigger (for testing)
  if (url.pathname === '/api/scan' && request.method === 'POST') {
    return handleManualScan(request, env, url)
  }

  return errorJson('not found', 404)
}

async function handleSignals(request: Request, env: Env): Promise<Response> {
  let body: { query?: string; subreddit?: string; days?: number } = {}
  try {
    const text = await request.text()
    if (text) body = JSON.parse(text)
  } catch {
    // Empty body is valid (returns latest trend)
  }

  const days = Math.max(1, Math.min(30, body.days ?? 7))

  // Subreddit filter
  if (body.subreddit) {
    const signals = await querySignalsBySubreddit(env.REDDIT_SCANNER_DB, body.subreddit, days)
    return json({ subreddit: body.subreddit, days, signals })
  }

  // Topic search
  if (body.query) {
    const signals = await querySignalsByTopic(env.REDDIT_SCANNER_DB, body.query, days)
    return json({ query: body.query, days, signals })
  }

  // No args: return latest daily trend
  const today = new Date().toISOString().split('T')[0]
  let trend = await getLatestTrend(env, today)
  if (!trend) {
    // Try yesterday
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    trend = await getLatestTrend(env, yesterday.toISOString().split('T')[0])
  }

  if (!trend) {
    return json({ message: 'No trend data available yet. Rollup runs daily at 06:00 UTC.' })
  }

  return json(trend)
}

async function handleManualScan(_request: Request, env: Env, url: URL): Promise<Response> {
  const tierParam = url.searchParams.get('tier')
  if (!tierParam || !['1', '2', '3'].includes(tierParam)) {
    return errorJson('tier query param required (1, 2, or 3)')
  }

  const tier = parseInt(tierParam, 10) as 1 | 2 | 3
  console.log(`[manual] Starting tier ${tier} scan`)

  const result = await scanTier(tier, env)
  return json(result)
}

// --- Scheduled Handler ---

async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // Tier scans: route by exact cron string
  if (event.cron === TIER_CRONS[1]) {
    ctx.waitUntil(trackCron(env, 'scan-tier1', async () => {
      const r = await scanTier(1, env)
      return r as unknown as Record<string, unknown>
    }))
  }

  if (event.cron === TIER_CRONS[2]) {
    ctx.waitUntil(trackCron(env, 'scan-tier2', async () => {
      const r = await scanTier(2, env)
      return r as unknown as Record<string, unknown>
    }))
  }

  if (event.cron === TIER_CRONS[3]) {
    ctx.waitUntil(trackCron(env, 'scan-tier3', async () => {
      const r = await scanTier(3, env)
      return r as unknown as Record<string, unknown>
    }))
  }

  // Daily rollup at 06:00 UTC
  if (event.cron === ROLLUP_CRON) {
    ctx.waitUntil(trackCron(env, 'rollup', () => runDailyRollup(env)))
  }

  // Retention cleanup at 07:00 UTC
  if (event.cron === RETENTION_CRON) {
    ctx.waitUntil(trackCron(env, 'retention', () => runRetention(env)))
  }
}

// --- Worker Export ---

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
}
