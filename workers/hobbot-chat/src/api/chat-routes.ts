// Chat API route handler
// Session cookie auth with rate limiting, input validation, and per-session quotas

import { getOrCreateSession } from './session-auth'
import type { SessionResult } from './session-auth'
import {
  createConversation, listConversations, getConversation, deleteConversation,
  addMessage, addFeedback, getMessageOwner, updateConversationTitle,
  countConversations, countMessages,
} from '../state/chat'
import { streamChatResponse } from '../services/chat'
import { maybeSummarize } from '../services/summarize'
import { CHAT } from '@shared/config'
import type { ChatContext, ChatProvider } from '../chat/types'

// --- Limits ---
const MAX_MESSAGE_LENGTH = 4000
const MAX_TITLE_LENGTH = 200
const MAX_LIST_LIMIT = 50
const MAX_CONVERSATIONS_PER_SESSION = 20
const MAX_MESSAGES_PER_CONVERSATION = 100

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function err(message: string, code: number): Response {
  return json({ error: message, code }, code)
}

async function authenticate(request: Request, env: Env): Promise<{ ctx: ChatContext; setCookie: string | null } | Response> {
  try {
    const result: SessionResult = await getOrCreateSession(request, env)
    if (result.rateLimited) return err('too many requests', 429)
    return result
  } catch (e) {
    console.log(`[session] auth error: ${e instanceof Error ? e.message : e}`)
    return err('session error', 500)
  }
}

function withCookie(response: Response, setCookie: string | null): Response {
  if (!setCookie) return response
  const headers = new Headers(response.headers)
  headers.set('Set-Cookie', setCookie)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const segments = path.split('/').filter(Boolean) // ['api', 'chat', ...]

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  // POST /api/chat/conversations
  if (path === '/api/chat/conversations' && request.method === 'POST') {
    const auth = await authenticate(request, env)
    if (auth instanceof Response) return auth
    const { ctx, setCookie } = auth

    // Quota: max conversations per session
    const convCount = await countConversations(env.HOBBOT_DB, ctx.userId)
    if (convCount >= MAX_CONVERSATIONS_PER_SESSION) {
      return withCookie(err('conversation limit reached', 429), setCookie)
    }

    let body: Record<string, unknown> = {}
    try { body = await request.json() as Record<string, unknown> } catch { /* empty body ok */ }

    const rawTitle = typeof body.title === 'string' ? body.title : undefined
    const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_LENGTH) : undefined
    const conversation = await createConversation(env.HOBBOT_DB, ctx.userId, title)
    return withCookie(json(conversation, 201), setCookie)
  }

  // GET /api/chat/conversations
  if (path === '/api/chat/conversations' && request.method === 'GET') {
    const auth = await authenticate(request, env)
    if (auth instanceof Response) return auth
    const { ctx, setCookie } = auth

    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') ?? '50')), MAX_LIST_LIMIT)
    const conversations = await listConversations(env.HOBBOT_DB, ctx.userId, limit)
    return withCookie(json(conversations), setCookie)
  }

  // GET /api/chat/conversations/:id
  if (segments[0] === 'api' && segments[1] === 'chat' && segments[2] === 'conversations' && segments[3] && !segments[4] && request.method === 'GET') {
    const auth = await authenticate(request, env)
    if (auth instanceof Response) return auth
    const { ctx, setCookie } = auth

    const result = await getConversation(env.HOBBOT_DB, segments[3], ctx.userId)
    if (!result) return err('not found', 404)
    return withCookie(json(result), setCookie)
  }

  // DELETE /api/chat/conversations/:id
  if (segments[0] === 'api' && segments[1] === 'chat' && segments[2] === 'conversations' && segments[3] && !segments[4] && request.method === 'DELETE') {
    const auth = await authenticate(request, env)
    if (auth instanceof Response) return auth
    const { ctx, setCookie } = auth

    const deleted = await deleteConversation(env.HOBBOT_DB, segments[3], ctx.userId)
    if (!deleted) return err('not found', 404)
    return withCookie(json({ deleted: true }), setCookie)
  }

  // POST /api/chat/conversations/:id/messages
  if (segments[0] === 'api' && segments[1] === 'chat' && segments[2] === 'conversations' && segments[3] && segments[4] === 'messages' && request.method === 'POST') {
    // Rate limit by IP first (cheapest check, no D1)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const { success: rlOk } = await env.MESSAGE_RATE_LIMIT.limit({ key: ip })
    if (!rlOk) return err('rate limit exceeded, try again shortly', 429)

    const auth = await authenticate(request, env)
    if (auth instanceof Response) return auth
    const { ctx, setCookie } = auth

    const conversationId = segments[3]

    // Ownership check
    const conv = await getConversation(env.HOBBOT_DB, conversationId, ctx.userId)
    if (!conv) return err('not found', 404)

    // Summarize long conversations (non-fatal on failure)
    let messages = conv.messages
    try {
      await maybeSummarize(env.HOBBOT_DB, env.AI, conversationId)
      // Reload if summarization likely ran (heuristic: loaded count > threshold).
      // Another concurrent request may have already summarized between our
      // initial load and this check; reload picks up that summary correctly.
      if (conv.messages.length > CHAT.SUMMARIZE_THRESHOLD) {
        const refreshed = await getConversation(env.HOBBOT_DB, conversationId, ctx.userId)
        if (refreshed) messages = refreshed.messages
      }
    } catch { /* summarization failure is non-fatal */ }

    let body: Record<string, unknown>
    try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }

    const content = body.content as string
    if (!content || typeof content !== 'string') return err('content is required', 400)
    if (content.length > MAX_MESSAGE_LENGTH) return err('message too long', 400)

    // Quota: max messages per conversation
    const msgCount = await countMessages(env.HOBBOT_DB, conversationId)
    if (msgCount >= MAX_MESSAGES_PER_CONVERSATION) {
      return withCookie(err('message limit reached', 429), setCookie)
    }

    // Provider selection (defaults to workers-ai for backward compatibility)
    const providerRaw = body.provider as string | undefined
    const provider: ChatProvider = providerRaw === 'dashscope' ? 'dashscope' : 'workers-ai'

    // Auto-title on first message
    if (!conv.conversation.title) {
      const autoTitle = content.length > 80 ? content.slice(0, 77) + '...' : content
      await updateConversationTitle(env.HOBBOT_DB, conversationId, autoTitle)
    }

    // Save user message
    const userMsgId = crypto.randomUUID()
    await addMessage(env.HOBBOT_DB, {
      id: userMsgId,
      conversation_id: conversationId,
      role: 'user',
      content,
      provider: null,
      agent_id: null,
      grimoire_refs: [],
      structured_data: {},
    })

    // Stream response (provider selects Workers AI or DashScope/Qwen)
    // The chat service saves the assistant message to D1 internally
    // before sending the done event, so no tee/collect needed here
    const { readable } = streamChatResponse(env, conversationId, messages, content, provider)

    return withCookie(new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    }), setCookie)
  }

  // POST /api/chat/messages/:id/feedback
  if (segments[0] === 'api' && segments[1] === 'chat' && segments[2] === 'messages' && segments[3] && segments[4] === 'feedback' && request.method === 'POST') {
    const auth = await authenticate(request, env)
    if (auth instanceof Response) return auth
    const { ctx, setCookie } = auth

    const messageId = segments[3]

    // Ownership check via message -> conversation -> user
    const owner = await getMessageOwner(env.HOBBOT_DB, messageId)
    if (owner !== ctx.userId) return err('not found', 404)

    let body: Record<string, unknown>
    try { body = await request.json() as Record<string, unknown> } catch { return err('invalid JSON body', 400) }

    const signalStr = body.signal as string
    if (signalStr !== 'up' && signalStr !== 'down') return err('signal must be "up" or "down"', 400)

    const signal = signalStr === 'up' ? 1 : -1
    const feedback = await addFeedback(env.HOBBOT_DB, {
      id: crypto.randomUUID(),
      user_id: ctx.userId,
      message_id: messageId,
      signal: signal as 1 | -1,
      grimoire_refs: Array.isArray(body.grimoire_refs) ? body.grimoire_refs as string[] : [],
    })

    return withCookie(json(feedback, 201), setCookie)
  }

  return err('not found', 404)
}
