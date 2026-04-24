// Chat types for authenticated conversation persistence

import { safeJson } from '@shared/grimoire/types'

export type ChatProvider = 'workers-ai' | 'dashscope'

export interface ChatUser {
  id: string
  email: string
  role: string
  display_name: string | null
  created_at: string
}

export interface ChatConversation {
  id: string
  user_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  provider: string | null
  agent_id: string | null
  grimoire_refs: string[]
  structured_data: Record<string, unknown>
  created_at: string
}

export interface ChatFeedback {
  id: string
  user_id: string
  message_id: string
  signal: 1 | -1
  grimoire_refs: string[]
  created_at: string
}

export interface ChatContext {
  userId: string
  email: string
}

// D1 row shapes (JSON fields as TEXT)

export interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  provider: string | null
  agent_id: string | null
  grimoire_refs: string | null
  structured_data: string | null
  created_at: string
}

export interface FeedbackRow {
  id: string
  user_id: string
  message_id: string
  signal: number
  grimoire_refs: string | null
  created_at: string
}

export function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    provider: row.provider,
    agent_id: row.agent_id,
    grimoire_refs: safeJson(row.grimoire_refs, []),
    structured_data: safeJson(row.structured_data, {}),
    created_at: row.created_at,
  }
}

export function feedbackFromRow(row: FeedbackRow): ChatFeedback {
  return {
    id: row.id,
    user_id: row.user_id,
    message_id: row.message_id,
    signal: row.signal as 1 | -1,
    grimoire_refs: safeJson(row.grimoire_refs, []),
    created_at: row.created_at,
  }
}
