// SQL layer for chat tables: users, conversations, messages, feedback
// All database operations for authenticated conversation persistence

// ---- Grimoire summary (for dynamic system prompt) ----

export async function getGrimoireSummary(
  db: D1Database,
): Promise<{ atoms: number; documents: number }> {
  const [atoms, docs] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as cnt FROM atoms WHERE status = 'confirmed'`).first<{ cnt: number }>(),
    db.prepare(`SELECT COUNT(*) as cnt FROM documents`).first<{ cnt: number }>(),
  ])
  return { atoms: atoms?.cnt ?? 0, documents: docs?.cnt ?? 0 }
}

import type {
  ChatConversation, ChatMessage, ChatFeedback,
  MessageRow,
} from '../chat/types'
import { messageFromRow } from '../chat/types'

// ---- Conversations ----

export async function createConversation(
  db: D1Database, userId: string, title?: string,
): Promise<ChatConversation> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, userId, title ?? null, now, now).run()
  return { id, user_id: userId, title: title ?? null, created_at: now, updated_at: now }
}

export async function listConversations(
  db: D1Database, userId: string, limit = 50,
): Promise<ChatConversation[]> {
  const result = await db.prepare(
    `SELECT id, user_id, title, created_at, updated_at
     FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
  ).bind(userId, limit).all<ChatConversation>()
  return result.results ?? []
}

export async function getConversation(
  db: D1Database, conversationId: string, userId: string,
): Promise<{ conversation: ChatConversation; messages: ChatMessage[] } | null> {
  const conv = await db.prepare(
    `SELECT id, user_id, title, created_at, updated_at
     FROM conversations WHERE id = ? AND user_id = ?`
  ).bind(conversationId, userId).first<ChatConversation>()
  if (!conv) return null

  const msgs = await db.prepare(
    `SELECT id, conversation_id, role, content, provider, agent_id,
            grimoire_refs, structured_data, created_at
     FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
  ).bind(conversationId).all<MessageRow>()

  return {
    conversation: conv,
    messages: (msgs.results ?? []).map(messageFromRow),
  }
}

export async function updateConversationTitle(
  db: D1Database, conversationId: string, title: string,
): Promise<void> {
  await db.prepare(
    `UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(title, conversationId).run()
}

// ---- Messages ----

export async function addMessage(
  db: D1Database,
  msg: Omit<ChatMessage, 'created_at'>,
): Promise<ChatMessage> {
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, provider, agent_id, grimoire_refs, structured_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    msg.id,
    msg.conversation_id,
    msg.role,
    msg.content,
    msg.provider ?? null,
    msg.agent_id ?? null,
    JSON.stringify(msg.grimoire_refs),
    JSON.stringify(msg.structured_data),
    now,
  ).run()

  // Update conversation timestamp
  await db.prepare(
    `UPDATE conversations SET updated_at = ? WHERE id = ?`
  ).bind(now, msg.conversation_id).run()

  return { ...msg, created_at: now }
}

// ---- Feedback ----

export async function addFeedback(
  db: D1Database,
  fb: Omit<ChatFeedback, 'created_at'>,
): Promise<ChatFeedback> {
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO feedback (id, user_id, message_id, signal, grimoire_refs, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(fb.id, fb.user_id, fb.message_id, fb.signal, JSON.stringify(fb.grimoire_refs), now).run()
  return { ...fb, created_at: now }
}

// ---- Delete ----

export async function deleteConversation(
  db: D1Database, conversationId: string, userId: string,
): Promise<boolean> {
  const conv = await db.prepare(
    `SELECT id FROM conversations WHERE id = ? AND user_id = ?`
  ).bind(conversationId, userId).first()
  if (!conv) return false

  // Collect message IDs for feedback cleanup
  const msgs = await db.prepare(
    `SELECT id FROM messages WHERE conversation_id = ?`
  ).bind(conversationId).all<{ id: string }>()
  const msgIds = msgs.results?.map(r => r.id) ?? []

  // Delete in FK order: feedback -> messages -> conversation
  if (msgIds.length > 0) {
    const ph = msgIds.map(() => '?').join(',')
    await db.prepare(`DELETE FROM feedback WHERE message_id IN (${ph})`).bind(...msgIds).run()
  }
  await db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).bind(conversationId).run()
  await db.prepare(`DELETE FROM conversations WHERE id = ?`).bind(conversationId).run()
  return true
}

// ---- Counts (for quota enforcement) ----

export async function countConversations(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ?`
  ).bind(userId).first<{ cnt: number }>()
  return row?.cnt ?? 0
}

export async function countMessages(db: D1Database, conversationId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?`
  ).bind(conversationId).first<{ cnt: number }>()
  return row?.cnt ?? 0
}

// ---- Purge (stale anonymous sessions) ----

export async function purgeOldSessions(
  db: D1Database, retentionDays: number,
): Promise<{ users: number; conversations: number; messages: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
  let totalMessages = 0, totalConversations = 0, totalUsers = 0

  // Process in chunks of 100 to stay within D1 CPU limits
  while (true) {
    const stale = await db.prepare(`
      SELECT c.id FROM conversations c
      JOIN users u ON c.user_id = u.id
      WHERE u.email LIKE '%@session.hob.farm'
      AND c.updated_at < ?
      LIMIT 100
    `).bind(cutoff).all<{ id: string }>()

    const convIds = stale.results?.map(r => r.id) ?? []
    if (convIds.length === 0) break

    const convPh = convIds.map(() => '?').join(',')

    // 1. Collect message IDs before deleting anything
    const msgRows = await db.prepare(
      `SELECT id FROM messages WHERE conversation_id IN (${convPh})`
    ).bind(...convIds).all<{ id: string }>()
    const msgIds = msgRows.results?.map(r => r.id) ?? []

    // 2. Delete feedback first (references message_id FK)
    if (msgIds.length > 0) {
      const msgPh = msgIds.map(() => '?').join(',')
      await db.prepare(
        `DELETE FROM feedback WHERE message_id IN (${msgPh})`
      ).bind(...msgIds).run()
    }

    // 3. Delete messages
    const msgs = await db.prepare(
      `DELETE FROM messages WHERE conversation_id IN (${convPh})`
    ).bind(...convIds).run()
    totalMessages += msgs.meta?.changes ?? 0

    // 4. Delete conversations
    const convs = await db.prepare(
      `DELETE FROM conversations WHERE id IN (${convPh})`
    ).bind(...convIds).run()
    totalConversations += convs.meta?.changes ?? 0
  }

  // Final: delete orphaned session users (no remaining conversations)
  const users = await db.prepare(`
    DELETE FROM users WHERE email LIKE '%@session.hob.farm'
    AND id NOT IN (SELECT DISTINCT user_id FROM conversations)
  `).run()
  totalUsers += users.meta?.changes ?? 0

  return { users: totalUsers, conversations: totalConversations, messages: totalMessages }
}

// Returns user_id of the message owner (via conversation join) for ownership check
export async function getMessageOwner(
  db: D1Database, messageId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT c.user_id FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     WHERE m.id = ?`
  ).bind(messageId).first<{ user_id: string }>()
  return row?.user_id ?? null
}
