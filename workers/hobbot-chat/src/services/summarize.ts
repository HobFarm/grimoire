// BART-powered conversation summarization.
// Replaces hard truncation: when a conversation exceeds SUMMARIZE_THRESHOLD messages,
// the oldest messages are compressed into a single summary via BART.
// Progressive enhancement: if BART fails, falls back to existing truncation.

import { CHAT } from '@shared/config'
import { createLogger } from '@shared/logger'

const log = createLogger('hobbot-chat')

const SUMMARY_MARKER = 'bart-summary'

interface MessageRow {
  id: string
  role: string
  content: string
  agent_id: string | null
  created_at: string
}

/**
 * Summarize old messages in a conversation if the count exceeds the threshold.
 * Non-fatal: any failure logs and returns without modifying messages.
 *
 * Operation order for data safety: INSERT summary first, THEN delete old messages.
 * If crash between the two, next request sees redundant data (self-healing).
 */
export async function maybeSummarize(
  db: D1Database,
  ai: Ai,
  conversationId: string,
): Promise<void> {
  // Fast path: single count query, most requests exit here
  const countRow = await db.prepare(
    'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?'
  ).bind(conversationId).first<{ cnt: number }>()

  if (!countRow || countRow.cnt <= CHAT.SUMMARIZE_THRESHOLD) return

  // Load all messages for partitioning
  const { results: allMessages } = await db.prepare(
    `SELECT id, role, content, agent_id, created_at
     FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
  ).bind(conversationId).all<MessageRow>()

  if (!allMessages || allMessages.length === 0) return

  // Partition: existing summary (at most one) vs conversation messages
  const existingSummary = allMessages.find(m => m.agent_id === SUMMARY_MARKER)
  const conversationMsgs = allMessages.filter(m => m.role === 'user' || m.role === 'assistant')

  if (conversationMsgs.length <= CHAT.SUMMARIZE_KEEP_RECENT) return

  const toSummarize = conversationMsgs.slice(0, -CHAT.SUMMARIZE_KEEP_RECENT)
  const toKeep = conversationMsgs.slice(-CHAT.SUMMARIZE_KEEP_RECENT)

  // Build BART input
  let inputText = ''

  // Fold existing summary into input (compound summaries across multiple triggers)
  if (existingSummary) {
    inputText += `Previous context: ${existingSummary.content}\n\n`
  }

  // Concatenate messages to summarize
  for (const m of toSummarize) {
    const role = m.role === 'user' ? 'User' : 'Assistant'
    inputText += `${role}: ${m.content}\n`
  }

  // Truncate from START if too long (keep most recent of the batch, drop oldest)
  if (inputText.length > CHAT.SUMMARIZE_MAX_INPUT_CHARS) {
    inputText = inputText.slice(-CHAT.SUMMARIZE_MAX_INPUT_CHARS)
  }

  // Call BART
  let summaryText: string
  try {
    const result = await ai.run('@cf/facebook/bart-large-cnn' as any, {
      input_text: inputText,
      max_length: 256,
    }) as { summary: string }

    if (!result?.summary || typeof result.summary !== 'string' || result.summary.trim().length === 0) {
      log.warn('BART returned empty summary, skipping', { conversationId })
      return
    }
    summaryText = result.summary.trim()
  } catch (e) {
    log.warn('BART summarization failed, falling back to truncation', {
      conversationId,
      error: e instanceof Error ? e.message : String(e),
    })
    return
  }

  // Compute created_at: 1ms before the oldest kept message (sorts summary just before recent messages)
  const oldestKeptTime = new Date(toKeep[0].created_at).getTime()
  const summaryCreatedAt = new Date(oldestKeptTime - 1).toISOString()

  // INSERT summary first (data safety: redundant data > lost data)
  const summaryId = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, provider, agent_id, grimoire_refs, structured_data, created_at)
     VALUES (?, ?, 'system', ?, null, ?, '[]', '{}', ?)`
  ).bind(summaryId, conversationId, summaryText, SUMMARY_MARKER, summaryCreatedAt).run()

  // THEN delete summarized messages + existing summary
  const idsToDelete = toSummarize.map(m => m.id)
  if (existingSummary) idsToDelete.push(existingSummary.id)

  for (let i = 0; i < idsToDelete.length; i += 80) {
    const chunk = idsToDelete.slice(i, i + 80)
    const ph = chunk.map(() => '?').join(',')
    // Delete feedback FK children first, then messages
    await db.prepare(`DELETE FROM feedback WHERE message_id IN (${ph})`).bind(...chunk).run()
    await db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).bind(...chunk).run()
  }

  log.info('conversation summarized', {
    conversationId,
    messagesSummarized: toSummarize.length,
    summaryLength: summaryText.length,
    hadExistingSummary: !!existingSummary,
  })
}
