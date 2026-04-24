// Phase 5: write draft to D1 (no GitHub commit)

import type { BlogQueueRow, ComposeOutput, EnrichResult, DraftResult } from './types'

export async function saveDraft(
  queueRow: BlogQueueRow,
  output: ComposeOutput,
  enrich: EnrichResult,
  db: D1Database
): Promise<DraftResult> {
  const result = await db
    .prepare(`
      INSERT INTO blog_posts
        (queue_id, title, slug, excerpt, body_md, tags, category, channel, arrangement, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'), datetime('now'))
    `)
    .bind(
      queueRow.id,
      output.title,
      output.slug,
      output.excerpt,
      output.body_md,
      JSON.stringify(output.tags),
      queueRow.category,
      queueRow.channel,
      enrich.arrangement ?? null
    )
    .run()

  const postId = result.meta.last_row_id as number
  return { postId, slug: output.slug }
}
