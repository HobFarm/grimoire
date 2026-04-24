// Blog content pipeline orchestrator
// Phases: source → enrich → compose → validate → draft
// GitHub commit happens separately at promote time (publish.ts)

import { resolveSource } from './source'
import { enrichSource } from './enrich'
import { composePost } from './compose'
import { validatePost } from './validate'
import { saveDraft } from './draft'
import { resolveApiKey, createTokenLogger } from '@shared/providers'
import type { Env } from '../index'
import type { BlogQueueRow, BlogChannel, PipelineResult, PhaseTimings } from './types'

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now()
  const result = await fn()
  return { result, ms: Date.now() - start }
}

async function setQueueStatus(
  db: D1Database,
  id: number,
  status: string,
  error: string | null = null
): Promise<void> {
  await db
    .prepare(
      `UPDATE blog_queue SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(status, error, id)
    .run()
}

export async function runBlogPipeline(
  env: Env,
  channel: BlogChannel = 'blog'
): Promise<PipelineResult> {
  const pipelineStart = Date.now()

  // Pick the oldest queued item for this channel
  const row = await env.HOBBOT_DB
    .prepare(`
      SELECT * FROM blog_queue
      WHERE status = 'queued'
        AND channel = ?
        AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
      ORDER BY scheduled_at ASC
      LIMIT 1
    `)
    .bind(channel)
    .first<BlogQueueRow>()

  if (!row) {
    return { success: true, noop: true, timings: {} }
  }

  await setQueueStatus(env.HOBBOT_DB, row.id, 'generating')

  const timings: Partial<PhaseTimings> = {}

  try {
    const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)

    const { result: source, ms: source_ms } = await timed(() =>
      resolveSource(row, env.HOBBOT_DB, env.GRIMOIRE_DB)
    )
    timings.source_ms = source_ms

    const { result: enrich, ms: enrich_ms } = await timed(() =>
      enrichSource(source, env.GRIMOIRE_DB)
    )
    timings.enrich_ms = enrich_ms

    const { result: composed, ms: compose_ms } = await timed(() =>
      composePost(source, enrich, env.AI, geminiKey, createTokenLogger(env.HOBBOT_DB, 'hobbot-pipeline'))
    )
    timings.compose_ms = compose_ms

    const { result: validation, ms: validate_ms } = await timed(async () =>
      validatePost(composed)
    )
    timings.validate_ms = validate_ms

    if (!validation.valid) {
      const errMsg = `validation failed: ${validation.errors.join('; ')}`
      await setQueueStatus(env.HOBBOT_DB, row.id, 'failed', errMsg)
      timings.total_ms = Date.now() - pipelineStart
      return { success: false, queueId: row.id, error: errMsg, timings }
    }

    const { result: draft, ms: draft_ms } = await timed(() =>
      saveDraft(row, composed, enrich, env.HOBBOT_DB)
    )
    timings.draft_ms = draft_ms
    timings.total_ms = Date.now() - pipelineStart

    // Queue row moves to 'published' state (draft in blog_posts, queue item consumed)
    await setQueueStatus(env.HOBBOT_DB, row.id, 'published')

    console.log(
      `[blog] pipeline complete: queueId=${row.id} postId=${draft.postId} slug=${draft.slug} ` +
      `source=${timings.source_ms}ms enrich=${timings.enrich_ms}ms compose=${timings.compose_ms}ms ` +
      `validate=${timings.validate_ms}ms draft=${timings.draft_ms}ms total=${timings.total_ms}ms`
    )

    return { success: true, queueId: row.id, slug: draft.slug, timings }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    timings.total_ms = Date.now() - pipelineStart
    await setQueueStatus(env.HOBBOT_DB, row.id, 'failed', errMsg)
    console.error(`[blog] pipeline failed: queueId=${row.id} error=${errMsg}`)
    return { success: false, queueId: row.id, error: errMsg, timings }
  }
}
