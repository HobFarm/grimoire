import { Hono } from 'hono'
import type { Env, AtomRow, CreateAtomInput } from './types'
import { vectorizeBatchProcess, vectorizeChunkBatch } from './vectorize'
import { classifyAtom, classifyBatchProcess, classifyRegister, extractMetadataContext } from './atom-classify'
import { createAtom, generateId } from './atoms'
import { enqueueForConnectivity } from './connectivity'
import { getCategoryMetadata } from './db'
import { collectionFromCategory } from './taxonomy'
import { discoverSemanticBatch, purgeSemanticCorrespondences } from './correspondence'
import { buildModelContext, MODELS, type TaskType } from './models'
import { callWithFallback } from './provider'
import type { ProviderHealth } from './circuit-breaker'
import { applyWildcardBootstrap, ApplyError as WildcardApplyError, type WildcardApplyRequest } from './wildcard-bootstrap'

const adminApp = new Hono<{ Bindings: Env }>()

// D1 write with retry for transient DO resets (error 7500)
async function d1WriteWithRetry(
  db: D1Database, sql: string, binds: unknown[], maxRetries = 3
): Promise<D1Result> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await db.prepare(sql).bind(...binds).run()
    } catch (err) {
      if (attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, attempt * 2000))
    }
  }
  throw new Error('unreachable')
}

// --- POST /vectorize-batch ---
// ?sync=true for inline processing, default is queue mode

adminApp.post('/vectorize-batch', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
  const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 1000)
  const sync = c.req.query('sync') === 'true'

  if (sync) {
    const result = await vectorizeBatchProcess(c.env.DB, c.env.AI, c.env.VECTORIZE, { limit })
    const remainingRes = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL"
    ).first<{ count: number }>()
    return c.json({ ...result, remaining: remainingRes?.count ?? 0, mode: 'sync' })
  }

  const { results } = await c.env.DB.prepare(
    "SELECT id FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL LIMIT ?"
  ).bind(limit).all<{ id: string }>()

  if (results.length > 0) {
    await c.env.VECTORIZE_QUEUE.sendBatch(results.map(r => ({ body: { type: 'vectorize' as const, atomId: r.id } })))
  }

  const remainingRes = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL"
  ).first<{ count: number }>()

  return c.json({ enqueued: results.length, remaining: remainingRes?.count ?? 0, mode: 'queue' })
})

// --- POST /classify-batch ---

adminApp.post('/classify-batch', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100)
  const sync = c.req.query('sync') === 'true'

  if (sync) {
    const ctx = await buildModelContext(c.env)
    const result = await classifyBatchProcess(c.env.DB, ctx, { limit })
    const remainingRes = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM atoms WHERE (category_slug IS NULL OR category_slug = '')"
    ).first<{ count: number }>()
    return c.json({ classified: result.classified, failed: result.failed, remaining: remainingRes?.count ?? 0, mode: 'sync' })
  }

  const { results } = await c.env.DB.prepare(
    "SELECT id FROM atoms WHERE (category_slug IS NULL OR category_slug = '') LIMIT ?"
  ).bind(limit).all<{ id: string }>()

  if (results.length > 0) {
    await c.env.CLASSIFY_QUEUE.sendBatch(results.map(r => ({ body: { type: 'classify' as const, atomId: r.id } })))
  }

  const remainingRes = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM atoms WHERE (category_slug IS NULL OR category_slug = '')"
  ).first<{ count: number }>()

  return c.json({ enqueued: results.length, remaining: remainingRes?.count ?? 0, mode: 'queue' })
})

// --- POST /ingest-batch ---

adminApp.post('/ingest-batch', async (c) => {
  const { atoms } = await c.req.json()
  if (!Array.isArray(atoms) || atoms.length === 0) {
    return c.json({ error: 'atoms array required' }, 400)
  }

  const db = c.env.DB
  const limit = Math.min(atoms.length, 1000)
  const batch = atoms.slice(0, limit)

  let inserted = 0
  let skipped = 0

  const CHUNK = 50
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK)
    const stmts: D1PreparedStatement[] = []

    for (const atom of chunk) {
      const text = (atom.text || '').trim()
      const collection = (atom.collection_slug || 'uncategorized').trim()
      const category = atom.category_slug ? atom.category_slug.trim() : null
      if (!text || text.length > 500) continue

      const id = generateId()
      const textLower = text.toLowerCase()
      const now = new Date().toISOString()

      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, category_slug, observation, status, confidence, encounter_count, tags, source, metadata, embedding_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'observation', 'provisional', 0.5, 1, '[]', 'manual', '{}', 'pending', ?, ?)`
        ).bind(id, text, textLower, collection, category, now, now)
      )
    }

    if (stmts.length > 0) {
      try {
        const results = await db.batch(stmts)
        for (const r of results) {
          if ((r.meta?.changes ?? 0) > 0) inserted++
          else skipped++
        }
      } catch (err: unknown) {
        skipped += stmts.length
        console.error(`batch insert error: ${(err as Error).message}`)
      }
    }
  }

  return c.json({
    inserted,
    skipped,
    total: batch.length,
    remaining: Math.max(0, atoms.length - limit),
  })
})

// --- GET /status ---

adminApp.get('/status', async (c) => {
  const [totalRes, classifiedRes, embeddingRes, chunkEmbeddingRes] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM atoms'),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM atoms WHERE category_slug IS NOT NULL'),
    c.env.DB.prepare('SELECT embedding_status, COUNT(*) as count FROM atoms GROUP BY embedding_status'),
    c.env.DB.prepare('SELECT embedding_status, COUNT(*) as count FROM document_chunks GROUP BY embedding_status'),
  ])

  const total = (totalRes.results[0] as unknown as { count: number })?.count ?? 0
  const classified = (classifiedRes.results[0] as unknown as { count: number })?.count ?? 0

  const embedding_status: Record<string, number> = {
    pending: 0,
    processing: 0,
    complete: 0,
    failed: 0,
  }

  for (const row of embeddingRes.results) {
    const r = row as { embedding_status: string; count: number }
    if (r.embedding_status in embedding_status) {
      embedding_status[r.embedding_status] = r.count
    }
  }

  const chunk_embedding_status: Record<string, number> = {
    pending: 0,
    complete: 0,
    failed: 0,
  }

  for (const row of chunkEmbeddingRes.results) {
    const r = row as { embedding_status: string; count: number }
    if (r.embedding_status in chunk_embedding_status) {
      chunk_embedding_status[r.embedding_status] = r.count
    }
  }

  // Cron execution staleness check
  const STALE_THRESHOLD_MINUTES = 45
  let last_cron: Record<string, { last_run: string | null; stale: boolean; recent_failures: number }> = {}
  try {
    const cronPhases = await c.env.DB.prepare(`
      SELECT phase, MAX(completed_at) as last_run,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as recent_failures
      FROM execution_log
      WHERE worker = 'grimoire' AND completed_at > datetime('now', '-24 hours')
      GROUP BY phase
    `).all<{ phase: string; last_run: string; recent_failures: number }>()

    for (const row of cronPhases.results) {
      const lastRun = new Date(row.last_run + 'Z').getTime()
      const minutesAgo = (Date.now() - lastRun) / 60_000
      last_cron[row.phase] = {
        last_run: row.last_run,
        stale: minutesAgo > STALE_THRESHOLD_MINUTES,
        recent_failures: row.recent_failures,
      }
    }
  } catch {
    // execution_log table may not exist yet if migration hasn't been applied
  }

  return c.json({
    total,
    classified,
    unclassified: total - classified,
    embedding_status,
    chunk_embedding_status,
    last_cron,
  })
})

// --- POST /discover-correspondences ---

adminApp.post('/discover-correspondences', async (c) => {
  return c.json({
    deprecated: true,
    message: 'String-based harmonic correspondences deprecated. Use /admin/discover-semantic-correspondences instead.',
  }, 410)
})

// --- POST /discover-semantic-correspondences ---

adminApp.post('/discover-semantic-correspondences', async (c) => {
  try {
    const body = await c.req.json<{ batchSize?: number; afterId?: string }>()
      .catch(() => ({} as { batchSize?: number; afterId?: string }))
    const batchSize = Math.min(Math.max(Number(body.batchSize) || 25, 1), 500)
    const afterId = body.afterId ?? ''
    const sync = c.req.query('sync') === 'true'

    if (sync) {
      const { results: atoms } = await c.env.DB.prepare(`
        SELECT a.id, a.text_lower, a.category_slug FROM atoms a
        WHERE a.embedding_status = 'complete'
          AND a.category_slug IS NOT NULL
          AND a.id > ?
        ORDER BY a.id LIMIT ?
      `).bind(afterId, batchSize).all<{ id: string; text_lower: string; category_slug: string }>()

      if (atoms.length === 0) {
        return c.json({ processed: 0, inserted: 0, remaining: 0, lastId: afterId, mode: 'sync' })
      }

      const { inserted } = await discoverSemanticBatch(c.env.DB, c.env.VECTORIZE, atoms)
      const lastId = atoms[atoms.length - 1].id
      const remaining = atoms.length >= batchSize ? 1 : 0
      return c.json({ processed: atoms.length, inserted, remaining, lastId, mode: 'sync' })
    }

    // Queue mode
    const { results: atoms } = await c.env.DB.prepare(`
      SELECT a.id FROM atoms a
      WHERE a.embedding_status = 'complete'
        AND a.category_slug IS NOT NULL
        AND a.id > ?
      ORDER BY a.id LIMIT ?
    `).bind(afterId, batchSize).all<{ id: string }>()

    if (atoms.length > 0) {
      await c.env.ENRICH_QUEUE.sendBatch(atoms.map(r => ({
        body: { type: 'discover-correspondences' as const, atomId: r.id }
      })))
    }

    return c.json({ enqueued: atoms.length, mode: 'queue' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    return c.json({ error: msg, stack }, 500)
  }
})

// --- POST /purge-semantic-correspondences ---

adminApp.post('/purge-semantic-correspondences', async (c) => {
  const { deleted } = await purgeSemanticCorrespondences(c.env.DB)
  return c.json({ deleted })
})

// --- POST /assign-modality ---

adminApp.post('/assign-modality', async (c) => {
  const categories = await getCategoryMetadata(c.env.DB)
  let updated = 0

  for (const cat of categories) {
    const res = await c.env.DB.prepare(
      'UPDATE atoms SET modality = ? WHERE category_slug = ? AND modality != ?'
    ).bind(cat.default_modality, cat.slug, cat.default_modality).run()
    updated += res.meta.changes ?? 0
  }

  return c.json({ updated })
})

// --- POST /enrich-harmonics ---

adminApp.post('/enrich-harmonics', async (c) => {
  const body = await c.req.json<{ limit?: number; category?: string; collection?: string }>().catch(() => ({} as { limit?: number; category?: string; collection?: string }))
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 100)
  const sync = c.req.query('sync') === 'true'

  const conditions = [
    "category_slug IS NOT NULL",
    "(harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2)",
    "status != 'rejected'"
  ]
  const binds: (string | number)[] = []

  if (body.category) {
    conditions.push("category_slug = ?")
    binds.push(body.category)
  }
  if (body.collection) {
    conditions.push("collection_slug = ?")
    binds.push(body.collection)
  }

  if (sync) {
    binds.push(limit)
    const sql = `SELECT id, text_lower, collection_slug, category_slug, metadata FROM atoms WHERE ${conditions.join(' AND ')} LIMIT ?`
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all()

    let enriched = 0
    let failed = 0
    const sample: Array<{ id: string; text: string; harmonics: Record<string, number> }> = []
    const categories = await getCategoryMetadata(c.env.DB)

    for (let i = 0; i < results.length; i += 5) {
      if (i > 0) await new Promise(r => setTimeout(r, 500))
      const chunk = results.slice(i, i + 5)

      const settled = await Promise.allSettled(
        chunk.map(async (atom) => {
          const ctx = await buildModelContext(c.env)
          const context = extractMetadataContext(atom.metadata as string | null)
          const classification = await classifyAtom(
            atom.text_lower as string,
            ctx,
            categories,
            context,
          )
          if (!classification) return false

          await d1WriteWithRetry(c.env.DB,
            "UPDATE atoms SET harmonics = ?, modality = ?, utility = ?, updated_at = datetime('now') WHERE id = ?",
            [JSON.stringify(classification.harmonics), classification.modality, classification.utility, atom.id]
          )

          if (sample.length < 3) {
            sample.push({ id: atom.id as string, text: atom.text_lower as string, harmonics: classification.harmonics })
          }
          return true
        })
      )

      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) enriched++
        else failed++
      }
    }

    const remainingRes = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM atoms WHERE category_slug IS NOT NULL AND (harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2) AND status != 'rejected'"
    ).first<{ count: number }>()

    return c.json({ enriched, failed, remaining: remainingRes?.count ?? 0, sample, mode: 'sync' })
  }

  // Queue mode
  binds.push(limit)
  const sql = `SELECT id FROM atoms WHERE ${conditions.join(' AND ')} LIMIT ?`
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<{ id: string }>()

  if (results.length > 0) {
    await c.env.CLASSIFY_QUEUE.sendBatch(results.map(r => ({
      body: { type: 'enrich-harmonics' as const, atomId: r.id }
    })))
  }

  return c.json({ enqueued: results.length, mode: 'queue' })
})

// --- POST /register-classify-batch ---

adminApp.post('/register-classify-batch', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
  const limit = Math.min(Math.max(Number(body.limit) || 30, 1), 100)
  const sync = c.req.query('sync') === 'true'

  if (sync) {
    const { results } = await c.env.DB.prepare(
      'SELECT id, text_lower, category_slug FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL ORDER BY RANDOM() LIMIT ?'
    ).bind(limit).all<{ id: string; text_lower: string; category_slug: string }>()

    let classified = 0
    const errors: Array<{ atom: string; error: string }> = []

    for (let i = 0; i < results.length; i += 4) {
      if (i > 0) await new Promise(r => setTimeout(r, 500))
      const chunk = results.slice(i, i + 4)
      const settled = await Promise.allSettled(
        chunk.map(async (atom) => {
          const ctx = await buildModelContext(c.env)
          const result = await classifyRegister(
            atom.text_lower,
            atom.category_slug,
            ctx
          )
          if ('error' in result) {
            errors.push({ atom: atom.text_lower.slice(0, 40), error: result.error })
            return false
          }

          await d1WriteWithRetry(c.env.DB,
            'UPDATE atoms SET register = ? WHERE id = ?',
            [result.register, atom.id]
          )
          return true
        })
      )

      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) {
          classified++
        }
      }
    }

    const remainingRes = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL'
    ).first<{ count: number }>()

    return c.json({ classified, remaining: remainingRes?.count ?? 0, errors, mode: 'sync' })
  }

  // Queue mode
  const { results } = await c.env.DB.prepare(
    'SELECT id, category_slug FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL LIMIT ?'
  ).bind(limit).all<{ id: string; category_slug: string }>()

  if (results.length > 0) {
    await c.env.CLASSIFY_QUEUE.sendBatch(results.map(r => ({
      body: { type: 'classify-register' as const, atomId: r.id, categorySlug: r.category_slug }
    })))
  }

  const remainingRes = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL'
  ).first<{ count: number }>()

  return c.json({ enqueued: results.length, remaining: remainingRes?.count ?? 0, mode: 'queue' })
})

// --- POST /backfill-semcc ---
// One-time backfill of atoms.semantic_correspondence_count after migration 0030.
// Cursor-based so it can be driven to completion across many calls without hitting
// D1's 30s statement timeout. Each call processes `limit` atoms in sub-batches of 80
// (D1 binding limit). Returns the next cursor and remaining estimate.
//
// Triggers keep the counter correct for live writes, so running this endpoint
// concurrently with normal ingestion is safe.

adminApp.post('/backfill-semcc', async (c) => {
  const body = await c.req.json<{ cursor?: string; limit?: number }>().catch(() => ({} as { cursor?: string; limit?: number }))
  const cursor = body.cursor ?? ''
  const limit = Math.min(Math.max(Number(body.limit) || 5000, 100), 10000)

  const { results: ids } = await c.env.DB.prepare(
    'SELECT id FROM atoms WHERE id > ? ORDER BY id LIMIT ?'
  ).bind(cursor, limit).all<{ id: string }>()

  if (ids.length === 0) {
    return c.json({ updated: 0, next_cursor: null, done: true })
  }

  let updated = 0
  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80)
    const placeholders = batch.map(() => '?').join(',')
    const res = await c.env.DB.prepare(
      `UPDATE atoms SET semantic_correspondence_count = (
         (SELECT COUNT(*) FROM correspondences WHERE atom_a_id = atoms.id AND provenance = 'semantic')
         + (SELECT COUNT(*) FROM correspondences WHERE atom_b_id = atoms.id AND provenance = 'semantic')
       ) WHERE id IN (${placeholders})`
    ).bind(...batch.map(r => r.id)).run()
    updated += res.meta?.changes ?? 0
  }

  const nextCursor = ids[ids.length - 1].id
  const done = ids.length < limit

  return c.json({
    updated,
    processed: ids.length,
    next_cursor: done ? null : nextCursor,
    done,
  })
})

// --- GET /provider-health ---

adminApp.get('/provider-health', async (c) => {
  const kv = c.env.PROVIDER_HEALTH
  if (!kv) return c.json({ error: 'PROVIDER_HEALTH KV not configured' }, 503)

  const entries: Array<{ provider: string; model: string; healthy: boolean; health: ProviderHealth | null }> = []

  for (const config of Object.values(MODELS)) {
    const allEntries = [config.primary, ...config.fallbacks]
    for (const entry of allEntries) {
      const providerKey = `${entry.provider}:${entry.model}`
      if (entries.some(e => `${e.provider}:${e.model}` === providerKey)) continue

      const raw = await kv.get(`provider:health:${providerKey}`)
      const health: ProviderHealth | null = raw ? JSON.parse(raw) : null
      const healthy = !health || health.failures < 3 || Date.now() - health.lastFailure > 5 * 60 * 1000
      entries.push({ provider: entry.provider, model: entry.model, healthy, health })
    }
  }

  return c.json({ providers: entries })
})

// --- POST /provider-health/reset ---

adminApp.post('/provider-health/reset', async (c) => {
  const kv = c.env.PROVIDER_HEALTH
  if (!kv) return c.json({ error: 'PROVIDER_HEALTH KV not configured' }, 503)

  const provider = c.req.query('provider')
  if (!provider) return c.json({ error: 'provider query param required (e.g. gemini:gemini-2.5-flash-lite)' }, 400)

  await kv.delete(`provider:health:${provider}`)
  return c.json({ reset: provider })
})

// --- POST /test-fallback ---

adminApp.post('/test-fallback', async (c) => {
  const task = (c.req.query('task') || 'classify') as TaskType
  if (!(task in MODELS)) return c.json({ error: `Unknown task type: ${task}`, valid: Object.keys(MODELS) }, 400)

  const ctx = await buildModelContext(c.env)
  const prompt = 'Classify this test term: "neon glow". Respond with JSON: {"category_slug":"test","harmonics":{}}'

  const result = await callWithFallback(ctx, task, prompt, { skipPrimary: true })
  return c.json({
    task,
    provider: result.provider,
    model: result.model,
    durationMs: result.durationMs,
    response: result.result.slice(0, 500),
  })
})

// --- POST /bulk-retag (Workflow trigger) ---

adminApp.post('/bulk-retag', async (c) => {
  const body = await c.req.json<{ batchSize?: number; dryRun?: boolean }>().catch(() => ({} as { batchSize?: number; dryRun?: boolean }))
  const dryRun = body.dryRun ?? c.req.query('dryRun') === 'true' ?? false
  const batchSize = body.batchSize ?? 500

  const instance = await c.env.BULK_RETAG_WORKFLOW.create({
    params: { batchSize, dryRun },
  })

  return c.json({
    instanceId: instance.id,
    dryRun,
    batchSize,
    message: 'Bulk re-tag workflow started',
  })
})

// --- POST /bulk-correspondences (Workflow trigger) ---

adminApp.post('/bulk-correspondences', async (c) => {
  const body = await c.req.json<{ batchSize?: number; dryRun?: boolean }>().catch(() => ({} as { batchSize?: number; dryRun?: boolean }))
  const dryRun = body.dryRun ?? c.req.query('dryRun') === 'true' ?? false
  const batchSize = body.batchSize ?? 10

  const instance = await c.env.BULK_CORRESPONDENCES_WORKFLOW.create({
    params: { batchSize, dryRun },
  })

  return c.json({
    instanceId: instance.id,
    dryRun,
    batchSize,
    message: 'Bulk correspondences workflow started',
  })
})

// --- GET /workflow/:id (Workflow status) ---

adminApp.get('/workflow/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const instance = await c.env.BULK_RETAG_WORKFLOW.get(id)
    const status = await instance.status()
    return c.json({ workflow: 'bulk-retag', id, status })
  } catch {
    // Not a retag workflow, try correspondences
  }

  try {
    const instance = await c.env.BULK_CORRESPONDENCES_WORKFLOW.get(id)
    const status = await instance.status()
    return c.json({ workflow: 'bulk-correspondences', id, status })
  } catch {
    return c.json({ error: 'Workflow instance not found' }, 404)
  }
})

// --- GET /failed-operations ---

adminApp.get('/failed-operations', async (c) => {
  const queue = c.req.query('queue')
  const status = c.req.query('status')
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500)

  const conditions: string[] = []
  const binds: (string | number)[] = []

  if (queue) {
    conditions.push('queue = ?')
    binds.push(queue)
  }
  if (status === 'permanent') {
    conditions.push('permanently_failed = 1')
  } else if (status === 'active') {
    conditions.push('permanently_failed = 0')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT * FROM failed_operations ${where} ORDER BY failed_at DESC LIMIT ?`
  binds.push(limit)

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()

  // Summary counts
  const counts = await c.env.DB.prepare(
    'SELECT permanently_failed, COUNT(*) as cnt FROM failed_operations GROUP BY permanently_failed'
  ).all<{ permanently_failed: number; cnt: number }>()
  const summary = {
    active: counts.results.find(r => r.permanently_failed === 0)?.cnt ?? 0,
    permanently_failed: counts.results.find(r => r.permanently_failed === 1)?.cnt ?? 0,
  }

  return c.json({ failures: results, summary })
})

// --- POST /failed-operations/retry ---

adminApp.post('/failed-operations/retry', async (c) => {
  const MAX_RETRIES = 3
  const body = await c.req.json<{ queue?: string; ids?: number[] }>().catch(() => ({} as { queue?: string; ids?: number[] }))

  let sql = 'SELECT * FROM failed_operations WHERE permanently_failed = 0'
  const binds: (string | number)[] = []

  if (body.queue) {
    sql += ' AND queue = ?'
    binds.push(body.queue)
  }
  if (body.ids && body.ids.length > 0) {
    sql += ` AND id IN (${body.ids.map(() => '?').join(',')})`
    binds.push(...body.ids)
  }

  sql += ' LIMIT 100'
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<{
    id: number; queue: string; atom_id: string; message_type: string; retry_count: number
  }>()

  let retried = 0
  let escalated = 0
  for (const row of results) {
    // Escalation: mark permanently failed after MAX_RETRIES
    if ((row.retry_count ?? 0) >= MAX_RETRIES) {
      await c.env.DB.prepare(
        "UPDATE failed_operations SET permanently_failed = 1, failure_reason = 'exceeded max retries' WHERE id = ?"
      ).bind(row.id).run()
      escalated++
      continue
    }

    const atomId = row.atom_id
    if (!atomId) continue

    const messageType = row.message_type || 'classify'
    switch (row.queue) {
      case 'classify':
        if (messageType === 'enrich-harmonics') {
          await c.env.CLASSIFY_QUEUE.send({ type: 'enrich-harmonics', atomId })
        } else if (messageType === 'classify-register') {
          const atom = await c.env.DB.prepare('SELECT category_slug FROM atoms WHERE id = ?').bind(atomId).first<{ category_slug: string }>()
          if (atom) {
            await c.env.CLASSIFY_QUEUE.send({ type: 'classify-register', atomId, categorySlug: atom.category_slug })
          }
        } else {
          await c.env.CLASSIFY_QUEUE.send({ type: 'classify', atomId })
        }
        break
      case 'vectorize':
        await c.env.VECTORIZE_QUEUE.send({ type: 'vectorize', atomId })
        break
      case 'enrich':
        if (messageType === 'discover-correspondences') {
          await c.env.ENRICH_QUEUE.send({ type: 'discover-correspondences', atomId })
        } else {
          await c.env.ENRICH_QUEUE.send({ type: 'tag-arrangements', atomId })
        }
        break
    }

    await c.env.DB.prepare(
      'UPDATE failed_operations SET retry_count = COALESCE(retry_count, 0) + 1, retried = 1 WHERE id = ?'
    ).bind(row.id).run()
    retried++
  }

  return c.json({ retried, escalated, total: results.length })
})

// --- GET /arrangement-reconcile ---
// Diagnostic: compare arrangement_atoms join table against arrangement_tags JSON column

adminApp.get('/arrangement-reconcile', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 500, 2000)

  const { results: atoms } = await c.env.DB.prepare(
    "SELECT id, arrangement_tags FROM atoms WHERE arrangement_tags IS NOT NULL AND arrangement_tags != '[]' AND LENGTH(arrangement_tags) > 2 LIMIT ?"
  ).bind(limit).all<{ id: string; arrangement_tags: string }>()

  let checked = 0
  let consistent = 0
  const discrepancies: { atom_id: string; json_slugs: string[]; join_slugs: string[] }[] = []

  for (const atom of atoms) {
    checked++
    let jsonSlugs: string[] = []
    try {
      const parsed = JSON.parse(atom.arrangement_tags) as Array<{ slug: string }>
      jsonSlugs = parsed.map(t => t.slug).filter(s => s !== 'unaffiliated').sort()
    } catch { continue }

    const { results: joinRows } = await c.env.DB.prepare(
      'SELECT arrangement_slug FROM arrangement_atoms WHERE atom_id = ? ORDER BY arrangement_slug'
    ).bind(atom.id).all<{ arrangement_slug: string }>()

    const joinSlugs = joinRows.map(r => r.arrangement_slug).sort()

    if (JSON.stringify(jsonSlugs) === JSON.stringify(joinSlugs)) {
      consistent++
    } else {
      if (discrepancies.length < 20) {
        discrepancies.push({ atom_id: atom.id, json_slugs: jsonSlugs, join_slugs: joinSlugs })
      }
    }
  }

  return c.json({
    checked,
    consistent,
    discrepancy_count: checked - consistent,
    discrepancies,
  })
})

// --- POST /vectorize-cleanup ---
adminApp.post('/vectorize-cleanup', async (c) => {
  try {
    const rejected = await c.env.DB.prepare(
      "SELECT id FROM atoms WHERE status = 'rejected' AND embedding_status = 'complete'"
    ).all<{ id: string }>()

    const ids = rejected.results.map((r) => r.id)
    if (ids.length === 0) {
      return c.json({ deleted: 0, message: 'No rejected vectors to clean up' })
    }

    let deleted = 0
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      await c.env.VECTORIZE.deleteByIds(batch)
      deleted += batch.length
    }

    // Mark embedding_status as pending so they won't be picked up again
    const BATCH_SIZE = 100
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE)
      const stmts = batch.map((id) =>
        c.env.DB.prepare("UPDATE atoms SET embedding_status = 'pending' WHERE id = ?").bind(id)
      )
      await c.env.DB.batch(stmts)
    }

    return c.json({ deleted })
  } catch (error) {
    console.error('Error in vectorize-cleanup:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ── Enqueue Specific Chunks for Vectorization ────────────

adminApp.post('/enqueue-chunks', async (c) => {
  try {
    const { chunkIds } = await c.req.json<{ chunkIds: string[] }>()
    if (!Array.isArray(chunkIds) || chunkIds.length === 0) {
      return c.json({ error: 'chunkIds array required' }, 400)
    }
    for (const chunkId of chunkIds) {
      await c.env.VECTORIZE_QUEUE.send({ type: 'vectorize-chunk', chunkId })
    }
    return c.json({ enqueued: chunkIds.length })
  } catch (error) {
    console.error('Error in enqueue-chunks:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ── Document Chunk Vectorization ──────────────────────────

adminApp.post('/vectorize-chunks', async (c) => {
  try {
    // Count total chunks
    const countResult = await c.env.DB.prepare('SELECT COUNT(*) as total FROM document_chunks').first<{ total: number }>()
    const total = countResult?.total ?? 0
    if (total === 0) return c.json({ vectorized: 0, failed: 0, total: 0 })

    let vectorized = 0
    let failed = 0
    let offset = 0
    const PAGE_SIZE = 100

    while (offset < total) {
      const { results } = await c.env.DB.prepare(
        'SELECT id, content, document_id, category_slug FROM document_chunks LIMIT ? OFFSET ?'
      ).bind(PAGE_SIZE, offset).all<{ id: string; content: string; document_id: string; category_slug: string | null }>()

      if (results.length === 0) break

      const result = await vectorizeChunkBatch(results, c.env.AI, c.env.VECTORIZE, c.env.DB)
      vectorized += result.vectorized
      failed += result.failed
      offset += results.length

      console.log(`[admin] vectorize-chunks: batch ${Math.ceil(offset / PAGE_SIZE)}/${Math.ceil(total / PAGE_SIZE)}, vectorized=${vectorized}, failed=${failed}`)
    }

    return c.json({ vectorized, failed, total })
  } catch (error) {
    console.error('Error in vectorize-chunks:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// --- Arrangement Tagging (one-shot bulk) ---

import { tagAllAtoms } from './arrangement-tagger'

adminApp.post('/tag-arrangements', async (c) => {
  try {
    const batchSize = parseInt(c.req.query('batch_size') || '5000', 10)
    const result = await tagAllAtoms(c.env.DB, batchSize)
    return c.json(result)
  } catch (error) {
    console.error('Error in tag-arrangements:', error)
    return c.json({ error: 'Tagging failed' }, 500)
  }
})

// --- POST /recategorize ---

const RECATEGORIZE_LIMIT = 500

adminApp.post('/recategorize', async (c) => {
  const body = await c.req.json<{
    filter: {
      text_like?: string
      current_category?: string
      source?: string
      atom_ids?: string[]
    }
    target_category: string
    dry_run?: boolean
    reset_tag_version?: boolean
  }>().catch(() => null)

  if (!body || !body.filter || !body.target_category) {
    return c.json({ error: 'Required: filter (object) and target_category (string)' }, 400)
  }

  const { filter, target_category, dry_run = true, reset_tag_version = true } = body

  // Validate target category exists
  const catCheck = await c.env.DB.prepare(
    'SELECT slug FROM categories WHERE slug = ?'
  ).bind(target_category).first<{ slug: string }>()
  if (!catCheck) {
    return c.json({ error: `Target category '${target_category}' does not exist` }, 400)
  }

  // Build filter conditions
  const conditions: string[] = ["status != 'rejected'"]
  const binds: (string | number)[] = []

  if (filter.text_like) {
    conditions.push('text_lower LIKE ?')
    binds.push(filter.text_like.toLowerCase())
  }
  if (filter.current_category) {
    conditions.push('category_slug = ?')
    binds.push(filter.current_category)
  }
  if (filter.source) {
    conditions.push('source = ?')
    binds.push(filter.source)
  }
  if (filter.atom_ids?.length) {
    conditions.push(`id IN (${filter.atom_ids.map(() => '?').join(',')})`)
    binds.push(...filter.atom_ids)
  }

  // Require at least one real filter (beyond the status check)
  if (conditions.length <= 1) {
    return c.json({ error: 'At least one filter field required (text_like, current_category, source, or atom_ids)' }, 400)
  }

  const where = conditions.join(' AND ')

  // Count matching atoms
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM atoms WHERE ${where}`
  ).bind(...binds).first<{ cnt: number }>()
  const matchCount = countResult?.cnt ?? 0

  if (matchCount === 0) {
    return c.json({ dry_run, would_recategorize: 0, target_category, atoms: [] })
  }

  if (matchCount > RECATEGORIZE_LIMIT) {
    return c.json({
      error: `Filter matches ${matchCount} atoms, exceeding limit of ${RECATEGORIZE_LIMIT}. Narrow your filter.`,
      match_count: matchCount,
    }, 400)
  }

  // Warn if no current_category filter
  const warnings: string[] = []
  if (!filter.current_category) {
    warnings.push('No current_category filter: atoms across multiple categories may be affected')
  }

  // Fetch matching atoms
  const { results: atoms } = await c.env.DB.prepare(
    `SELECT id, text, text_lower, category_slug, source, source_app, collection_slug, tag_version
     FROM atoms WHERE ${where} LIMIT ?`
  ).bind(...binds, RECATEGORIZE_LIMIT).all<{
    id: string; text: string; text_lower: string; category_slug: string
    source: string; source_app: string | null; collection_slug: string; tag_version: number
  }>()

  if (dry_run) {
    return c.json({
      dry_run: true,
      would_recategorize: atoms.length,
      target_category,
      warnings: warnings.length > 0 ? warnings : undefined,
      atoms: atoms.map(a => ({
        id: a.id,
        text: a.text,
        current_category: a.category_slug,
        source: a.source,
        source_app: a.source_app,
        collection: a.collection_slug,
        tag_version: a.tag_version,
      })),
    })
  }

  // Execute recategorization
  const ids = atoms.map(a => a.id)

  // Chunk updates to stay under D1 binding limit
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80)
    const placeholders = chunk.map(() => '?').join(',')

    await d1WriteWithRetry(
      c.env.DB,
      `UPDATE atoms SET category_slug = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`,
      [target_category, ...chunk]
    )

    if (reset_tag_version) {
      await d1WriteWithRetry(
        c.env.DB,
        `UPDATE atoms SET tag_version = 0 WHERE id IN (${placeholders})`,
        chunk
      )
    }
  }

  return c.json({
    dry_run: false,
    recategorized: ids.length,
    target_category,
    tag_version_reset: reset_tag_version,
    atom_ids: ids,
  })
})

// --- POST /heal-drift ---
// Explicit ID-list drift heal for Phase 0 of the dimensional pilot.
// Distinct from /recategorize (filter-based) because the user has reviewed
// each atom individually and is assigning a specific target per atom.

adminApp.post('/heal-drift', async (c) => {
  const startMs = Date.now()
  const body = await c.req.json<{
    assignments: Array<{ atom_id: string; new_category_slug: string }>
    dry_run?: boolean
  }>().catch(() => null)

  if (!body || !Array.isArray(body.assignments) || body.assignments.length === 0) {
    return c.json({ error: 'Required: assignments (non-empty array of {atom_id, new_category_slug})' }, 400)
  }

  const { assignments, dry_run = true } = body

  if (assignments.length > RECATEGORIZE_LIMIT) {
    return c.json({
      error: `${assignments.length} assignments exceeds limit ${RECATEGORIZE_LIMIT}. Use /recategorize with a filter for bulk operations.`,
    }, 400)
  }

  // Validate shape of each assignment
  for (const a of assignments) {
    if (typeof a?.atom_id !== 'string' || typeof a?.new_category_slug !== 'string') {
      return c.json({ error: 'Each assignment requires atom_id (string) and new_category_slug (string)' }, 400)
    }
  }

  // Validate all target category slugs exist
  const uniqueSlugs = [...new Set(assignments.map(a => a.new_category_slug))]
  const slugPlaceholders = uniqueSlugs.map(() => '?').join(',')
  const { results: validSlugRows } = await c.env.DB.prepare(
    `SELECT slug FROM categories WHERE slug IN (${slugPlaceholders})`
  ).bind(...uniqueSlugs).all<{ slug: string }>()
  const validSlugs = new Set(validSlugRows.map(r => r.slug))

  // Validate all atom_ids exist; fetch current state for preview
  const uniqueIds = [...new Set(assignments.map(a => a.atom_id))]
  const atomsById = new Map<string, { id: string; text: string; category_slug: string | null }>()
  for (let i = 0; i < uniqueIds.length; i += 80) {
    const chunk = uniqueIds.slice(i, i + 80)
    const ph = chunk.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT id, text, category_slug FROM atoms WHERE id IN (${ph})`
    ).bind(...chunk).all<{ id: string; text: string; category_slug: string | null }>()
    for (const row of results) atomsById.set(row.id, row)
  }

  const preview: Array<{ atom_id: string; text: string; from: string | null; to: string }> = []
  const rejects: Array<{ atom_id: string; new_category_slug: string; reason: string }> = []

  for (const a of assignments) {
    if (!validSlugs.has(a.new_category_slug)) {
      rejects.push({ atom_id: a.atom_id, new_category_slug: a.new_category_slug, reason: 'invalid_category_slug' })
      continue
    }
    const atom = atomsById.get(a.atom_id)
    if (!atom) {
      rejects.push({ atom_id: a.atom_id, new_category_slug: a.new_category_slug, reason: 'atom_not_found' })
      continue
    }
    if (atom.category_slug === a.new_category_slug) {
      rejects.push({ atom_id: a.atom_id, new_category_slug: a.new_category_slug, reason: 'already_in_target_category' })
      continue
    }
    preview.push({ atom_id: a.atom_id, text: atom.text, from: atom.category_slug, to: a.new_category_slug })
  }

  if (dry_run) {
    return c.json({
      dry_run: true,
      would_heal: preview.length,
      rejects,
      preview,
    })
  }

  // Group by target category so each UPDATE hits one slug
  const byTarget = new Map<string, string[]>()
  for (const row of preview) {
    const arr = byTarget.get(row.to) ?? []
    arr.push(row.atom_id)
    byTarget.set(row.to, arr)
  }

  let chunks = 0
  for (const [target, ids] of byTarget) {
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80)
      const ph = chunk.map(() => '?').join(',')
      await d1WriteWithRetry(
        c.env.DB,
        `UPDATE atoms SET category_slug = ?, tag_version = 0, updated_at = datetime('now') WHERE id IN (${ph})`,
        [target, ...chunk]
      )
      chunks++
    }
  }

  return c.json({
    ok: true,
    healed: preview.length,
    rejected: rejects.length,
    chunks,
    duration_ms: Date.now() - startMs,
    rejects,
  })
})

// --- POST /duplicates ---

adminApp.post('/duplicates', async (c) => {
  const body = await c.req.json<{
    text_like?: string
    min_count?: number
    limit?: number
  }>().catch(() => ({} as Record<string, unknown>))

  const minCount = Math.max(Number(body.min_count) || 2, 2)
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500)

  // Step 1: Find duplicate text_lower values
  let groupSql = `SELECT text_lower, COUNT(*) as atom_count FROM atoms WHERE status != 'rejected'`
  const groupBinds: (string | number)[] = []

  if (body.text_like) {
    groupSql += ` AND text_lower LIKE ?`
    groupBinds.push(String(body.text_like).toLowerCase())
  }

  groupSql += ` GROUP BY text_lower HAVING COUNT(*) >= ? ORDER BY COUNT(*) DESC LIMIT ?`
  groupBinds.push(minCount, limit)

  const { results: dupGroups } = await c.env.DB.prepare(groupSql)
    .bind(...groupBinds).all<{ text_lower: string; atom_count: number }>()

  if (dupGroups.length === 0) {
    return c.json({ duplicate_groups: 0, groups: [] })
  }

  // Step 2: Fetch atoms for all groups
  const allTextLower = dupGroups.map(g => g.text_lower)
  const atomsByText = new Map<string, any[]>()

  for (let i = 0; i < allTextLower.length; i += 50) {
    const chunk = allTextLower.slice(i, i + 50)
    const placeholders = chunk.map(t => `'${t.replace(/'/g, "''")}'`).join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT id, text, text_lower, category_slug, source, source_app, collection_slug, status, tag_version, harmonics, register
       FROM atoms WHERE text_lower IN (${placeholders}) AND status != 'rejected' ORDER BY text_lower, status DESC, source ASC`
    ).all()

    for (const row of results) {
      const key = (row as any).text_lower
      if (!atomsByText.has(key)) atomsByText.set(key, [])
      atomsByText.get(key)!.push(row)
    }
  }

  // Step 3: Count correspondences per atom
  const allAtomIds = [...atomsByText.values()].flat().map((a: any) => a.id)
  const corrCounts = new Map<string, number>()

  for (let i = 0; i < allAtomIds.length; i += 50) {
    const chunk = allAtomIds.slice(i, i + 50)
    const placeholders = chunk.map((_: string) => '?').join(',')

    const { results: aCounts } = await c.env.DB.prepare(
      `SELECT atom_a_id as aid, COUNT(*) as cnt FROM correspondences WHERE atom_a_id IN (${placeholders}) GROUP BY atom_a_id`
    ).bind(...chunk).all<{ aid: string; cnt: number }>()

    const { results: bCounts } = await c.env.DB.prepare(
      `SELECT atom_b_id as aid, COUNT(*) as cnt FROM correspondences WHERE atom_b_id IN (${placeholders}) GROUP BY atom_b_id`
    ).bind(...chunk).all<{ aid: string; cnt: number }>()

    for (const r of aCounts) corrCounts.set(r.aid, (corrCounts.get(r.aid) || 0) + r.cnt)
    for (const r of bCounts) corrCounts.set(r.aid, (corrCounts.get(r.aid) || 0) + r.cnt)
  }

  // Step 4: Build response with canonical recommendations
  const groups = dupGroups.map(g => {
    const atoms = (atomsByText.get(g.text_lower) || []).map((a: any) => ({
      id: a.id,
      text: a.text,
      category: a.category_slug,
      source: a.source,
      source_app: a.source_app,
      collection: a.collection_slug,
      tag_version: a.tag_version,
      harmonics: a.harmonics ? (typeof a.harmonics === 'string' ? JSON.parse(a.harmonics) : a.harmonics) : null,
      register: a.register,
      correspondence_count: corrCounts.get(a.id) || 0,
    }))

    // Canonical heuristic
    const sorted = [...atoms].sort((a, b) => {
      // 1. confirmed > provisional
      if (a.source === 'manual' && b.source !== 'manual') return -1
      if (b.source === 'manual' && a.source !== 'manual') return 1
      // 2. more correspondences
      if (b.correspondence_count !== a.correspondence_count) return b.correspondence_count - a.correspondence_count
      // 3. higher tag_version
      if (b.tag_version !== a.tag_version) return b.tag_version - a.tag_version
      // 4. has register
      if (a.register != null && b.register == null) return -1
      if (b.register != null && a.register == null) return 1
      // 5. lower id (older)
      return a.id < b.id ? -1 : 1
    })

    return {
      text_lower: g.text_lower,
      atom_count: g.atom_count,
      atoms,
      recommended_canonical: sorted[0]?.id,
    }
  })

  return c.json({ duplicate_groups: groups.length, groups })
})

// --- POST /merge-atoms ---

const MERGE_MAX_IDS = 10

adminApp.post('/merge-atoms', async (c) => {
  const body = await c.req.json<{
    canonical_id: string
    merge_ids: string[]
    dry_run?: boolean
  }>().catch(() => null)

  if (!body || !body.canonical_id || !body.merge_ids?.length) {
    return c.json({ error: 'Required: canonical_id (string) and merge_ids (string[])' }, 400)
  }

  const { canonical_id, merge_ids, dry_run = true } = body

  if (merge_ids.length > MERGE_MAX_IDS) {
    return c.json({ error: `Maximum ${MERGE_MAX_IDS} merge_ids per request` }, 400)
  }

  if (merge_ids.includes(canonical_id)) {
    return c.json({ error: 'canonical_id must not be in merge_ids' }, 400)
  }

  // Validate canonical
  const canonical = await c.env.DB.prepare(
    'SELECT id, text, text_lower, category_slug, status FROM atoms WHERE id = ?'
  ).bind(canonical_id).first<{ id: string; text: string; text_lower: string; category_slug: string; status: string }>()

  if (!canonical) return c.json({ error: 'canonical_id not found' }, 404)
  if (canonical.status === 'rejected' || canonical.status === 'merged') {
    return c.json({ error: `canonical atom has status '${canonical.status}'` }, 400)
  }

  // Validate merge atoms
  const mergeAtoms: { id: string; text: string; text_lower: string; category_slug: string; status: string }[] = []
  for (const mid of merge_ids) {
    const atom = await c.env.DB.prepare(
      'SELECT id, text, text_lower, category_slug, status FROM atoms WHERE id = ?'
    ).bind(mid).first<{ id: string; text: string; text_lower: string; category_slug: string; status: string }>()

    if (!atom) return c.json({ error: `merge atom ${mid} not found` }, 404)
    if (atom.text_lower !== canonical.text_lower) {
      return c.json({ error: `merge atom ${mid} has text_lower '${atom.text_lower}', expected '${canonical.text_lower}'` }, 400)
    }
    if (atom.status === 'rejected' || atom.status === 'merged') {
      return c.json({ error: `merge atom ${mid} has status '${atom.status}'` }, 400)
    }
    mergeAtoms.push(atom)
  }

  // Count correspondences to transfer (for dry run reporting)
  let totalCorrespondences = 0
  let duplicateCorrespondences = 0

  for (const ma of mergeAtoms) {
    const { results: aCount } = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM correspondences WHERE atom_a_id = ?'
    ).bind(ma.id).all<{ cnt: number }>()
    const { results: bCount } = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM correspondences WHERE atom_b_id = ?'
    ).bind(ma.id).all<{ cnt: number }>()
    totalCorrespondences += (aCount[0]?.cnt || 0) + (bCount[0]?.cnt || 0)
  }

  if (dry_run) {
    return c.json({
      dry_run: true,
      canonical: { id: canonical.id, text: canonical.text, category: canonical.category_slug },
      merging: mergeAtoms.map(a => ({
        id: a.id, text: a.text, category: a.category_slug,
      })),
      total_correspondences_to_process: totalCorrespondences,
    })
  }

  // Execute merge
  let correspondencesTransferred = 0
  let correspondencesRemoved = 0

  try {
  for (const ma of mergeAtoms) {
    // Delete self-referencing correspondences (canonical <-> merge atom)
    await c.env.DB.prepare('DELETE FROM correspondences WHERE atom_a_id = ? AND atom_b_id = ?')
      .bind(canonical_id, ma.id).run()
    await c.env.DB.prepare('DELETE FROM correspondences WHERE atom_a_id = ? AND atom_b_id = ?')
      .bind(ma.id, canonical_id).run()

    // Transfer atom_a_id references (UPDATE OR IGNORE skips conflicts)
    const aTransfer = await c.env.DB.prepare(
      'UPDATE OR IGNORE correspondences SET atom_a_id = ? WHERE atom_a_id = ?'
    ).bind(canonical_id, ma.id).run()
    correspondencesTransferred += aTransfer.meta.changes

    // Delete remaining untransferred (conflicts)
    const aCleanup = await c.env.DB.prepare(
      'DELETE FROM correspondences WHERE atom_a_id = ?'
    ).bind(ma.id).run()
    correspondencesRemoved += aCleanup.meta.changes

    // Transfer atom_b_id references
    const bTransfer = await c.env.DB.prepare(
      'UPDATE OR IGNORE correspondences SET atom_b_id = ? WHERE atom_b_id = ?'
    ).bind(canonical_id, ma.id).run()
    correspondencesTransferred += bTransfer.meta.changes

    // Delete remaining untransferred
    const bCleanup = await c.env.DB.prepare(
      'DELETE FROM correspondences WHERE atom_b_id = ?'
    ).bind(ma.id).run()
    correspondencesRemoved += bCleanup.meta.changes

    // Mark as merged: use status='rejected' (CHECK constraint prevents 'merged') + metadata for audit trail
    await c.env.DB.prepare(
      `UPDATE atoms SET status = 'rejected', metadata = json_set(COALESCE(metadata, '{}'), '$.merged_into', ?, '$.merge_reason', 'duplicate'), updated_at = datetime('now') WHERE id = ?`
    ).bind(canonical_id, ma.id).run()
  }

  // Reset canonical tag_version for retagging
  await c.env.DB.prepare(
    "UPDATE atoms SET tag_version = 0, updated_at = datetime('now') WHERE id = ?"
  ).bind(canonical_id).run()

  return c.json({
    dry_run: false,
    canonical_id,
    merged_ids: merge_ids,
    correspondences_transferred: correspondencesTransferred,
    correspondences_removed: correspondencesRemoved,
    atoms_marked_merged: mergeAtoms.length,
    tag_version_reset: true,
  })
  } catch (err) {
    return c.json({ error: 'Merge execution failed', detail: String(err) }, 500)
  }
})

// --- GET /daily-review ---
// Returns the latest daily review from R2. Optional ?date=YYYY-MM-DD for specific date.

adminApp.get('/daily-review', async (c) => {
  if (!c.env.R2) {
    return c.json({ error: 'R2 binding not configured' }, 503)
  }
  const date = c.req.query('date') || new Date().toISOString().split('T')[0]
  const key = `grimoire/reviews/${date}.md`
  const obj = await c.env.R2.get(key)
  if (!obj) {
    return c.json({ error: 'No review found for this date', date, key }, 404)
  }
  const text = await obj.text()
  return c.text(text)
})

// --- POST /atoms/force-create ---
// Curator-asserted atom creation. Bypasses routeContent + qualityGate.
// Use for manifest-driven ingestion where generic single-word terms (body
// adjectives, lighting descriptors, etc.) would be rejected by the specificity
// gate but the curator has validated them offline.
//
// Atoms land with explicit category_slug and status='confirmed'. No harmonics
// or embedding populated inline -- cron Phase 3 enriches harmonics, Phase 2
// vectorizes, Phase 4 retags. Batched insertion honors the UNIQUE(text_lower,
// collection_slug) constraint, so polysemous terms (e.g. body-reading of a
// word that already exists in a non-body collection) succeed under a distinct
// collection derived from the asserted category.

const FORCE_CREATE_LIMIT = 200

// Allowlist for the 5-dim harmonics JSON. Mirrors HARMONIC_DIMENSIONS used by
// classifyAtom. Register is a separate top-level column (atoms.register),
// populated by Phase 5; not included here and rejected if supplied.
const VALID_HARMONIC_KEYS = new Set([
  'weight', 'hardness', 'temperature', 'formality', 'era_affinity',
])

interface ForceCreateAtom {
  text: string
  category_slug: string
  source_app?: string
  context?: string
  harmonics?: Record<string, number>
}

interface HarmonicsValidation {
  ok: boolean
  reason?: string
}

function validateHarmonicsOverride(h: unknown): HarmonicsValidation {
  if (typeof h !== 'object' || h === null || Array.isArray(h)) {
    return { ok: false, reason: 'harmonics_must_be_object' }
  }
  const entries = Object.entries(h as Record<string, unknown>)
  if (entries.length === 0) {
    return { ok: false, reason: 'harmonics_empty' }
  }
  for (const [key, val] of entries) {
    if (!VALID_HARMONIC_KEYS.has(key)) {
      return { ok: false, reason: `invalid_harmonic_key: ${key}` }
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { ok: false, reason: `non_numeric_value: ${key}` }
    }
    if (val < 0 || val > 1) {
      return { ok: false, reason: `out_of_range: ${key}=${val}` }
    }
  }
  return { ok: true }
}

adminApp.post('/atoms/force-create', async (c) => {
  const startMs = Date.now()
  const body = await c.req.json<{
    atoms: ForceCreateAtom[]
    dry_run?: boolean
  }>().catch(() => null)

  if (!body || !Array.isArray(body.atoms) || body.atoms.length === 0) {
    return c.json({ error: 'Required: atoms (non-empty array of {text, category_slug, source_app?, context?, harmonics?})' }, 400)
  }
  if (body.atoms.length > FORCE_CREATE_LIMIT) {
    return c.json({
      error: `${body.atoms.length} atoms exceeds limit ${FORCE_CREATE_LIMIT}. Split into smaller batches.`,
    }, 400)
  }

  const dry_run = body.dry_run ?? true

  // Shape validation + harmonics override validation (request-level reject on
  // bad harmonics: a malformed override is a curator programming error, not
  // an atom-level condition to report alongside successes).
  for (let i = 0; i < body.atoms.length; i++) {
    const a = body.atoms[i]
    if (typeof a?.text !== 'string' || !a.text.trim()) {
      return c.json({ error: 'Each atom requires text (non-empty string)' }, 400)
    }
    if (typeof a?.category_slug !== 'string' || !a.category_slug) {
      return c.json({ error: 'Each atom requires category_slug (string)' }, 400)
    }
    if (a.harmonics !== undefined) {
      const check = validateHarmonicsOverride(a.harmonics)
      if (!check.ok) {
        return c.json({
          error: `atoms[${i}].harmonics: ${check.reason}`,
          text: a.text,
        }, 400)
      }
    }
  }

  // Validate category slugs exist
  const uniqueSlugs = [...new Set(body.atoms.map(a => a.category_slug))]
  const ph = uniqueSlugs.map(() => '?').join(',')
  const { results: validSlugRows } = await c.env.DB.prepare(
    `SELECT slug FROM categories WHERE slug IN (${ph})`
  ).bind(...uniqueSlugs).all<{ slug: string }>()
  const validSlugs = new Set(validSlugRows.map(r => r.slug))

  interface ForceCreateReject {
    text: string
    category_slug: string
    reason: string
  }
  interface ForceCreatePreview {
    text: string
    text_lower: string
    category_slug: string
    collection_slug: string
    source_app: string
    context?: string
    harmonics?: Record<string, number>
  }

  const rejects: ForceCreateReject[] = []
  const preview: ForceCreatePreview[] = []
  const seenInBatch = new Set<string>() // dedupe within the request

  for (const a of body.atoms) {
    const trimmed = a.text.trim()
    const textLower = trimmed.toLowerCase()
    if (!validSlugs.has(a.category_slug)) {
      rejects.push({ text: trimmed, category_slug: a.category_slug, reason: 'invalid_category_slug' })
      continue
    }
    const collection_slug = collectionFromCategory(a.category_slug)
    const dupeKey = `${textLower}::${collection_slug}`
    if (seenInBatch.has(dupeKey)) {
      rejects.push({ text: trimmed, category_slug: a.category_slug, reason: 'duplicate_in_request' })
      continue
    }
    seenInBatch.add(dupeKey)
    preview.push({
      text: trimmed,
      text_lower: textLower,
      category_slug: a.category_slug,
      collection_slug,
      source_app: a.source_app ?? 'curator',
      ...(a.context ? { context: a.context } : {}),
      ...(a.harmonics ? { harmonics: a.harmonics } : {}),
    })
  }

  if (dry_run) {
    return c.json({
      dry_run: true,
      would_create: preview.length,
      rejects,
      preview,
    })
  }

  // Execute: createAtom per entry. Catches UNIQUE(text_lower, collection_slug)
  // conflicts per-atom so one collision doesn't abort the batch.
  interface ForceCreateCreated {
    atom_id: string
    text: string
    text_lower: string
    category_slug: string
    collection_slug: string
    harmonics_source: 'override' | 'pending_phase_3'
  }
  const created: ForceCreateCreated[] = []

  for (const p of preview) {
    const input: CreateAtomInput = {
      text: p.text,
      collection_slug: p.collection_slug,
      category_slug: p.category_slug,
      source: 'manual',
      source_app: p.source_app,
      status: 'confirmed',
      confidence: 1.0,
      observation: 'observation',
      modality: 'visual',
      utility: 'visual',
      // If curator supplied harmonics, write them directly so Phase 3 skips
      // this atom (its WHERE clause treats populated harmonics as done).
      // Otherwise leave empty and let Phase 3 classify + enrich.
      ...(p.harmonics ? { harmonics: JSON.stringify(p.harmonics) } : {}),
      metadata: p.context ? { context: p.context } : {},
    }
    try {
      const atom = await createAtom(c.env.DB, input)
      if (c.env.CONNECTIVITY_KV) {
        enqueueForConnectivity(c.env.CONNECTIVITY_KV, atom.id).catch(() => {})
      }
      created.push({
        atom_id: atom.id,
        text: atom.text,
        text_lower: atom.text_lower,
        category_slug: atom.category_slug ?? p.category_slug,
        collection_slug: atom.collection_slug,
        harmonics_source: p.harmonics ? 'override' : 'pending_phase_3',
      })
    } catch (err) {
      const msg = (err as Error).message ?? 'insert_failed'
      const reason = msg.includes('UNIQUE') ? 'unique_conflict' : `insert_failed: ${msg.slice(0, 200)}`
      rejects.push({ text: p.text, category_slug: p.category_slug, reason })
    }
  }

  return c.json({
    ok: true,
    created: created.length,
    rejected: rejects.length,
    created_atoms: created,
    rejects,
    duration_ms: Date.now() - startMs,
  })
})

// --- POST /wildcard-bootstrap/apply ---
// Receives one stage of a wildcard manifest at a time. See wildcard-bootstrap.ts.
adminApp.post('/wildcard-bootstrap/apply', async (c) => {
  try {
    const body = await c.req.json<WildcardApplyRequest>()
    const result = await applyWildcardBootstrap(c.env, body)
    return c.json(result)
  } catch (err) {
    if (err instanceof WildcardApplyError) return c.json({ error: err.message }, err.status as 400 | 500)
    console.error('[wildcard-bootstrap/apply] failed:', err)
    return c.json({ error: 'wildcard bootstrap apply failed', detail: (err as Error).message }, 500)
  }
})

export { adminApp }
