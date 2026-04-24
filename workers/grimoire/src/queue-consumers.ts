import { createLogger } from '@shared/logger'

const log = createLogger('grimoire')

/**
 * Queue Consumer Handlers
 *
 * Four handlers for the grimoire queue pipeline:
 * - handleClassifyBatch: classify, enrich-harmonics, classify-register (Gemini)
 * - handleVectorizeBatch: embedding generation (Workers AI)
 * - handleEnrichBatch: tag-arrangements, discover-correspondences (no LLM)
 * - handleDlqBatch: log failed messages to failed_operations table
 *
 * All primary consumers are idempotent: re-fetch atom from D1, skip if already processed.
 */

import type { Env, ClassifyMessage, DiscoveryMessage, VectorizeMessage, EnrichMessage } from './types'
import type { AtomRow } from './types'
import { classifyAtom, classifyRegister, extractMetadataContext } from './atom-classify'
import { vectorizeAtomBatch, vectorizeChunkBatch } from './vectorize'
import { scoreAtom, loadArrangements, safeParseJSON, dualWriteArrangementTags, type HarmonicProfile } from './arrangement-tagger'
import { discoverSemanticBatch } from './correspondence'
import { buildModelContext } from './models'
import { getCategoryMetadata } from './db'

// --- Classify Consumer ---

export async function handleClassifyBatch(
  batch: MessageBatch<ClassifyMessage | DiscoveryMessage>,
  env: Env
): Promise<void> {
  const ctx = await buildModelContext(env)
  const categories = await getCategoryMetadata(env.DB)

  for (const msg of batch.messages) {
    try {
      const body = msg.body
      const atomId = body.atomId

      if (body.type === 'classify' || body.type === 'discover') {
        // Idempotent: skip if already classified
        const atom = await env.DB.prepare(
          'SELECT id, text_lower, metadata FROM atoms WHERE id = ? AND (category_slug IS NULL OR category_slug = "")'
        ).bind(atomId).first<{ id: string; text_lower: string; metadata: string | null }>()

        if (!atom) { msg.ack(); continue }

        const context = extractMetadataContext(atom.metadata)
        const result = await classifyAtom(atom.text_lower, ctx, categories, context)
        if (result) {
          await env.DB.prepare(
            "UPDATE atoms SET category_slug = ?, harmonics = ?, modality = ?, utility = ?, updated_at = datetime('now') WHERE id = ?"
          ).bind(result.category_slug, JSON.stringify(result.harmonics), result.modality, result.utility, atomId).run()

          // Chain: enqueue for vectorize + tagging
          await env.VECTORIZE_QUEUE.send({ type: 'vectorize', atomId })
          await env.ENRICH_QUEUE.send({ type: 'tag-arrangements', atomId })
        }
        msg.ack()

      } else if (body.type === 'enrich-harmonics') {
        // Idempotent: skip if harmonics already populated
        const atom = await env.DB.prepare(
          "SELECT id, text_lower, metadata FROM atoms WHERE id = ? AND (harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2)"
        ).bind(atomId).first<{ id: string; text_lower: string; metadata: string | null }>()

        if (!atom) { msg.ack(); continue }

        const context = extractMetadataContext(atom.metadata)
        const result = await classifyAtom(atom.text_lower, ctx, categories, context)
        if (result) {
          await env.DB.prepare(
            "UPDATE atoms SET harmonics = ?, modality = ?, utility = ?, updated_at = datetime('now') WHERE id = ?"
          ).bind(JSON.stringify(result.harmonics), result.modality, result.utility, atomId).run()

          // Chain: tagging now possible
          await env.ENRICH_QUEUE.send({ type: 'tag-arrangements', atomId })
        }
        msg.ack()

      } else if (body.type === 'classify-register') {
        // Idempotent: skip if register already set
        const atom = await env.DB.prepare(
          'SELECT id, text_lower FROM atoms WHERE id = ? AND register IS NULL'
        ).bind(atomId).first<{ id: string; text_lower: string }>()

        if (!atom) { msg.ack(); continue }

        const result = await classifyRegister(atom.text_lower, body.categorySlug, ctx)
        if ('register' in result) {
          await env.DB.prepare(
            'UPDATE atoms SET register = ? WHERE id = ?'
          ).bind(result.register, atomId).run()
        }
        msg.ack()
      }
    } catch (err) {
      log.error('classify batch error', { queue: 'classify', atom_id: msg.body.atomId, error: String(err) })
      msg.retry()
    }
  }
}

// --- Vectorize Consumer ---

export async function handleVectorizeBatch(
  batch: MessageBatch<VectorizeMessage>,
  env: Env
): Promise<void> {
  // Separate atom and chunk messages
  const atomMessages = batch.messages.filter(m => m.body.type === 'vectorize')
  const chunkMessages = batch.messages.filter(m => m.body.type === 'vectorize-chunk')

  // Handle atom vectorization
  if (atomMessages.length > 0) {
    const atomIds = atomMessages.map(m => (m.body as { type: 'vectorize'; atomId: string }).atomId)
    const placeholders = atomIds.map(() => '?').join(',')
    const { results: atoms } = await env.DB.prepare(
      `SELECT * FROM atoms WHERE id IN (${placeholders}) AND embedding_status IN ('pending', 'failed') AND category_slug IS NOT NULL`
    ).bind(...atomIds).all<AtomRow>()

    if (atoms.length > 0) {
      let totalVectorized = 0
      for (let i = 0; i < atoms.length; i += 100) {
        const chunk = atoms.slice(i, i + 100)
        const result = await vectorizeAtomBatch(chunk, env.AI, env.VECTORIZE, env.DB)
        totalVectorized += result.vectorized
      }

      // Chain: enqueue for correspondence discovery
      for (const atom of atoms) {
        if (atom.category_slug) {
          await env.ENRICH_QUEUE.send({ type: 'discover-correspondences', atomId: atom.id })
        }
      }

      log.info('vectorize batch complete', { queue: 'vectorize', vectorized: totalVectorized, total: atoms.length })
    }
  }

  // Handle document chunk vectorization
  if (chunkMessages.length > 0) {
    const chunkIds = chunkMessages.map(m => (m.body as { type: 'vectorize-chunk'; chunkId: string }).chunkId)
    const placeholders = chunkIds.map(() => '?').join(',')
    const { results: chunks } = await env.DB.prepare(
      `SELECT id, content, document_id, category_slug FROM document_chunks WHERE id IN (${placeholders}) AND embedding_status IN ('pending', 'failed')`
    ).bind(...chunkIds).all<{ id: string; content: string; document_id: string; category_slug: string | null }>()

    if (chunks.length > 0) {
      const result = await vectorizeChunkBatch(chunks, env.AI, env.VECTORIZE, env.DB)
      log.info('vectorize chunks complete', { queue: 'vectorize', vectorized: result.vectorized, total: chunks.length })
    }
  }

  batch.ackAll()
}

// --- Enrich Consumer ---

export async function handleEnrichBatch(
  batch: MessageBatch<EnrichMessage>,
  env: Env
): Promise<void> {
  // Separate messages by type
  const tagMessages: Message<EnrichMessage>[] = []
  const corrMessages: Message<EnrichMessage>[] = []

  for (const msg of batch.messages) {
    if (msg.body.type === 'tag-arrangements') tagMessages.push(msg)
    else if (msg.body.type === 'discover-correspondences') corrMessages.push(msg)
  }

  // --- Tag Arrangements ---
  if (tagMessages.length > 0) {
    try {
      const { arrangements, currentVersion } = await loadArrangements(env.DB)
      if (arrangements.length === 0) {
        for (const msg of tagMessages) msg.ack()
      } else {
        const atomIds = tagMessages.map(m => m.body.atomId)
        const placeholders = atomIds.map(() => '?').join(',')
        const { results: atoms } = await env.DB.prepare(
          `SELECT id, text_lower, harmonics, register, tag_version FROM atoms WHERE id IN (${placeholders}) AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tag_version < ? AND status != 'rejected'`
        ).bind(...atomIds, currentVersion).all<{ id: string; text_lower: string; harmonics: string; register: number | null; tag_version: number }>()

        if (atoms.length > 0) {
          const updates = atoms.map(atom => {
            const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
            harmonics.register = atom.register ?? 0.5

            if (typeof harmonics.hardness !== 'number') {
              return { id: atom.id, newTags: JSON.stringify([{ slug: 'unaffiliated', dist: 0 }]) }
            }

            const topMatches = scoreAtom(harmonics, arrangements, atom.text_lower)
            const tagsStr = JSON.stringify(topMatches.length > 0 ? topMatches : [{ slug: 'unaffiliated', dist: 0 }])
            return { id: atom.id, newTags: tagsStr }
          })

          // Dual-write: join table + JSON column (atomic)
          await dualWriteArrangementTags(env.DB, updates, currentVersion)
        }

        for (const msg of tagMessages) msg.ack()
      }
    } catch (err) {
      log.error('tag-arrangements error', { queue: 'enrich', error: String(err) })
      for (const msg of tagMessages) msg.retry()
    }
  }

  // --- Discover Correspondences ---
  if (corrMessages.length > 0) {
    try {
      const atomIds = corrMessages.map(m => m.body.atomId)
      const placeholders = atomIds.map(() => '?').join(',')
      const { results: atoms } = await env.DB.prepare(
        `SELECT id, text_lower, category_slug FROM atoms WHERE id IN (${placeholders}) AND embedding_status = 'complete' AND category_slug IS NOT NULL`
      ).bind(...atomIds).all<{ id: string; text_lower: string; category_slug: string }>()

      if (atoms.length > 0) {
        const { inserted } = await discoverSemanticBatch(env.DB, env.VECTORIZE, atoms)
        log.info('correspondences discovered', { queue: 'enrich', atoms: atoms.length, inserted })

        // Mark atoms as fully enriched, but ONLY if all pipeline phases completed:
        // - classified (category_slug IS NOT NULL)
        // - vectorized (embedding_status = 'complete')
        // - harmonics scored (harmonics IS NOT NULL AND LENGTH(harmonics) > 2)
        // - arrangement tagged (tag_version > 0)
        // - register scored (register IS NOT NULL)
        // Atoms that skipped phases (e.g., fast-tracked via /discover) are excluded.
        const ph = atoms.map(() => '?').join(',')
        await env.DB.prepare(
          `UPDATE atoms SET fully_enriched_at = datetime('now')
           WHERE id IN (${ph})
             AND fully_enriched_at IS NULL
             AND category_slug IS NOT NULL
             AND embedding_status = 'complete'
             AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2
             AND tag_version > 0
             AND register IS NOT NULL`
        ).bind(...atoms.map(a => a.id)).run()
      }

      for (const msg of corrMessages) msg.ack()
    } catch (err) {
      log.error('discover-correspondences error', { queue: 'enrich', error: String(err) })
      for (const msg of corrMessages) msg.retry()
    }
  }
}

// --- DLQ Consumer ---

export async function handleDlqBatch(
  batch: MessageBatch<ClassifyMessage | DiscoveryMessage | VectorizeMessage | EnrichMessage>,
  env: Env
): Promise<void> {
  const queueName = batch.queue.replace('-dlq', '')

  for (const msg of batch.messages) {
    try {
      const body = msg.body
      const atomId = 'atomId' in body ? body.atomId : null
      const messageType = 'type' in body ? body.type : 'unknown'

      await env.DB.prepare(
        "INSERT INTO failed_operations (queue, atom_id, message_type, error, failed_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).bind(queueName, atomId, messageType, `DLQ after ${msg.attempts} attempts`).run()

      log.warn('DLQ message logged', { queue: queueName, atom_id: atomId, message_type: messageType, attempts: msg.attempts })
      msg.ack()
    } catch (err) {
      log.error('DLQ logging failed', { queue: queueName, error: String(err) })
      msg.ack() // ack anyway; can't let DLQ messages loop
    }
  }

  // DLQ alerting: notify Discord if failure rate exceeds threshold
  if (env.DISCORD_WEBHOOK_URL && batch.messages.length > 0) {
    try {
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM failed_operations WHERE failed_at > datetime('now', '-1 hour')"
      ).first<{ cnt: number }>()
      const failCount = countRow?.cnt ?? 0
      if (failCount > 5) {
        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `**Grimoire DLQ Alert**: ${failCount} failures in the last hour. Queue: ${queueName}. Check \`/admin/failed-operations\`.`,
          }),
        }).catch(() => {}) // fire and forget
      }
    } catch (e) {
      log.error('DLQ alert check failed', { error: String(e) })
    }
  }
}
