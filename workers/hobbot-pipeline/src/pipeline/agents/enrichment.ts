// Enrichment Agent: per-chunk enrichment + concept extraction
// Model: Qwen3-30b (Workers AI), fallback to Gemini Flash
// Replaces: extractKnowledge() page-level extraction AND deferred chunk enrichment cron

import type { AgentContext, EnrichedChunkResult, KeyConcept } from './types'
import { callWithJsonParse } from '@shared/providers/call-with-json-parse'
import { MODELS } from '@shared/models'
import { buildEnrichmentPrompt, buildEnrichmentUserMessage } from '../../prompts/pipeline-enrichment'

interface RawEnrichmentOutput {
  summary: string
  category_slug: string | null
  arrangement_slugs: string[]
  quality_score: number
  key_concepts: { term: string; category_hint: string | null; is_proper_noun: boolean }[]
}

interface ChunkInput {
  id: string
  content: string
  heading: string
}

/**
 * Enrich a single chunk: produce summary, category, arrangements, quality score, and key concepts.
 */
async function enrichOneChunk(
  ctx: AgentContext,
  chunk: ChunkInput,
  documentTitle: string,
  systemPrompt: string,
): Promise<{ enriched: EnrichedChunkResult; modelUsed: string }> {
  const userMessage = buildEnrichmentUserMessage(chunk.content, documentTitle, chunk.heading)

  const { result, modelUsed } = await callWithJsonParse<RawEnrichmentOutput>(
    'pipeline.enrichment',
    systemPrompt,
    userMessage,
    ctx.ai,
    ctx.geminiKey,
    MODELS['pipeline.enrichment'],
    { onUsage: ctx.onUsage },
  )

  // Validate and sanitize output
  const keyConcepts: KeyConcept[] = (result.key_concepts ?? [])
    .filter(kc => kc.term && typeof kc.term === 'string' && kc.term.trim().length > 0)
    .slice(0, 15)
    .map(kc => ({
      term: kc.term.trim(),
      category_hint: kc.category_hint ?? null,
      is_proper_noun: kc.is_proper_noun ?? false,
    }))

  return {
    enriched: {
      chunkId: chunk.id,
      summary: (result.summary ?? '').slice(0, 500),
      categorySlug: result.category_slug ?? null,
      arrangementSlugs: (result.arrangement_slugs ?? []).filter(s => typeof s === 'string').slice(0, 4),
      qualityScore: Math.max(0, Math.min(1, result.quality_score ?? 0.5)),
      keyConcepts,
    },
    modelUsed,
  }
}

/**
 * Run the enrichment agent on all chunks, processing in parallel batches of 3.
 * Returns enriched results and persists enrichment data to chunk rows.
 */
export async function runEnrichmentAgent(
  ctx: AgentContext,
  chunks: ChunkInput[],
  documentTitle: string,
  categories: { slug: string }[],
  arrangements: { slug: string; name: string }[],
): Promise<{ results: EnrichedChunkResult[]; modelsUsed: string[] }> {
  const systemPrompt = buildEnrichmentPrompt(categories, arrangements)
  const validArrangementSlugs = new Set(arrangements.map(a => a.slug))
  const validCategorySlugs = new Set(categories.map(c => c.slug))

  const BATCH_SIZE = 3
  const allResults: EnrichedChunkResult[] = []
  const modelsUsed: string[] = []

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(chunk => enrichOneChunk(ctx, chunk, documentTitle, systemPrompt))
    )

    for (const { enriched, modelUsed } of batchResults) {
      // Validate arrangement slugs against known set
      enriched.arrangementSlugs = enriched.arrangementSlugs.filter(s => validArrangementSlugs.has(s))

      // Validate category slug
      if (enriched.categorySlug && !validCategorySlugs.has(enriched.categorySlug)) {
        enriched.categorySlug = null
      }

      // Persist enrichment to chunk row
      await ctx.handle.documentChunkUpdate(enriched.chunkId, {
        summary: enriched.summary,
        category_slug: enriched.categorySlug ?? undefined,
        arrangement_slugs: enriched.arrangementSlugs,
        quality_score: enriched.qualityScore,
      })

      allResults.push(enriched)
      if (!modelsUsed.includes(modelUsed)) modelsUsed.push(modelUsed)
    }

    console.log(`[enrichment] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} complete`)
  }

  return { results: allResults, modelsUsed }
}
