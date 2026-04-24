// Cron handler: scan D1 for unprocessed atoms and dispatch to queues.
// Runs every 15 minutes. Six phases, each with a 30-minute re-enqueue guard.
// Each phase logs to execution_log for observability and staleness detection.

import type { Env, ConnectivityStats } from './types'
import { validateTaxonomyMaps } from './taxonomy'
import { generateDailyReview } from './daily-review'
import {
  BATCH_SIZE as CONNECTIVITY_BATCH_SIZE,
  dequeueConnectivityBatch,
  enqueueForConnectivityBatch,
  getSweepBatch,
  getWatermark,
  setWatermark,
  logConnectivityStats,
  processConnectivityBatch,
  recordFailedBatch,
} from './connectivity'
import { createLogger } from '@shared/logger'

const log = createLogger('grimoire')

const ENQUEUE_GUARD_MINUTES = 30

async function logExecution(
  db: D1Database, phase: string, startTime: number,
  items: number, errorCount: number, metadata?: Record<string, unknown>,
) {
  try {
    await db.prepare(
      `INSERT INTO execution_log (worker, phase, started_at, completed_at, items_processed, errors, metadata_json, success)
       VALUES ('grimoire', ?, ?, datetime('now'), ?, ?, ?, ?)`
    ).bind(phase, new Date(startTime).toISOString(), items, errorCount, JSON.stringify(metadata ?? {}), errorCount === 0 ? 1 : 0).run()
  } catch {
    // Don't let logging failures break the cron
  }
}

export async function scanAndEnqueue(env: Env): Promise<void> {
  const cycleStart = Date.now()
  let totalEnqueued = 0

  await validateTaxonomyMaps(env.DB)

  // Phase 1: Unclassified atoms -> grimoire-classify
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      const { results } = await env.DB.prepare(
        `SELECT id FROM atoms WHERE (category_slug IS NULL OR category_slug = '')
         AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime('now', '-${ENQUEUE_GUARD_MINUTES} minutes'))
         LIMIT 200`
      ).all<{ id: string }>()

      if (results.length > 0) {
        for (let i = 0; i < results.length; i += 100) {
          const chunk = results.slice(i, i + 100)
          await env.CLASSIFY_QUEUE.sendBatch(chunk.map(r => ({ body: { type: 'classify' as const, atomId: r.id } })))
        }
        await env.DB.prepare(
          `UPDATE atoms SET last_enqueued_at = datetime('now') WHERE id IN (${results.map(() => '?').join(',')}) AND (category_slug IS NULL OR category_slug = '')`
        ).bind(...results.map(r => r.id)).run()
        count = results.length
        totalEnqueued += count
        log.info('Phase 1: enqueued for classification', { phase: 1, count })
      }
      await logExecution(env.DB, 'phase_1_classify', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 1 enqueue error', { phase: 1, error: String(error) })
      await logExecution(env.DB, 'phase_1_classify', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 2: Pending vectorization -> grimoire-vectorize
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      const { results } = await env.DB.prepare(
        `SELECT id FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL
         AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime('now', '-${ENQUEUE_GUARD_MINUTES} minutes'))
         LIMIT 100`
      ).all<{ id: string }>()

      if (results.length > 0) {
        await env.VECTORIZE_QUEUE.sendBatch(results.map(r => ({ body: { type: 'vectorize' as const, atomId: r.id } })))
        await env.DB.prepare(
          `UPDATE atoms SET last_enqueued_at = datetime('now') WHERE id IN (${results.map(() => '?').join(',')}) AND embedding_status = 'pending'`
        ).bind(...results.map(r => r.id)).run()
        count = results.length
        totalEnqueued += count
        log.info('Phase 2: enqueued for vectorization', { phase: 2, count })
      }
      await logExecution(env.DB, 'phase_2_vectorize', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 2 enqueue error', { phase: 2, error: String(error) })
      await logExecution(env.DB, 'phase_2_vectorize', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 2b: Pending chunk vectorization -> grimoire-vectorize
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      const { results } = await env.DB.prepare(
        `SELECT id FROM document_chunks WHERE embedding_status = 'pending' LIMIT 20`
      ).all<{ id: string }>()

      if (results.length > 0) {
        await env.VECTORIZE_QUEUE.sendBatch(
          results.map(r => ({ body: { type: 'vectorize-chunk' as const, chunkId: r.id } }))
        )
        count = results.length
        totalEnqueued += count
        log.info('Phase 2b: enqueued chunks for vectorization', { phase: '2b', count })
      }
      await logExecution(env.DB, 'phase_2b_vectorize_chunks', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 2b enqueue error', { phase: '2b', error: String(error) })
      await logExecution(env.DB, 'phase_2b_vectorize_chunks', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 3: Harmonics enrichment -> grimoire-classify
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      const { results } = await env.DB.prepare(
        `SELECT id FROM atoms WHERE category_slug IS NOT NULL
         AND (harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2)
         AND status != 'rejected'
         AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime('now', '-${ENQUEUE_GUARD_MINUTES} minutes'))
         LIMIT 10`
      ).all<{ id: string }>()

      if (results.length > 0) {
        await env.CLASSIFY_QUEUE.sendBatch(results.map(r => ({ body: { type: 'enrich-harmonics' as const, atomId: r.id } })))
        await env.DB.prepare(
          `UPDATE atoms SET last_enqueued_at = datetime('now') WHERE id IN (${results.map(() => '?').join(',')})`
        ).bind(...results.map(r => r.id)).run()
        count = results.length
        totalEnqueued += count
        log.info('Phase 3: enqueued for harmonics enrichment', { phase: 3, count })
      }
      await logExecution(env.DB, 'phase_3_harmonics', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 3 enqueue error', { phase: 3, error: String(error) })
      await logExecution(env.DB, 'phase_3_harmonics', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 4: Arrangement tagging -> grimoire-enrich
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      const { results: arrResults } = await env.DB.prepare(
        'SELECT COUNT(*) as cnt FROM arrangements'
      ).all<{ cnt: number }>()
      const arrangementCount = arrResults?.[0]?.cnt ?? 0
      const currentVersion = Math.max(30, arrangementCount)

      const { results } = await env.DB.prepare(
        `SELECT id FROM atoms WHERE category_slug IS NOT NULL
         AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2
         AND tag_version < ?
         AND status != 'rejected'
         AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime('now', '-${ENQUEUE_GUARD_MINUTES} minutes'))
         LIMIT 50`
      ).bind(currentVersion).all<{ id: string }>()

      if (results.length > 0) {
        await env.ENRICH_QUEUE.sendBatch(results.map(r => ({ body: { type: 'tag-arrangements' as const, atomId: r.id } })))
        await env.DB.prepare(
          `UPDATE atoms SET last_enqueued_at = datetime('now') WHERE id IN (${results.map(() => '?').join(',')})`
        ).bind(...results.map(r => r.id)).run()
        count = results.length
        totalEnqueued += count
        log.info('Phase 4: enqueued for arrangement tagging', { phase: 4, count })
      }
      await logExecution(env.DB, 'phase_4_tagging', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 4 enqueue error', { phase: 4, error: String(error) })
      await logExecution(env.DB, 'phase_4_tagging', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 5: Register classification -> grimoire-classify
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, category_slug FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL
         AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime('now', '-${ENQUEUE_GUARD_MINUTES} minutes'))
         LIMIT 50`
      ).all<{ id: string; category_slug: string }>()

      if (results.length > 0) {
        await env.CLASSIFY_QUEUE.sendBatch(results.map(r => ({
          body: { type: 'classify-register' as const, atomId: r.id, categorySlug: r.category_slug }
        })))
        await env.DB.prepare(
          `UPDATE atoms SET last_enqueued_at = datetime('now') WHERE id IN (${results.map(() => '?').join(',')})`
        ).bind(...results.map(r => r.id)).run()
        count = results.length
        totalEnqueued += count
        log.info('Phase 5: enqueued for register classification', { phase: 5, count })
      }
      await logExecution(env.DB, 'phase_5_register', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 5 enqueue error', { phase: 5, error: String(error) })
      await logExecution(env.DB, 'phase_5_register', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 6: Correspondence discovery -> grimoire-enrich
  {
    const phaseStart = Date.now()
    let count = 0
    try {
      // semantic_correspondence_count is maintained by triggers on correspondences
      // (migration 0030). Replaces two NOT EXISTS probes per outer row; partial
      // index idx_atoms_phase6_candidates makes this a bounded range scan.
      const { results } = await env.DB.prepare(
        `SELECT id FROM atoms
         WHERE semantic_correspondence_count = 0
           AND embedding_status = 'complete'
           AND category_slug IS NOT NULL
           AND (last_enqueued_at IS NULL OR last_enqueued_at < datetime('now', '-${ENQUEUE_GUARD_MINUTES} minutes'))
         ORDER BY id LIMIT 200`
      ).all<{ id: string }>()

      if (results.length > 0) {
        for (let i = 0; i < results.length; i += 100) {
          const chunk = results.slice(i, i + 100)
          await env.ENRICH_QUEUE.sendBatch(chunk.map(r => ({ body: { type: 'discover-correspondences' as const, atomId: r.id } })))
          await env.DB.prepare(
            `UPDATE atoms SET last_enqueued_at = datetime('now') WHERE id IN (${chunk.map(() => '?').join(',')})`
          ).bind(...chunk.map(r => r.id)).run()
        }
        count = results.length
        totalEnqueued += count
        log.info('Phase 6: enqueued for correspondence discovery', { phase: 6, count })
      }
      await logExecution(env.DB, 'phase_6_correspondences', phaseStart, count, 0)
    } catch (error) {
      log.error('Phase 6 enqueue error', { phase: 6, error: String(error) })
      await logExecution(env.DB, 'phase_6_correspondences', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Phase 8: Connectivity scoring (KV-queue dequeue-then-process; no Cloudflare Queue)
  // Event path: drain the KV queue populated by atom-confirmation hook points.
  //   On error: re-enqueue the batch so atoms retry next tick (not lost).
  // Sweep path: walk atoms by id watermark; skip-check inside processConnectivityBatch
  // avoids reprocessing already-connected atoms.
  //   On error: advance the watermark anyway (poison-atom protection) and log the
  //   failed atom ids to connectivity:failed:{date} for investigation.
  {
    const phaseStart = Date.now()
    let count = 0
    let stats: ConnectivityStats | null = null
    let phaseError: string | null = null
    try {
      if (!env.CONNECTIVITY_KV) {
        throw new Error('CONNECTIVITY_KV binding missing')
      }
      const eventBatch = await dequeueConnectivityBatch(env.CONNECTIVITY_KV, CONNECTIVITY_BATCH_SIZE)
      if (eventBatch.length > 0) {
        try {
          stats = await processConnectivityBatch(env, eventBatch, 'event')
        } catch (error) {
          // Re-enqueue atoms so they retry; they were spliced out of pending on dequeue.
          await enqueueForConnectivityBatch(env.CONNECTIVITY_KV, eventBatch).catch(() => {})
          await recordFailedBatch(env.CONNECTIVITY_KV, 'event', eventBatch, String(error)).catch(() => {})
          throw error
        }
      } else {
        const watermark = await getWatermark(env.CONNECTIVITY_KV)
        const sweepBatch = await getSweepBatch(env.DB, watermark, CONNECTIVITY_BATCH_SIZE)
        if (sweepBatch.length > 0) {
          const sweepIds = sweepBatch.map(r => r.id)
          const nextWatermark = sweepBatch[sweepBatch.length - 1].id
          try {
            stats = await processConnectivityBatch(env, sweepIds, 'sweep')
          } catch (error) {
            // Poison-atom protection: log for investigation, advance watermark below,
            // swallow so phase logs success. Event queue's job is retry, not sweep's.
            phaseError = String(error)
            await recordFailedBatch(env.CONNECTIVITY_KV, 'sweep', sweepIds, phaseError).catch(() => {})
            log.error('Phase 8 sweep batch failed, advancing watermark past poison atoms', {
              phase: 8,
              error: phaseError,
              atom_ids: sweepIds,
            })
          } finally {
            // Always advance the watermark — forward progress regardless of batch outcome.
            await setWatermark(env.CONNECTIVITY_KV, nextWatermark)
          }
        } else if (watermark !== '') {
          // Wrap-around: reset so next tick restarts from beginning of table
          await setWatermark(env.CONNECTIVITY_KV, '')
        }
      }

      if (stats) {
        await logConnectivityStats(env.CONNECTIVITY_KV, stats)
        count = stats.atoms_processed
        totalEnqueued += count
        log.info('Phase 8: connectivity scored', { phase: 8, ...stats })
      }
      await logExecution(env.DB, 'phase_8_connectivity', phaseStart, count, phaseError ? 1 : 0,
        stats ? {
          source: stats.source,
          tags: stats.tags_applied,
          memberships: stats.memberships_created,
          correspondences: stats.correspondences_created,
          rows_read: stats.rows_read_estimate,
          budget_exhausted: stats.budget_exhausted,
          active_axes: stats.active_axes_count,
          sweep_error: phaseError ?? undefined,
        } : { sweep_error: phaseError ?? undefined })
    } catch (error) {
      log.error('Phase 8 connectivity error', { phase: 8, error: String(error) })
      await logExecution(env.DB, 'phase_8_connectivity', phaseStart, 0, 1, { error: String(error) })
    }
  }

  // Cycle summary
  await logExecution(env.DB, 'cron_cycle', cycleStart, totalEnqueued, 0, {
    duration_ms: Date.now() - cycleStart,
  })

  if (totalEnqueued > 0) {
    log.info('Cron cycle complete', { total_enqueued: totalEnqueued, duration_ms: Date.now() - cycleStart })
  }

  // Retention: delete entries older than 7 days
  try {
    await env.DB.prepare("DELETE FROM execution_log WHERE completed_at < datetime('now', '-7 days')").run()
  } catch {}

  // Daily review: generate at 06:00 UTC (first cron tick in the 06:xx window)
  const now = new Date()
  if (now.getUTCHours() === 6 && now.getUTCMinutes() < 15 && env.R2) {
    try {
      const { key, size } = await generateDailyReview(env.DB, env.R2)
      log.info('Daily review generated', { key, size })
      await logExecution(env.DB, 'daily_review', Date.now(), 1, 0, { key, size })
    } catch (error) {
      log.error('Daily review generation failed', { error: String(error) })
      await logExecution(env.DB, 'daily_review', Date.now(), 0, 1, { error: String(error) })
    }
  }

  // Monthly correspondence prune: 1st of month at 06:00 UTC
  if (now.getUTCDate() === 1 && now.getUTCHours() === 6 && now.getUTCMinutes() < 15) {
    try {
      const pruneResult = await env.DB.prepare(
        "DELETE FROM correspondences WHERE last_reinforced_at < datetime('now', '-90 days') AND strength < 0.5 AND provenance = 'semantic'"
      ).run()
      const pruned = pruneResult.meta?.changes ?? 0
      log.info('Monthly correspondence prune', { pruned })
      await logExecution(env.DB, 'monthly_corr_prune', Date.now(), pruned, 0)
    } catch (error) {
      log.error('Monthly correspondence prune failed', { error: String(error) })
      await logExecution(env.DB, 'monthly_corr_prune', Date.now(), 0, 1, { error: String(error) })
    }
  }

  // Quality gate log retention: delete entries older than 30 days
  try {
    await env.DB.prepare("DELETE FROM quality_gate_log WHERE checked_at < datetime('now', '-30 days')").run()
  } catch {}
}
