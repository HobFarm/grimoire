// Pipeline stage: ChunkResult[] -> KeyConcept[]
// Wraps the enrichment agent for per-chunk concept extraction

import { createGrimoireHandle } from '@shared/grimoire/handle'
import { resolveApiKey } from '@shared/providers'
import { runEnrichmentAgent } from './agents/enrichment'
import type { AgentContext } from './agents/types'
import type { ChunkResult } from '@shared/rpc/pipeline-types'
import type { Arrangement } from '@shared/grimoire/types'

interface ExtractEnv {
  GRIMOIRE_DB: D1Database
  AI: Ai
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  GRIMOIRE: Fetcher
}

export interface ExtractResult {
  enrichedResults: {
    chunkId: string
    summary: string
    categorySlug: string | null
    arrangementSlugs: string[]
    qualityScore: number
    keyConcepts: { term: string; category_hint: string | null; is_proper_noun: boolean }[]
  }[]
  allConcepts: { term: string; category_hint: string | null; is_proper_noun: boolean }[]
  modelsUsed: string[]
  stepStatus: string
}

export async function extract(
  env: ExtractEnv,
  chunks: ChunkResult[],
  documentTitle: string,
  sourceType: 'aesthetic' | 'domain',
): Promise<ExtractResult> {
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)
  const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)

  const agentCtx: AgentContext = {
    db: env.GRIMOIRE_DB,
    ai: env.AI,
    geminiKey,
    handle,
    grimoire: env.GRIMOIRE,
  }

  const [categories, arrangements] = await Promise.all([
    handle.categories(),
    handle.arrangements(),
  ])

  const categorySlugs = categories.map(c => ({ slug: c.slug }))
  const arrangementManifest = arrangements.map(a => ({ slug: a.slug, name: a.name }))

  const chunkInputs = chunks.map(c => ({
    id: c.chunk_id,
    content: c.content,
    heading: c.section_heading ?? '',
  }))

  const enrichResult = await runEnrichmentAgent(
    agentCtx, chunkInputs, documentTitle, categorySlugs, arrangementManifest
  )

  const allConcepts = enrichResult.results.flatMap(r => r.keyConcepts)

  console.log(`[pipeline:extract] chunks=${enrichResult.results.length} concepts=${allConcepts.length}`)

  return {
    enrichedResults: enrichResult.results,
    allConcepts,
    modelsUsed: enrichResult.modelsUsed,
    stepStatus: `ok:${enrichResult.results.length}:${enrichResult.modelsUsed[0] ?? 'unknown'}`,
  }
}

// Re-export for use in run.ts arrangement aggregation
export function aggregateArrangements(
  enrichedResults: { arrangementSlugs: string[]; qualityScore: number }[],
  allArrangements: Arrangement[],
): { matches: { slug: string; confidence: number; reasoning: string }[]; harmonicProfile: Record<string, number> } {
  const slugWeights = new Map<string, number>()
  for (const chunk of enrichedResults) {
    for (const slug of chunk.arrangementSlugs) {
      slugWeights.set(slug, (slugWeights.get(slug) ?? 0) + chunk.qualityScore)
    }
  }

  const totalWeight = enrichedResults.reduce((sum, c) => sum + c.qualityScore, 0) || 1
  const matches = [...slugWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([slug, weight]) => ({
      slug,
      confidence: +(weight / totalWeight).toFixed(3),
      reasoning: 'chunk_enrichment_aggregate',
    }))

  const harmonicProfile: Record<string, number> = {
    hardness: 0.5, temperature: 0.5, weight: 0.5, formality: 0.5, era_affinity: 0.5,
  }

  if (matches.length > 0) {
    const dims = ['hardness', 'temperature', 'weight', 'formality', 'era_affinity']
    const sums: Record<string, number> = {}
    let count = 0

    for (const m of matches) {
      const arr = allArrangements.find(a => a.slug === m.slug)
      if (!arr?.harmonics) continue
      const h = typeof arr.harmonics === 'string'
        ? JSON.parse(arr.harmonics as string) as Record<string, number>
        : arr.harmonics as Record<string, number>
      for (const d of dims) {
        sums[d] = (sums[d] ?? 0) + (h[d] ?? 0.5)
      }
      count++
    }

    if (count > 0) {
      for (const d of dims) {
        harmonicProfile[d] = +((sums[d] ?? 0.5 * count) / count).toFixed(3)
      }
    }
  }

  return { matches, harmonicProfile }
}
