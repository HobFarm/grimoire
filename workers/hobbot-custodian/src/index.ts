// hobbot-custodian: Background jobs worker
// Owns: harvesters (RSS, Getty AAT, Wikidata), integrity scanning,
// correspondence building, discovery queue processing.
// NO R2, NO ingest pipeline. Decoupled via feed_entries table.

import { WorkerEntrypoint } from 'cloudflare:workers'
import { RssHarvester } from './harvesters/rss'
import { GettyAatHarvester } from './harvesters/getty-aat'
import { WikidataHarvester } from './harvesters/wikidata'
import { buildCorrespondences } from './pipeline/correspondence-builder'
import { buildHarvestHealthReport } from './pipeline/harvest-health'
import { processDiscoveryQueue } from './state/discovery-processor'
import { runIntegrityScan, runEvolveReport } from './integrity'
import { logAction } from '@shared/ledger'
import { runConductor } from './conductor'
import { runArchiveOrgAgent } from './agents/archive-org'

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
        `cron:last:hobbot-custodian:${phase}`,
        JSON.stringify({ worker: 'hobbot-custodian', phase, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - start, status, error, meta }),
        { expirationTtl: CRON_TTL },
      )
    } catch { /* don't break cron for KV write failure */ }
  }
}

export interface Env {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  AI: Ai
  PROVIDER_HEALTH: KVNamespace
  GRIMOIRE: Fetcher
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_NAME: string
  AI_GATEWAY_TOKEN: string | { get: () => Promise<string> }
  HOBBOT_PIPELINE: Fetcher
  ENVIRONMENT: 'development' | 'production'
}

// RPC entrypoint: gateway delegates admin operations here
export class CustodianEntrypoint extends WorkerEntrypoint<Env> {
  async harvest(sourceType: string, batchSize: number) {
    const registry: Record<string, () => { harvest: (env: Env, cursor: string | null, batchSize: number) => Promise<unknown> }> = {
      'getty-aat': () => new GettyAatHarvester(),
      'wikidata-visual-arts': () => new WikidataHarvester(),
      'rss-feeds': () => new RssHarvester(),
    }
    const factory = registry[sourceType]
    if (!factory) return { error: `unknown harvester: ${sourceType}` }
    const harvester = factory()
    return harvester.harvest(this.env, null, batchSize)
  }

  async buildCorrespondences(sourceId: string) {
    return buildCorrespondences(this.env.GRIMOIRE_DB, this.env.HOBBOT_DB, sourceId)
  }

  async processDiscovery() {
    return processDiscoveryQueue(this.env.GRIMOIRE_DB)
  }

  async harvestHealth(collectionSlug: string) {
    return buildHarvestHealthReport(this.env.GRIMOIRE_DB, collectionSlug)
  }

  async runConductor() {
    return runConductor(this.env)
  }

  async runAgent(agentName: string) {
    if (agentName === 'archive-org') return runArchiveOrgAgent(this.env)
    // Phase C: if (agentName === 'getty') return runGettyAgent(this.env)
    return { error: `unknown agent: ${agentName}` }
  }

  async listKnowledgeRequests(status?: string) {
    const sql = status
      ? 'SELECT * FROM knowledge_requests WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT 50'
      : 'SELECT * FROM knowledge_requests ORDER BY priority DESC, created_at DESC LIMIT 50'
    const { results } = status
      ? await this.env.HOBBOT_DB.prepare(sql).bind(status).all()
      : await this.env.HOBBOT_DB.prepare(sql).all()
    return results ?? []
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response(JSON.stringify({ worker: 'hobbot-custodian', ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 */6 * * *') {
      ctx.waitUntil(trackCron(env, 'integrity', async () => {
        await runIntegrityScan(env.GRIMOIRE_DB)
        return {}
      }))
      ctx.waitUntil(trackCron(env, 'rss', async () => {
        const r = await new RssHarvester().harvest(env, null, 50)
        console.log(`[cron] rss: fetched=${r.items_fetched} ingested=${r.items_ingested} skipped=${r.items_skipped}`)
        // Trigger immediate pipeline pickup if new entries were written
        if (r.items_ingested > 0) {
          try {
            await env.HOBBOT_PIPELINE.fetch('https://hobbot-pipeline/internal/rss-ingest', { method: 'POST' })
            console.log(`[cron] rss: triggered immediate pipeline ingest`)
          } catch {
            console.warn(`[cron] rss: immediate pipeline trigger failed (cron fallback will catch)`)
          }
        }
        return { fetched: r.items_fetched, ingested: r.items_ingested, skipped: r.items_skipped }
      }))
      ctx.waitUntil(trackCron(env, 'conductor', async () => {
        const r = await runConductor(env)
        console.log(`[cron] conductor: gaps=${r.gaps} created=${r.created} stale_released=${r.stale_released} completed=${r.completed}`)
        return { gaps: r.gaps, created: r.created, stale_released: r.stale_released, completed: r.completed }
      }))
      ctx.waitUntil(trackCron(env, 'archive-org', async () => {
        const r = await runArchiveOrgAgent(env)
        console.log(`[cron] archive-org: claimed=${r.claimed} searched=${r.searched} queued=${r.queued}`)
        if (r.queued > 0) {
          try {
            await env.HOBBOT_PIPELINE.fetch('https://hobbot-pipeline/internal/rss-ingest', { method: 'POST' })
            console.log(`[cron] archive-org: triggered immediate pipeline ingest`)
          } catch {
            console.warn(`[cron] archive-org: immediate pipeline trigger failed (cron fallback will catch)`)
          }
        }
        return { claimed: r.claimed, searched: r.searched, queued: r.queued }
      }))
    } else if (event.cron === '0 0 * * 1') {
      ctx.waitUntil(trackCron(env, 'evolve-report', async () => {
        await runEvolveReport(env.GRIMOIRE_DB)
        return {}
      }))
    } else if (event.cron === '0 2 * * 1') {
      ctx.waitUntil(trackCron(env, 'getty-aat', async () => {
        const r = await new GettyAatHarvester().harvest(env, null, 100)
        console.log(`[cron] getty-aat: fetched=${r.items_fetched} ingested=${r.items_ingested}`)
        await logAction(env.HOBBOT_DB, {
          action_type: 'ingested',
          topic_key: 'getty-aat',
          payload: { fetched: r.items_fetched, ingested: r.items_ingested, skipped: r.items_skipped },
          status: r.error ? 'failed' : 'complete',
          completed_at: new Date().toISOString(),
        }).catch(e => console.warn(`[cron] getty-aat ledger: ${e}`))
        let correspondences = 0
        if (r.items_ingested > 0) {
          const cr = await buildCorrespondences(env.GRIMOIRE_DB, env.HOBBOT_DB, 'getty-aat')
          console.log(`[cron] getty-aat correspondences: created=${cr.created} matched=${cr.matched}`)
          correspondences = cr.created
        }
        return { fetched: r.items_fetched, ingested: r.items_ingested, correspondences }
      }))
    } else if (event.cron === '0 3 * * 3') {
      ctx.waitUntil(trackCron(env, 'wikidata', async () => {
        const r = await new WikidataHarvester().harvest(env, null, 50)
        console.log(`[cron] wikidata: fetched=${r.items_fetched} ingested=${r.items_ingested}`)
        await logAction(env.HOBBOT_DB, {
          action_type: 'ingested',
          topic_key: 'wikidata-visual-arts',
          payload: { fetched: r.items_fetched, ingested: r.items_ingested, skipped: r.items_skipped },
          status: r.error ? 'failed' : 'complete',
          completed_at: new Date().toISOString(),
        }).catch(e => console.warn(`[cron] wikidata ledger: ${e}`))
        let correspondences = 0
        if (r.items_ingested > 0) {
          const cr = await buildCorrespondences(env.GRIMOIRE_DB, env.HOBBOT_DB, 'wikidata-visual-arts')
          console.log(`[cron] wikidata correspondences: created=${cr.created} matched=${cr.matched}`)
          correspondences = cr.created
        }
        return { fetched: r.items_fetched, ingested: r.items_ingested, correspondences }
      }))
    }
  },
}
