// Indexing Agent: create new vocabulary entries for unmatched concepts
// Model: Qwen3-30b (Workers AI), fallback to Gemini Flash
// Runs ONLY when vocabulary-match produces unmatched concepts
// Batches concepts in groups of 15 to stay within model output limits

import type { AgentContext, KeyConcept, IndexingResult } from './types'
import { callWithJsonParse } from './types'
import { buildIndexingPrompt, buildIndexingUserMessage } from '../../prompts/pipeline-indexing'
import { ingestAtom } from '@shared/grimoire/ingest'

interface RawIndexingEntry {
  term: string
  category_slug: string
  collection_slug: string
  observation: string
  modality: string
  arrangement_slugs: string[]
  harmonic_hints: Record<string, number>
}

const BATCH_SIZE = 15

/**
 * Run the indexing agent on unmatched concepts.
 * Classifies each concept into the vocabulary taxonomy, then creates atoms via ingestAtom().
 * Batches concepts in groups of 15 to avoid model output truncation.
 */
export async function runIndexingAgent(
  ctx: AgentContext,
  unmatched: KeyConcept[],
  collectionSlug: string,
  sourceUrl: string,
  categories: { slug: string }[],
  arrangements: { slug: string; name: string }[],
): Promise<{ result: IndexingResult; modelUsed: string }> {
  if (unmatched.length === 0) {
    return { result: { created: [], failed: [] }, modelUsed: 'skipped' }
  }

  const systemPrompt = buildIndexingPrompt(categories, arrangements)
  const validCategorySlugs = new Set(categories.map(c => c.slug))
  const allEntries: RawIndexingEntry[] = []
  let lastModelUsed = ''

  // Batch concepts to stay within model output capacity
  for (let i = 0; i < unmatched.length; i += BATCH_SIZE) {
    const batch = unmatched.slice(i, i + BATCH_SIZE)
    const userMessage = buildIndexingUserMessage(
      batch.map(c => ({
        term: c.term,
        categoryHint: c.category_hint,
        isProperNoun: c.is_proper_noun,
      }))
    )

    try {
      const { result: aiResult, modelUsed } = await callWithJsonParse<{
        entries: RawIndexingEntry[]
      }>(
        'pipeline.indexing',
        systemPrompt,
        userMessage,
        ctx.ai,
        ctx.geminiKey,
      )
      lastModelUsed = modelUsed
      if (aiResult.entries) {
        allEntries.push(...aiResult.entries)
      }
    } catch (err) {
      console.warn(`[indexing] batch ${i}-${i + batch.length} failed: ${err instanceof Error ? err.message : err}`)
      // Continue with remaining batches
    }
  }

  const created: { term: string; atomId: string }[] = []
  const failed: { term: string; reason: string }[] = []

  for (const entry of allEntries) {
    if (!entry.term || typeof entry.term !== 'string') continue

    // Validate category slug, fall back to hint or null
    let categorySlug = validCategorySlugs.has(entry.category_slug)
      ? entry.category_slug
      : null
    if (!categorySlug) {
      const original = unmatched.find(c => c.term.toLowerCase() === entry.term.toLowerCase())
      if (original?.category_hint && validCategorySlugs.has(original.category_hint)) {
        categorySlug = original.category_hint
      }
    }

    try {
      const result = await ingestAtom(ctx.db, {
        text: entry.term.trim(),
        collection_slug: entry.collection_slug || collectionSlug,
        category_slug: categorySlug ?? undefined,
        source: 'ai',
        source_app: 'knowledge-ingest-v2',
        observation: (entry.observation === 'observation' || entry.observation === 'interpretation' ? entry.observation : 'observation') as 'observation' | 'interpretation',
        confidence: 0.6,
        modality: (entry.modality === 'visual' || entry.modality === 'both' ? entry.modality : 'visual') as 'visual' | 'both',
        metadata: { source_url: sourceUrl, pipeline: 'agent-v2' },
      })

      if (result.atom) {
        created.push({ term: entry.term, atomId: result.atom.id })
      } else {
        // Duplicate detected by ingestAtom: look up existing
        const existing = await ctx.handle.lookup(entry.term)
        if (existing) {
          created.push({ term: entry.term, atomId: existing.id })
        } else {
          failed.push({ term: entry.term, reason: 'ingestAtom returned no atom and lookup failed' })
        }
      }
    } catch (err) {
      failed.push({ term: entry.term, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  // Handle concepts that the AI didn't return entries for
  const processedTerms = new Set(allEntries.map(e => e.term?.toLowerCase()).filter(Boolean))
  for (const concept of unmatched) {
    if (processedTerms.has(concept.term.toLowerCase())) continue

    try {
      const result = await ingestAtom(ctx.db, {
        text: concept.term.trim(),
        collection_slug: collectionSlug,
        category_slug: concept.category_hint && validCategorySlugs.has(concept.category_hint)
          ? concept.category_hint : undefined,
        source: 'ai',
        source_app: 'knowledge-ingest-v2',
        observation: 'observation',
        confidence: 0.5,
        metadata: { source_url: sourceUrl, pipeline: 'agent-v2', note: 'ai-missed-classification' },
      })

      if (result.atom) {
        created.push({ term: concept.term, atomId: result.atom.id })
      } else {
        const existing = await ctx.handle.lookup(concept.term)
        if (existing) created.push({ term: concept.term, atomId: existing.id })
      }
    } catch (err) {
      failed.push({ term: concept.term, reason: `fallback: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  console.log(`[indexing] created=${created.length} failed=${failed.length} batches=${Math.ceil(unmatched.length / BATCH_SIZE)}`)

  return { result: { created, failed }, modelUsed: lastModelUsed }
}
