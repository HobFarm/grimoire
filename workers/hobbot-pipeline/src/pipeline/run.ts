// Pipeline orchestrator: calls stages in sequence
// Owns ingest_log final update: sets status='complete' or 'failed' with counts

import { createGrimoireHandle } from '@shared/grimoire/handle'
import { resolveApiKey } from '@shared/providers'
import { createTokenLogger } from '@shared/providers'
import { logAction } from '@shared/ledger'
import type { NormalizedDocument, PipelineResult } from '@shared/rpc/pipeline-types'
import type { AgentContext } from './agents/types'
import { chunk } from './chunk'
import { extract, aggregateArrangements } from './extract'
import { match } from './match'
import { indexConcepts } from './index'
import { relate } from './relate'
import { enqueueVectorize } from './vectorize'

interface PipelineEnv {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  GRIMOIRE: Fetcher
  AI: Ai
  GEMINI_API_KEY: string | { get: () => Promise<string> }
}

export interface RunOptions {
  dry_run?: boolean
  logId?: string
  sourceId?: string
  documentId?: string
}

export async function runKnowledgePipeline(
  env: PipelineEnv,
  doc: NormalizedDocument,
  options: RunOptions = {},
): Promise<PipelineResult> {
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)
  const dryRun = options.dry_run ?? false
  const sourceId = options.sourceId ?? crypto.randomUUID()
  const documentId = options.documentId ?? crypto.randomUUID()
  const logId = options.logId
  const collectionSlug = doc.provenance.collection_slug ?? 'uncategorized'

  const stepStatus: Record<string, string> = {}
  const errors: string[] = []
  let atomsCreated = 0
  let atomsMatched = 0
  let relationsCreated = 0

  try {
    // 1. Chunk: create source + document + chunks in DB
    stepStatus.fetch = 'ok'
    const chunks = await chunk(env, doc, sourceId, documentId, dryRun)
    stepStatus.source = dryRun ? 'skipped:dry_run' : 'ok'
    stepStatus.document = dryRun ? 'skipped:dry_run' : 'ok'
    stepStatus.chunks = `ok:${chunks.length}`

    if (chunks.length === 0) {
      const result: PipelineResult = {
        document_id: documentId,
        source_id: sourceId,
        chunks_created: 0,
        concepts_extracted: 0,
        atoms_matched: 0,
        atoms_created: 0,
        relations_created: 0,
        step_status: { ...stepStatus, error: 'no valid chunks after quality filter' },
        errors: ['no valid chunks after quality filter'],
        dry_run: dryRun,
      }
      if (logId && !dryRun) {
        await handle.ingestLogUpdate(logId, {
          status: 'complete',
          atoms_created: 0,
          atoms_skipped: 0,
          relations_created: 0,
          completed_at: new Date().toISOString(),
          source_id: sourceId,
          document_id: documentId,
          chunks_created: 0,
          step_status: stepStatus,
        })
      }
      return result
    }

    console.log(`[pipeline:run] chunks=${chunks.length} for "${doc.title}"`)

    if (dryRun) {
      stepStatus.enrichment = 'skipped:dry_run'
      stepStatus.vocabulary_match = 'skipped:dry_run'
      stepStatus.indexing = 'skipped:dry_run'
      stepStatus.correspondence = 'skipped:dry_run'
      stepStatus.embedding = 'skipped:dry_run'

      return {
        document_id: documentId,
        source_id: sourceId,
        chunks_created: chunks.length,
        concepts_extracted: 0,
        atoms_matched: 0,
        atoms_created: 0,
        relations_created: 0,
        step_status: stepStatus,
        errors,
        dry_run: true,
      }
    }

    // Build agent context
    const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)
    const agentCtx: AgentContext = {
      db: env.GRIMOIRE_DB,
      ai: env.AI,
      geminiKey,
      handle,
      grimoire: env.GRIMOIRE,
      onUsage: createTokenLogger(env.HOBBOT_DB, 'hobbot-pipeline'),
    }

    // 2. Extract: per-chunk enrichment + concept extraction
    let extractResult: Awaited<ReturnType<typeof extract>> | null = null
    try {
      extractResult = await extract(env, chunks, doc.title, doc.source_type)
      stepStatus.enrichment = extractResult.stepStatus

      // 3. Match: vocabulary matching
      try {
        const matchResult = await match(env, extractResult.allConcepts, agentCtx)
        stepStatus.vocabulary_match = matchResult.stepStatus
        atomsMatched = matchResult.matched.length

        // 4. Index: create atoms for unmatched concepts
        try {
          const indexResult = await indexConcepts(
            env, agentCtx, matchResult.unmatched, matchResult.matched,
            collectionSlug, doc.source_url ?? `adapter:${doc.provenance.adapter}`,
            sourceId, chunks, chunks.map(c => c.chunk_id),
          )
          stepStatus.indexing = indexResult.stepStatus
          atomsCreated = indexResult.atomsCreated.length

          // 5. Relate: build correspondences
          try {
            const relateResult = await relate(env, agentCtx, extractResult.enrichedResults, indexResult.vocabularyMap)
            stepStatus.correspondence = relateResult.stepStatus
            relationsCreated = relateResult.relationsCreated.length
          } catch (corrErr) {
            stepStatus.correspondence = `failed:${(corrErr as Error).message}`
            errors.push(`correspondence: ${(corrErr as Error).message}`)
          }
        } catch (indexErr) {
          stepStatus.indexing = `failed:${(indexErr as Error).message}`
          errors.push(`indexing: ${(indexErr as Error).message}`)
        }
      } catch (matchErr) {
        stepStatus.vocabulary_match = `failed:${(matchErr as Error).message}`
        errors.push(`vocabulary_match: ${(matchErr as Error).message}`)
      }

      // Arrangement aggregation from enrichment results
      try {
        const arrangements = await handle.arrangements()
        const { matches: arrMatches, harmonicProfile } = aggregateArrangements(
          extractResult.enrichedResults, arrangements
        )
        await handle.sourceUpdateExtraction(sourceId, {
          arrangement_matches: arrMatches,
          harmonic_profile: harmonicProfile as unknown as Record<string, string>,
          atom_count: atomsCreated + atomsMatched,
          status: 'complete',
          extraction_model: extractResult.modelsUsed[0] ?? 'pipeline-v2',
          extraction_prompt_version: 'v2',
        })
        stepStatus.arrangements = `ok:${arrMatches.length}`
      } catch (arrErr) {
        stepStatus.arrangements = `failed:${(arrErr as Error).message}`
        errors.push(`arrangements: ${(arrErr as Error).message}`)
        await handle.sourceUpdateExtraction(sourceId, {
          atom_count: atomsCreated + atomsMatched,
          status: 'complete',
        }).catch(() => {})
      }
    } catch (enrichErr) {
      stepStatus.enrichment = `failed:${(enrichErr as Error).message}`
      errors.push(`enrichment: ${(enrichErr as Error).message}`)
      await handle.sourceUpdateExtraction(sourceId, {
        atom_count: 0,
        status: 'complete',
      }).catch(() => {})
    }

    // 6. Vectorize: enqueue chunks for embedding
    try {
      const embedStatus = await enqueueVectorize(env, chunks.map(c => c.chunk_id))
      stepStatus.embedding = embedStatus
    } catch (embedErr) {
      stepStatus.embedding = `failed:${(embedErr as Error).message}`
    }

    // Update ingest_log
    const hasFailed = errors.length > 0
    const finalStatus = hasFailed ? 'failed' as const : 'complete' as const

    if (logId) {
      await handle.ingestLogUpdate(logId, {
        status: finalStatus,
        atoms_created: atomsCreated,
        atoms_skipped: atomsMatched,
        relations_created: relationsCreated,
        extraction_json: {
          chunksProcessed: chunks.length,
          conceptsExtracted: extractResult?.allConcepts.length ?? 0,
          vocabularyMatched: atomsMatched,
          vocabularyCreated: atomsCreated,
          relationsCreated,
          modelsUsed: extractResult?.modelsUsed ?? [],
        } as unknown as Record<string, unknown>,
        completed_at: new Date().toISOString(),
        source_id: sourceId,
        document_id: documentId,
        chunks_created: chunks.length,
        step_status: stepStatus,
        error_message: hasFailed ? `Partial: ${errors.join(', ')}` : null,
      })
    }

    // Ledger: log successful ingestion
    try {
      await logAction(env.HOBBOT_DB, {
        action_type: 'ingested',
        topic_key: doc.source_url ?? doc.title,
        payload: {
          atoms_created: atomsCreated,
          atoms_skipped: atomsMatched,
          relations_created: relationsCreated,
          chunks: chunks.length,
          source_type: doc.source_type,
          pipeline: 'pipeline-v3',
          adapter: doc.provenance.adapter,
        },
        source_ids: [sourceId],
        status: 'complete',
        completed_at: new Date().toISOString(),
      })
    } catch (e) {
      console.warn(`[pipeline:run] ledger failed: ${e instanceof Error ? e.message : e}`)
    }

    const matchRatio = extractResult
      ? `${atomsMatched} matched / ${atomsCreated} new out of ${extractResult.allConcepts.length} concepts`
      : 'n/a'
    console.log(`[pipeline:run] done url=${doc.source_url ?? 'text'} ${matchRatio} relations=${relationsCreated} chunks=${chunks.length}`)

    return {
      document_id: documentId,
      source_id: sourceId,
      chunks_created: chunks.length,
      concepts_extracted: extractResult?.allConcepts.length ?? 0,
      atoms_matched: atomsMatched,
      atoms_created: atomsCreated,
      relations_created: relationsCreated,
      step_status: stepStatus,
      errors,
      dry_run: false,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[pipeline:run] error: ${errorMsg}`)

    await handle.sourceUpdateStatus(sourceId, 'failed').catch(() => {})
    if (logId) {
      await handle.ingestLogUpdate(logId, {
        status: 'failed',
        error_message: errorMsg,
        completed_at: new Date().toISOString(),
        source_id: sourceId,
        document_id: documentId,
      })
    }

    throw error
  }
}
