// Pipeline stage: unmatched concepts -> new atoms
// Wraps the indexing agent

import { createGrimoireHandle } from '@shared/grimoire/handle'
import { runIndexingAgent } from './agents/indexing'
import type { AgentContext, KeyConcept as AgentKeyConcept } from './agents/types'
import type { ChunkResult } from '@shared/rpc/pipeline-types'

interface IndexEnv {
  GRIMOIRE_DB: D1Database
}

export interface IndexStageResult {
  atomsCreated: string[]
  vocabularyMap: Map<string, string>
  modelUsed: string
  stepStatus: string
}

export async function indexConcepts(
  env: IndexEnv,
  agentCtx: AgentContext,
  unmatched: AgentKeyConcept[],
  matched: { term: string; atomId: string }[],
  collectionSlug: string,
  sourceUrl: string,
  sourceId: string,
  chunks: ChunkResult[],
  chunkIds: string[],
): Promise<IndexStageResult> {
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)

  // Build vocabulary map from matched terms
  const vocabularyMap = new Map<string, string>()
  for (const m of matched) {
    vocabularyMap.set(m.term.toLowerCase(), m.atomId)
  }

  let modelUsed = ''
  let stepStatus = 'skipped'

  if (unmatched.length > 0) {
    const [categories, arrangements] = await Promise.all([
      handle.categories(),
      handle.arrangements(),
    ])

    const categorySlugs = categories.map(c => ({ slug: c.slug }))
    const arrangementManifest = arrangements.map(a => ({ slug: a.slug, name: a.name }))

    const indexResult = await runIndexingAgent(
      agentCtx, unmatched, collectionSlug, sourceUrl,
      categorySlugs, arrangementManifest
    )

    modelUsed = indexResult.modelUsed
    stepStatus = `ok:${indexResult.result.created.length}`

    for (const entry of indexResult.result.created) {
      vocabularyMap.set(entry.term.toLowerCase(), entry.atomId)
    }
  }

  // Link all resolved atoms to source with chunk provenance
  for (const [termLower, atomId] of vocabularyMap) {
    const matchIdx = chunks.findIndex(c =>
      c.content.toLowerCase().includes(termLower)
    )
    const linkChunkId = matchIdx >= 0 ? chunkIds[matchIdx] : (chunkIds[0] ?? null)
    const linkContext = matchIdx >= 0 ? (chunks[matchIdx].section_heading ?? 'page-level') : 'page-level'
    try {
      await handle.sourceAtomLinkWithContext(
        sourceId, atomId, 0.7, 'pipeline-v2', linkContext, linkChunkId
      )
    } catch {
      // Ignore duplicate link errors
    }
  }

  const atomsCreated = [...vocabularyMap.values()].filter(
    id => !matched.some(m => m.atomId === id)
  )

  return {
    atomsCreated,
    vocabularyMap,
    modelUsed,
    stepStatus,
  }
}
