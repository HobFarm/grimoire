// hobbot-chat: Standalone chat worker with session cookie auth
// Reads GRIMOIRE_DB via GrimoireHandle for tool execution
// Reads/writes HOBBOT_DB for conversation state

import { handleChatRequest } from './api/chat-routes'
import { purgeOldSessions } from './state/chat'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/chat/')) {
      return handleChatRequest(request, env)
    }

    return new Response(JSON.stringify({ worker: 'hobbot-chat', ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const stats = await purgeOldSessions(env.HOBBOT_DB, 30)
    console.log(`[purge] deleted ${stats.users} users, ${stats.conversations} convs, ${stats.messages} msgs`)
  },
}
