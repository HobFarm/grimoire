// Pipeline stage: build relations (co_occurs, derives_from, correspondences)
// Wraps the correspondence agent

import { createGrimoireHandle } from '@shared/grimoire/handle'
import { runCorrespondenceAgent } from './agents/correspondence'
import type { AgentContext } from './agents/types'
import type { ExtractResult } from './extract'

interface RelateEnv {
  GRIMOIRE_DB: D1Database
}

export interface RelateStageResult {
  relationsCreated: string[]
  modelUsed: string | null
  stepStatus: string
}

export async function relate(
  env: RelateEnv,
  agentCtx: AgentContext,
  enrichedResults: ExtractResult['enrichedResults'],
  vocabularyMap: Map<string, string>,
): Promise<RelateStageResult> {
  try {
    const corrResult = await runCorrespondenceAgent(
      agentCtx, enrichedResults, vocabularyMap
    )

    console.log(`[pipeline:relate] relations=${corrResult.result.relationsCreated.length}`)

    return {
      relationsCreated: corrResult.result.relationsCreated,
      modelUsed: corrResult.modelUsed,
      stepStatus: `ok:${corrResult.result.relationsCreated.length}`,
    }
  } catch (err) {
    console.warn(`[pipeline:relate] failed: ${(err as Error).message}`)
    return {
      relationsCreated: [],
      modelUsed: null,
      stepStatus: `failed:${(err as Error).message}`,
    }
  }
}
