// Process RSS feed entries flagged by hobbot-custodian (ingested=0, high relevance)
// Rewritten for pipeline worker: uses adapter + pipeline pattern instead of ingestKnowledge()

import { fromFeedEntry } from '../adapters/from-feed-entry'
import { runKnowledgePipeline } from '../pipeline/run'

interface RssIngestEnv {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  GRIMOIRE: Fetcher
  AI: Ai
  GEMINI_API_KEY: string | { get: () => Promise<string> }
}

interface PendingEntry {
  id: number
  source_id: string
  entry_url: string
  entry_title: string
  mime_type?: string
  metadata?: string
  knowledge_request_id?: number
}

export async function processRssIngestQueue(
  env: RssIngestEnv,
): Promise<{ processed: number; failed: number }> {
  const { results: pending } = await env.HOBBOT_DB.prepare(
    `SELECT rowid as id, source_id, entry_url, entry_title, mime_type, metadata, knowledge_request_id
     FROM feed_entries
     WHERE ingested = 0
       AND relevance_score >= 0.5
       AND extraction_status = 'pending'
     LIMIT 20`
  ).all<PendingEntry>()

  if (!pending || pending.length === 0) {
    return { processed: 0, failed: 0 }
  }

  let processed = 0
  let failed = 0

  for (const entry of pending) {
    // Mark as processing (prevents infinite retry on crash)
    await env.HOBBOT_DB.prepare(
      "UPDATE feed_entries SET extraction_status = 'processing' WHERE source_id = ? AND entry_url = ?"
    ).bind(entry.source_id, entry.entry_url).run()

    try {
      const adapterResult = await fromFeedEntry(env, entry)

      if (adapterResult.already_ingested) {
        // URL already processed, mark as complete
        await env.HOBBOT_DB.prepare(
          `UPDATE feed_entries
           SET ingested = 1, ingested_at = datetime('now'), extraction_status = 'complete'
           WHERE source_id = ? AND entry_url = ?`
        ).bind(entry.source_id, entry.entry_url).run()
        processed++
        continue
      }

      if (!adapterResult.doc) {
        throw new Error('adapter returned no document')
      }

      const result = await runKnowledgePipeline(env, adapterResult.doc, {
        logId: adapterResult.logId,
        sourceId: adapterResult.sourceId,
        documentId: adapterResult.documentId,
      })

      await env.HOBBOT_DB.prepare(
        `UPDATE feed_entries
         SET ingested = 1, ingested_at = datetime('now'),
             extraction_status = 'complete', grimoire_source_id = ?
         WHERE source_id = ? AND entry_url = ?`
      ).bind(result.document_id ?? null, entry.source_id, entry.entry_url).run()
      processed++
    } catch (e) {
      console.warn(`[rss-ingest] failed for ${entry.entry_url}: ${e instanceof Error ? e.message : e}`)
      await env.HOBBOT_DB.prepare(
        "UPDATE feed_entries SET extraction_status = 'failed' WHERE source_id = ? AND entry_url = ?"
      ).bind(entry.source_id, entry.entry_url).run()
      failed++
    }
  }

  return { processed, failed }
}
