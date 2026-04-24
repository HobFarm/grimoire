// hobbot-pipeline: knowledge ingest, blog pipeline, chunk enrichment, SF outcomes
// Phase 3 of the HobBot swarm decomposition

import { WorkerEntrypoint } from 'cloudflare:workers'
import { fromUrl } from './adapters/from-url'
import { fromText } from './adapters/from-text'
import { fromImage } from './adapters/from-image'
import { fromPdf } from './adapters/from-pdf'
import { runKnowledgePipeline } from './pipeline/run'
import { analyzeImage } from './services/image-analysis'
import { processRssIngestQueue } from './services/rss-ingest-queue'
import { enrichChunksBatched } from './services/chunk-enrichment'
import { processStyleFusionOutcomes } from './services/sf-outcome'
import { runBlogPipeline } from './blog/pipeline'
import { runBridge } from './blog/bridge'
import { promoteToGitHub } from './blog/publish'
import type {
  IngestFromUrlParams, IngestFromTextParams, IngestBatchParams,
  IngestFromImageParams, IngestFromPdfParams, ClassifyImageParams, PipelineResult,
} from '@shared/rpc/pipeline-types'
import type { BlogChannel } from './blog/types'

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
        `cron:last:hobbot-pipeline:${phase}`,
        JSON.stringify({ worker: 'hobbot-pipeline', phase, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - start, status, error, meta }),
        { expirationTtl: CRON_TTL },
      )
    } catch { /* don't break cron for KV write failure */ }
  }
}

export interface Env {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  R2: R2Bucket
  AI: Ai
  GEMINI_API_KEY: string
  PROVIDER_HEALTH: KVNamespace
  GRIMOIRE: Fetcher
  STYLEFUSION_URL?: string
  GITHUB_TOKEN: string
  ENVIRONMENT: 'development' | 'production'
  SELF_URL: string
  INTERNAL_SECRET: string | { get: () => Promise<string> }
  SERVICE_TOKENS: string | { get: () => Promise<string> }
}

// RPC entrypoint: gateway delegates pipeline operations here
export class PipelineEntrypoint extends WorkerEntrypoint<Env> {
  // Service-binding fetch: gateway binds with entrypoint = "PipelineEntrypoint",
  // so .fetch() lands here instead of the module default. Delegate to the default
  // handler so /internal/* routes (ingest-async, enrich-trigger, rss-ingest) remain
  // reachable from the gateway.
  async fetch(request: Request): Promise<Response> {
    return defaultHandler.fetch(request, this.env, this.ctx)
  }

  async ingestFromUrl(params: IngestFromUrlParams): Promise<PipelineResult> {
    const adapterResult = await fromUrl(this.env, params)
    if (adapterResult.already_ingested) {
      return {
        document_id: '',
        source_id: '',
        chunks_created: 0,
        concepts_extracted: 0,
        atoms_matched: 0,
        atoms_created: 0,
        relations_created: 0,
        step_status: { status: 'already_ingested' },
        errors: [],
        dry_run: false,
        ingest_log: adapterResult.ingest_log,
      }
    }
    if (!adapterResult.doc) throw new Error('adapter returned no document')
    return runKnowledgePipeline(this.env, adapterResult.doc, {
      dry_run: params.dry_run,
      logId: adapterResult.logId,
      sourceId: adapterResult.sourceId,
      documentId: adapterResult.documentId,
    })
  }

  async ingestFromText(params: IngestFromTextParams): Promise<PipelineResult> {
    const doc = fromText(params)
    return runKnowledgePipeline(this.env, doc, { dry_run: params.dry_run })
  }

  async ingestBatch(params: IngestBatchParams): Promise<PipelineResult[]> {
    const results: PipelineResult[] = []
    for (let i = 0; i < params.urls.length; i++) {
      try {
        const adapterResult = await fromUrl(this.env, {
          url: params.urls[i].url,
          source_type: params.urls[i].source_type ?? 'aesthetic',
          collection_slug: params.collection_slug,
          dry_run: params.dry_run,
        })
        if (adapterResult.already_ingested) {
          results.push({
            document_id: '', source_id: '', chunks_created: 0, concepts_extracted: 0,
            atoms_matched: 0, atoms_created: 0, relations_created: 0,
            step_status: { status: 'already_ingested' }, errors: [], dry_run: false,
            ingest_log: adapterResult.ingest_log,
          })
        } else if (adapterResult.doc) {
          results.push(await runKnowledgePipeline(this.env, adapterResult.doc, {
            dry_run: params.dry_run,
            logId: adapterResult.logId,
            sourceId: adapterResult.sourceId,
            documentId: adapterResult.documentId,
          }))
        }
      } catch (error) {
        results.push({
          document_id: 'error', source_id: '', chunks_created: 0, concepts_extracted: 0,
          atoms_matched: 0, atoms_created: 0, relations_created: 0,
          step_status: {}, errors: [(error as Error).message], dry_run: !!params.dry_run,
        })
      }
      if (i < params.urls.length - 1) await new Promise(r => setTimeout(r, 1000))
    }
    return results
  }

  async ingestFromImage(params: IngestFromImageParams): Promise<PipelineResult> {
    const { doc, analysis, r2_key, source_url } = await fromImage(this.env, params)
    const result = await runKnowledgePipeline(this.env, doc, { dry_run: params.dry_run })
    // Attach image-specific metadata to result
    return {
      ...result,
      step_status: {
        ...result.step_status,
        image_type: analysis.image_type,
        r2_key: r2_key ?? undefined,
        cdn_url: r2_key ? `https://cdn.hob.farm/${r2_key}` : undefined,
      } as Record<string, string>,
    }
  }

  async ingestFromPdf(params: IngestFromPdfParams): Promise<PipelineResult> {
    const adapterResult = await fromPdf(this.env, params)
    if (adapterResult.already_ingested) {
      return {
        document_id: '',
        source_id: '',
        chunks_created: 0,
        concepts_extracted: 0,
        atoms_matched: 0,
        atoms_created: 0,
        relations_created: 0,
        step_status: { status: 'already_ingested' },
        errors: [],
        dry_run: false,
        ingest_log: adapterResult.ingest_log,
      }
    }
    if (!adapterResult.doc) {
      return {
        document_id: '',
        source_id: '',
        chunks_created: 0,
        concepts_extracted: 0,
        atoms_matched: 0,
        atoms_created: 0,
        relations_created: 0,
        step_status: { status: 'no_content' },
        errors: ['PDF extraction returned no usable content blocks'],
        dry_run: params.dry_run ?? false,
      }
    }
    return runKnowledgePipeline(this.env, adapterResult.doc, {
      dry_run: params.dry_run,
      logId: adapterResult.logId,
      sourceId: adapterResult.sourceId,
      documentId: adapterResult.documentId,
    })
  }

  async classifyImage(params: ClassifyImageParams) {
    return analyzeImage(this.env, params)
  }

  async runBlogPipeline(channel?: string) {
    return runBlogPipeline(this.env, (channel ?? 'blog') as BlogChannel)
  }

  async runBridge() {
    return runBridge(this.env)
  }

  async publishDraft(id: number) {
    const post = await this.env.HOBBOT_DB
      .prepare('SELECT * FROM blog_posts WHERE id = ?')
      .bind(id).first()
    if (!post) throw new Error('draft not found')
    if ((post as any).status !== 'draft') throw new Error('not draft status')
    const ghToken = typeof this.env.GITHUB_TOKEN === 'string'
      ? this.env.GITHUB_TOKEN
      : await (this.env.GITHUB_TOKEN as any).get()
    return promoteToGitHub(post as any, ghToken, this.env.HOBBOT_DB)
  }
}

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Async ingest trigger (called by gateway MCP tools for non-blocking ingestion)
    if (url.pathname === '/internal/ingest-async' && request.method === 'POST') {
      const body = await request.json() as { url: string; source_type?: string; collection_slug?: string; batch_id?: string; tags?: string[] }
      ctx.waitUntil((async () => {
        try {
          const adapterResult = await fromUrl(env, {
            url: body.url,
            source_type: (body.source_type ?? 'domain') as 'aesthetic' | 'domain',
            collection_slug: body.collection_slug,
            dry_run: false,
          })
          if (adapterResult.already_ingested) {
            console.log(`[ingest-async] already ingested: ${body.url}`)
            if (body.batch_id) {
              await env.HOBBOT_DB.prepare(
                `UPDATE ingestion_batch_items SET status = 'skipped', completed_at = datetime('now') WHERE batch_id = ? AND url = ?`
              ).bind(body.batch_id, body.url).run()
            }
            return
          }
          if (!adapterResult.doc) {
            console.log(`[ingest-async] no document: ${body.url}`)
            if (body.batch_id) {
              await env.HOBBOT_DB.prepare(
                `UPDATE ingestion_batch_items SET status = 'failed', error = 'no document from adapter', completed_at = datetime('now') WHERE batch_id = ? AND url = ?`
              ).bind(body.batch_id, body.url).run()
            }
            return
          }
          const result = await runKnowledgePipeline(env, adapterResult.doc, {
            logId: adapterResult.logId,
            sourceId: adapterResult.sourceId,
            documentId: adapterResult.documentId,
          })
          console.log(`[ingest-async] completed: ${body.url} chunks=${result.chunks_created} atoms=${result.atoms_created}`)
          if (body.batch_id) {
            await env.HOBBOT_DB.prepare(
              `UPDATE ingestion_batch_items SET status = 'completed', document_id = ?, completed_at = datetime('now') WHERE batch_id = ? AND url = ?`
            ).bind(result.document_id, body.batch_id, body.url).run()
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e)
          console.error(`[ingest-async] failed: ${body.url} - ${error}`)
          if (body.batch_id) {
            await env.HOBBOT_DB.prepare(
              `UPDATE ingestion_batch_items SET status = 'failed', error = ?, completed_at = datetime('now') WHERE batch_id = ? AND url = ?`
            ).bind(error.slice(0, 500), body.batch_id, body.url).run()
          }
        }
        // Update batch-level completion if all items are done
        if (body.batch_id) {
          try {
            const pending = await env.HOBBOT_DB.prepare(
              `SELECT count(*) as cnt FROM ingestion_batch_items WHERE batch_id = ? AND status = 'queued'`
            ).bind(body.batch_id).first<{ cnt: number }>()
            if (pending && pending.cnt === 0) {
              const stats = await env.HOBBOT_DB.prepare(
                `SELECT sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed, sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed FROM ingestion_batch_items WHERE batch_id = ?`
              ).bind(body.batch_id).first<{ completed: number; failed: number }>()
              await env.HOBBOT_DB.prepare(
                `UPDATE ingestion_batches SET completed = ?, failed = ?, completed_at = datetime('now') WHERE id = ?`
              ).bind(stats?.completed ?? 0, stats?.failed ?? 0, body.batch_id).run()
              console.log(`[ingest-async] batch ${body.batch_id} complete: ${stats?.completed} ok, ${stats?.failed} failed`)
            }
          } catch { /* non-fatal */ }
        }
      })())
      return new Response(JSON.stringify({ ok: true, accepted: true, url: body.url }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Enrichment trigger (called by gateway admin tool via service binding)
    if (url.pathname === '/internal/enrich-trigger' && request.method === 'POST') {
      ctx.waitUntil(
        enrichChunksBatched(env, ctx, 0, 0)
          .then(r => console.log(`[enrich-trigger] enriched=${r.enriched} failed=${r.failed}`))
          .catch(e => console.error(`[enrich-trigger] error: ${e instanceof Error ? e.message : e}`))
      )
      return new Response(JSON.stringify({ ok: true, triggered: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Immediate RSS ingest trigger (called by custodian after writing feed_entries)
    if (url.pathname === '/internal/rss-ingest' && request.method === 'POST') {
      ctx.waitUntil(
        processRssIngestQueue(env)
          .then(r => console.log(`[rss-trigger] processed=${r.processed} failed=${r.failed}`))
          .catch(e => console.error(`[rss-trigger] error: ${e instanceof Error ? e.message : e}`))
      )
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.pathname === '/internal/enrich-continue' && request.method === 'POST') {
      const internalSecret = typeof env.INTERNAL_SECRET === 'string'
        ? env.INTERNAL_SECRET
        : await env.INTERNAL_SECRET?.get() ?? ''
      if (internalSecret && request.headers.get('x-internal-secret') !== internalSecret) {
        return new Response('unauthorized', { status: 401 })
      }
      const depth = parseInt(url.searchParams.get('depth') ?? '0', 10)
      const total = parseInt(url.searchParams.get('total') ?? '0', 10)
      ctx.waitUntil(
        enrichChunksBatched(env, ctx, depth, total)
          .then(r => console.log(`[enrich-continue] depth=${depth} enriched=${r.enriched} failed=${r.failed}`))
          .catch(e => console.error(`[enrich-continue] depth=${depth} error: ${e instanceof Error ? e.message : e}`))
      )
      return new Response(JSON.stringify({ ok: true, depth }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ worker: 'hobbot-pipeline', ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 */6 * * *') {
      ctx.waitUntil(trackCron(env, 'enrichment', async () => {
        const r = await enrichChunksBatched(env, ctx, 0, 0)
        console.log(`[cron] chunk-enrich: enriched=${r.enriched} failed=${r.failed} docs_completed=${r.documents_completed.length}`)
        return { enriched: r.enriched, failed: r.failed, docs_completed: r.documents_completed.length }
      }))
      ctx.waitUntil(trackCron(env, 'sf-outcomes', async () => {
        const r = await processStyleFusionOutcomes(env)
        console.log(`[cron] sf-outcomes: exported=${r.exported} failed=${r.failed}`)
        return { exported: r.exported, failed: r.failed }
      }))
      ctx.waitUntil(trackCron(env, 'rss-ingest', async () => {
        const r = await processRssIngestQueue(env)
        console.log(`[cron] rss-ingest: processed=${r.processed} failed=${r.failed}`)
        return { processed: r.processed, failed: r.failed }
      }))
    } else if (event.cron === '0 5 * * *') {
      ctx.waitUntil(trackCron(env, 'bridge', async () => {
        const r = await runBridge(env)
        console.log(`[cron] bridge: scanned=${r.candidatesScanned} queued=${r.queued}`)
        return { scanned: r.candidatesScanned, queued: r.queued }
      }))
    } else if (event.cron === '0 8 * * *') {
      ctx.waitUntil(trackCron(env, 'blog', async () => {
        const r = await runBlogPipeline(env)
        console.log(`[cron] blog: success=${r.success} noop=${r.noop} slug=${r.slug ?? '-'}`)
        return { success: r.success, noop: r.noop, slug: r.slug ?? null }
      }))
    }
  },
}

export default defaultHandler
