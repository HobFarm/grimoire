/**
 * Durable Workflows for bulk operations
 *
 * BulkRetagWorkflow: Score 154K+ atoms against all arrangements with durable checkpointing.
 * BulkCorrespondencesWorkflow: Full correspondence rebuild with Vectorize queries.
 *
 * Both use cursor-based pagination on rowid for stable ordering and crash-safe resume.
 * Both support dryRun mode: process and log without writing to D1.
 */

import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { Env, BulkRetagParams, BulkCorrespondenceParams } from './types'
import { scoreAtom, loadArrangements, safeParseJSON, dualWriteArrangementTags, type HarmonicProfile } from './arrangement-tagger'
import { discoverSemanticBatch } from './correspondence'

// --- Bulk Re-Tag Workflow ---

export class BulkRetagWorkflow extends WorkflowEntrypoint<Env, BulkRetagParams> {
  async run(
    event: { payload: Readonly<BulkRetagParams>; timestamp: Date; instanceId: string },
    step: InstanceType<typeof import('cloudflare:workers').WorkflowStep>
  ) {
    const batchSize = event.payload.batchSize ?? 500
    const dryRun = event.payload.dryRun ?? false
    let afterRowid = event.payload.afterRowid ?? 0

    // Step 1: Load arrangements (cached for the entire workflow)
    const { arrangements, currentVersion } = await step.do('load-arrangements', async () => {
      return await loadArrangements(this.env.DB)
    })

    if (arrangements.length === 0) {
      return { processed: 0, message: 'No arrangements found' }
    }

    // Step 2: Count total atoms to process
    const totalCount = await step.do('count-atoms', async () => {
      const res = await this.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM atoms WHERE harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tag_version < ? AND status != 'rejected'"
      ).bind(currentVersion).first<{ cnt: number }>()
      return res?.cnt ?? 0
    })

    if (totalCount === 0) {
      return { processed: 0, message: 'All atoms already at current tag version' }
    }

    // Steps 3-N: Process in batches using rowid cursor
    let totalProcessed = 0
    let batchIndex = 0

    while (true) {
      const batchResult = await step.do(`retag-batch-${batchIndex}`, {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      }, async () => {
        const { results: atoms } = await this.env.DB.prepare(
          "SELECT rowid, id, text_lower, harmonics, register FROM atoms WHERE rowid > ? AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tag_version < ? AND status != 'rejected' ORDER BY rowid LIMIT ?"
        ).bind(afterRowid, currentVersion, batchSize).all<{ rowid: number; id: string; text_lower: string; harmonics: string; register: number | null }>()

        if (atoms.length === 0) {
          return { processed: 0, lastRowid: afterRowid, done: true }
        }

        const updates: { id: string; newTags: string }[] = []
        for (const atom of atoms) {
          const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
          harmonics.register = atom.register ?? 0.5

          if (typeof harmonics.hardness !== 'number') {
            updates.push({ id: atom.id, newTags: JSON.stringify([{ slug: 'unaffiliated', dist: 0 }]) })
            continue
          }

          const topMatches = scoreAtom(harmonics, arrangements, atom.text_lower)
          const tagsStr = JSON.stringify(topMatches.length > 0 ? topMatches : [{ slug: 'unaffiliated', dist: 0 }])
          updates.push({ id: atom.id, newTags: tagsStr })
        }

        if (!dryRun) {
          await dualWriteArrangementTags(this.env.DB, updates, currentVersion)
        }

        const lastRowid = atoms[atoms.length - 1].rowid
        return { processed: atoms.length, lastRowid, done: atoms.length < batchSize }
      })

      totalProcessed += batchResult.processed
      afterRowid = batchResult.lastRowid

      if (batchResult.done) break

      batchIndex++
      await step.sleep(`rate-limit-${batchIndex}`, '1 second')
    }

    return {
      totalProcessed,
      currentVersion,
      dryRun,
      message: dryRun ? 'Dry run complete, no writes performed' : 'Bulk re-tag complete',
    }
  }
}

// --- Bulk Correspondences Workflow ---

export class BulkCorrespondencesWorkflow extends WorkflowEntrypoint<Env, BulkCorrespondenceParams> {
  async run(
    event: { payload: Readonly<BulkCorrespondenceParams>; timestamp: Date; instanceId: string },
    step: InstanceType<typeof import('cloudflare:workers').WorkflowStep>
  ) {
    const batchSize = event.payload.batchSize ?? 10
    const dryRun = event.payload.dryRun ?? false
    let afterRowid = event.payload.afterRowid ?? 0

    // Step 1: Count total atoms with embeddings
    const totalCount = await step.do('count-atoms', async () => {
      const res = await this.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM atoms WHERE embedding_status = 'complete' AND category_slug IS NOT NULL"
      ).first<{ cnt: number }>()
      return res?.cnt ?? 0
    })

    if (totalCount === 0) {
      return { processed: 0, inserted: 0, message: 'No embedded atoms found' }
    }

    let totalProcessed = 0
    let totalInserted = 0
    let batchIndex = 0

    while (true) {
      const batchResult = await step.do(`correspondences-batch-${batchIndex}`, {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '5 minutes',
      }, async () => {
        const { results: atoms } = await this.env.DB.prepare(
          "SELECT rowid, id, text_lower, category_slug FROM atoms WHERE rowid > ? AND embedding_status = 'complete' AND category_slug IS NOT NULL ORDER BY rowid LIMIT ?"
        ).bind(afterRowid, batchSize).all<{ rowid: number; id: string; text_lower: string; category_slug: string }>()

        if (atoms.length === 0) {
          return { processed: 0, inserted: 0, lastRowid: afterRowid, done: true }
        }

        let inserted = 0
        if (!dryRun) {
          const result = await discoverSemanticBatch(this.env.DB, this.env.VECTORIZE, atoms)
          inserted = result.inserted
        }

        const lastRowid = atoms[atoms.length - 1].rowid
        return { processed: atoms.length, inserted, lastRowid, done: atoms.length < batchSize }
      })

      totalProcessed += batchResult.processed
      totalInserted += batchResult.inserted
      afterRowid = batchResult.lastRowid

      if (batchResult.done) break

      batchIndex++
      await step.sleep(`rate-limit-${batchIndex}`, '2 seconds')
    }

    return {
      totalProcessed,
      totalInserted,
      dryRun,
      message: dryRun ? 'Dry run complete, no writes performed' : 'Bulk correspondence rebuild complete',
    }
  }
}
