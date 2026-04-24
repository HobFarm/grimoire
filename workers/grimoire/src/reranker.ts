/**
 * BGE Reranker integration for semantic re-scoring.
 *
 * Cross-encoder reranking is more accurate than bi-encoder (Vectorize) similarity
 * for relevance scoring against a specific query/intent. Used as an optional
 * refinement pass in invoke() when intent is provided.
 */

const RERANKER_MODEL = '@cf/baai/bge-reranker-base' as const

export interface RerankCandidate {
  id: string
  text: string
}

/**
 * Re-score candidates against a query using the BGE reranker cross-encoder.
 * Returns a Map of candidate id -> normalized score (0-1).
 * On failure, returns null so callers can fall back to existing scoring.
 */
export async function rerankCandidates(
  ai: Ai,
  query: string,
  candidates: RerankCandidate[],
): Promise<Map<string, number> | null> {
  if (candidates.length === 0) return null

  try {
    const response = await ai.run(RERANKER_MODEL, {
      query,
      contexts: candidates.map(c => ({ text: c.text })),
    })

    // Response is an array of { score: number } in same order as contexts
    const scores = response as Array<{ score: number }>
    if (!Array.isArray(scores) || scores.length !== candidates.length) return null

    // Normalize scores to 0-1 range via sigmoid (reranker outputs raw logits)
    const scoreMap = new Map<string, number>()
    for (let i = 0; i < candidates.length; i++) {
      const raw = scores[i].score
      const normalized = 1 / (1 + Math.exp(-raw))
      scoreMap.set(candidates[i].id, normalized)
    }
    return scoreMap
  } catch (e) {
    console.error('[reranker] Failed:', e)
    return null
  }
}
