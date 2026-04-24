// Chunk enrichment safety net with batched continuation
// Runs on cron (0 */6 * * *). Catches chunks missed by inline pipeline enrichment.
// Processes BATCH_SIZE chunks per invocation, then self-invokes for the next batch.
// Each invocation gets a fresh D1 CPU budget, avoiding the per-invocation limit.
//
// Uses the same provider chain (Qwen3 primary, Gemini fallback) and prompt as
// the inline pipeline agent (runEnrichmentAgent). Unified via callWithJsonParse.

import { getUnenrichedChunks, updateChunk, areAllChunksEnriched, updateDocumentStatus } from '@shared/state/documents'
import { getCategories, getArrangements } from '@shared/state/grimoire'
import { buildEnrichmentPrompt, buildEnrichmentUserMessage } from '../prompts/pipeline-enrichment'
import { callWithJsonParse } from '@shared/providers/call-with-json-parse'
import { resolveApiKey, createTokenLogger } from '@shared/providers'
import { MODELS } from '@shared/models'
import { createLogger } from '@shared/logger'

const log = createLogger('hobbot-pipeline')

interface ChunkEnrichEnv {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  AI: Ai
  SELF_URL?: string
  INTERNAL_SECRET?: string | { get: () => Promise<string> }
}

interface EnrichmentResult {
  enriched: number
  failed: number
  documents_completed: string[]
}

interface EnrichOutput {
  summary: string
  category_slug: string | null
  arrangement_slugs: string[]
  quality_score: number
  key_concepts: { term: string; category_hint: string | null; is_proper_noun: boolean }[]
}

const DELAY_MS = 6_000
const BATCH_SIZE = 10
const MAX_DEPTH = 20

export async function enrichChunksBatched(
  env: ChunkEnrichEnv,
  ctx: { waitUntil: (p: Promise<any>) => void },
  depth: number = 0,
  totalSoFar: number = 0,
): Promise<EnrichmentResult> {
  const db = env.GRIMOIRE_DB
  const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)

  const [categories, arrangements] = await Promise.all([
    getCategories(db),
    getArrangements(db),
  ])

  const categorySlugs = categories.map(c => ({ slug: c.slug }))
  const arrangementList = arrangements.map(a => ({ slug: a.slug, name: a.name }))
  const systemPrompt = buildEnrichmentPrompt(categorySlugs, arrangementList)

  const categorySet = new Set(categories.map(c => c.slug))
  const arrangementSet = new Set(arrangements.map(a => a.slug))

  const chunks = await getUnenrichedChunks(db, BATCH_SIZE)
  if (chunks.length === 0) {
    if (depth > 0) {
      console.log(`[chunk-enrich] complete: total=${totalSoFar} across ${depth} invocations`)
    }
    return { enriched: 0, failed: 0, documents_completed: [] }
  }

  log.info('chunk-enrich batch start', { depth, chunks: chunks.length })

  let enriched = 0
  let failed = 0
  const documentsToCheck = new Set<string>()

  for (const chunk of chunks) {
    try {
      const userMessage = buildEnrichmentUserMessage(chunk.content, chunk.document_title, '')

      const { result: parsed } = await callWithJsonParse<EnrichOutput>(
        'pipeline.enrichment',
        systemPrompt,
        userMessage,
        env.AI,
        geminiKey,
        MODELS['pipeline.enrichment'],
        { onUsage: createTokenLogger(env.HOBBOT_DB, 'hobbot-pipeline') },
      )

      const validCategory = parsed.category_slug && categorySet.has(parsed.category_slug)
        ? parsed.category_slug
        : chunk.category_slug

      const validArrangements = Array.isArray(parsed.arrangement_slugs)
        ? parsed.arrangement_slugs.filter((s: string) => arrangementSet.has(s))
        : []

      await updateChunk(db, chunk.chunk_id, {
        summary: parsed.summary || undefined,
        category_slug: validCategory ?? undefined,
        arrangement_slugs: validArrangements,
        quality_score: Math.max(0, Math.min(1, parsed.quality_score ?? 0.5)),
      })

      documentsToCheck.add(chunk.document_id)
      enriched++
    } catch (err) {
      log.warn('chunk-enrich failed', { chunk_id: chunk.chunk_id, error: (err as Error).message })
      failed++
    }

    if (chunks.indexOf(chunk) < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS))
    }
  }

  const documentsCompleted: string[] = []
  for (const docId of documentsToCheck) {
    try {
      const allDone = await areAllChunksEnriched(db, docId)
      if (allDone) {
        await updateDocumentStatus(db, docId, 'enriched')
        documentsCompleted.push(docId)
      }
    } catch (err) {
      console.warn(`[chunk-enrich] failed to check/update document=${docId}: ${(err as Error).message}`)
    }
  }

  // Check if more unenriched chunks remain
  const batchTotal = totalSoFar + enriched
  const remaining = await getUnenrichedChunks(db, 1)
  if (remaining.length > 0 && depth < MAX_DEPTH && env.SELF_URL) {
    log.info('chunk-enrich continuing', { next_depth: depth + 1, cumulative: batchTotal })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const internalSecret = typeof env.INTERNAL_SECRET === 'string'
      ? env.INTERNAL_SECRET
      : await env.INTERNAL_SECRET?.get() ?? ''
    if (internalSecret) headers['x-internal-secret'] = internalSecret
    ctx.waitUntil(
      fetch(`${env.SELF_URL}/internal/enrich-continue?depth=${depth + 1}&total=${batchTotal}`, {
        method: 'POST',
        headers,
      }).catch(e => console.error(`[chunk-enrich] continuation fetch failed: ${e}`))
    )
  } else if (remaining.length === 0 && depth > 0) {
    console.log(`[chunk-enrich] complete: total=${batchTotal} across ${depth + 1} invocations`)
  }

  return { enriched, failed, documents_completed: documentsCompleted }
}
