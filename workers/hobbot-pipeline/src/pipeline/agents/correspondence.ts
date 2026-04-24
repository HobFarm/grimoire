// Correspondence Agent: identify meaningful relations between concepts
// Model: Granite (Workers AI), fallback to Gemini Flash
// Replaces: cartesian cross-category co_occurs pairing and rigid derives_from

import type { AgentContext, EnrichedChunkResult, CorrespondenceResult } from './types'
import { callWithJsonParse } from '@shared/providers/call-with-json-parse'
import { MODELS } from '@shared/models'
import { buildCorrespondencePrompt, buildCorrespondenceUserMessage } from '../../prompts/pipeline-correspondence'
import type { AtomRelationType } from '@shared/grimoire/types'

const VALID_RELATION_TYPES = new Set<string>([
  'co_occurs', 'derives_from', 'influenced_by', 'compositional',
  'hierarchical', 'oppositional', 'modifies', 'narrower_than',
])

interface RawRelation {
  source_term: string
  target_term: string
  relation_type: string
  strength: number
  reasoning: string
}

/**
 * Run the correspondence agent to identify relations between resolved vocabulary entries.
 * Processes chunks in groups of 3-5 for cross-chunk context.
 */
export async function runCorrespondenceAgent(
  ctx: AgentContext,
  enrichedChunks: EnrichedChunkResult[],
  vocabularyMap: Map<string, string>, // term (lowercase) -> atomId
): Promise<{ result: CorrespondenceResult; modelUsed: string | null }> {
  if (enrichedChunks.length === 0 || vocabularyMap.size < 2) {
    return { result: { relationsCreated: [], errors: 0 }, modelUsed: null }
  }

  const systemPrompt = buildCorrespondencePrompt()
  const allTerms = [...vocabularyMap.keys()]
  const relationsCreated: string[] = []
  let errors = 0
  let modelUsed: string | null = null

  // Process in groups of 3-5 chunks
  const GROUP_SIZE = 4
  for (let i = 0; i < enrichedChunks.length; i += GROUP_SIZE) {
    const group = enrichedChunks.slice(i, i + GROUP_SIZE)

    const chunkData = group.map(chunk => ({
      heading: chunk.chunkId, // will be replaced with actual heading from metadata
      summary: chunk.summary,
      concepts: chunk.keyConcepts
        .filter(kc => vocabularyMap.has(kc.term.toLowerCase()))
        .map(kc => kc.term),
    }))

    // Skip groups where fewer than 2 resolved concepts exist
    const totalConcepts = chunkData.reduce((sum, c) => sum + c.concepts.length, 0)
    if (totalConcepts < 2) continue

    try {
      const userMessage = buildCorrespondenceUserMessage(chunkData, allTerms)
      const { result: aiResult, modelUsed: model } = await callWithJsonParse<{
        relations: RawRelation[]
      }>(
        'pipeline.correspondence',
        systemPrompt,
        userMessage,
        ctx.ai,
        ctx.geminiKey,
        MODELS['pipeline.correspondence'],
        { onUsage: ctx.onUsage },
      )

      modelUsed = model
      const relations = aiResult.relations ?? []

      for (const rel of relations) {
        if (!rel.source_term || !rel.target_term) continue
        if (!VALID_RELATION_TYPES.has(rel.relation_type)) continue

        const sourceAtomId = vocabularyMap.get(rel.source_term.toLowerCase())
        const targetAtomId = vocabularyMap.get(rel.target_term.toLowerCase())
        if (!sourceAtomId || !targetAtomId || sourceAtomId === targetAtomId) continue

        try {
          const result = await ctx.handle.addRelation({
            source_atom_id: sourceAtomId,
            target_atom_id: targetAtomId,
            relation_type: rel.relation_type as AtomRelationType,
            strength: Math.max(0, Math.min(1, rel.strength ?? 0.5)),
            context: rel.reasoning?.slice(0, 200) ?? 'pipeline-correspondence',
            source: 'inferred',
            confidence: 0.7,
          })
          relationsCreated.push(result.id)
        } catch (err) {
          errors++
          console.warn(`[correspondence] relation failed: ${rel.source_term} -> ${rel.target_term}: ${err instanceof Error ? err.message : err}`)
        }
      }
    } catch (err) {
      errors++
      console.warn(`[correspondence] group ${Math.floor(i / GROUP_SIZE) + 1} failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`[correspondence] relations=${relationsCreated.length} errors=${errors}`)

  return { result: { relationsCreated, errors }, modelUsed }
}
