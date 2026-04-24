// Pipeline stage: KeyConcept[] -> vocabulary matching
// Wraps the vocabulary-match agent

import { runVocabularyMatchAgent } from './agents/vocabulary-match'
import type { AgentContext, KeyConcept as AgentKeyConcept } from './agents/types'

interface MatchEnv {
  GRIMOIRE_DB: D1Database
  AI: Ai
  GRIMOIRE: Fetcher
}

export interface MatchStageResult {
  matched: { term: string; atomId: string; confidence: number }[]
  unmatched: AgentKeyConcept[]
  modelUsed: string | null
  stepStatus: string
}

export async function match(
  env: MatchEnv,
  concepts: AgentKeyConcept[],
  agentCtx: AgentContext,
): Promise<MatchStageResult> {
  if (concepts.length === 0) {
    return { matched: [], unmatched: [], modelUsed: null, stepStatus: 'skipped:no_concepts' }
  }

  const matchResult = await runVocabularyMatchAgent(agentCtx, concepts)

  console.log(`[pipeline:match] matched=${matchResult.result.matched.length} unmatched=${matchResult.result.unmatched.length}`)

  return {
    matched: matchResult.result.matched,
    unmatched: matchResult.result.unmatched,
    modelUsed: matchResult.modelUsed,
    stepStatus: `ok:${matchResult.result.matched.length}/${matchResult.result.matched.length + matchResult.result.unmatched.length}`,
  }
}
