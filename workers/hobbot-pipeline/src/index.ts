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
  INTERNAL_SECRET: string
}

// RPC entrypoint: gateway delegates pipeline operations here
export class PipelineEntrypoint extends WorkerEntrypoint<Env> {
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
    return runBlogPipeline(this.env as any, (channel ?? 'blog') as BlogChannel)
  }

  async runBridge() {
    return runBridge(this.env as any)
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/internal/enrich-continue' && request.method === 'POST') {
      if (env.INTERNAL_SECRET && request.headers.get('x-internal-secret') !== env.INTERNAL_SECRET) {
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
      ctx.waitUntil(
        enrichChunksBatched(env, ctx, 0, 0)
          .then(r => console.log(`[cron] chunk-enrich: enriched=${r.enriched} failed=${r.failed} docs_completed=${r.documents_completed.length}`))
          .catch(e => console.log(`[cron] chunk-enrich failed: ${e instanceof Error ? e.message : e}`))
      )
      ctx.waitUntil(
        processStyleFusionOutcomes(env)
          .then(r => console.log(`[cron] sf-outcomes: exported=${r.exported} failed=${r.failed}`))
          .catch(e => console.log(`[cron] sf-outcomes failed: ${e instanceof Error ? e.message : e}`))
      )
      ctx.waitUntil(
        processRssIngestQueue(env)
          .then(r => console.log(`[cron] rss-ingest: processed=${r.processed} failed=${r.failed}`))
          .catch(e => console.log(`[cron] rss-ingest failed: ${e instanceof Error ? e.message : e}`))
      )
    } else if (event.cron === '0 5 * * *') {
      ctx.waitUntil(
        runBridge(env as any)
          .then(r => console.log(`[cron] bridge: scanned=${r.candidatesScanned} queued=${r.queued}`))
          .catch(e => console.log(`[cron] bridge failed: ${e instanceof Error ? e.message : e}`))
      )
    } else if (event.cron === '0 8 * * *') {
      ctx.waitUntil(
        runBlogPipeline(env as any)
          .then(r => console.log(`[cron] blog: success=${r.success} noop=${r.noop} slug=${r.slug ?? '-'}`))
          .catch(e => console.log(`[cron] blog failed: ${e instanceof Error ? e.message : e}`))
      )
    }
  },
}
