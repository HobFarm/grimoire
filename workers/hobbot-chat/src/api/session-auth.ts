// Session cookie auth for chat endpoints
// Per-browser anonymous sessions with rate limiting on new session creation

import type { ChatUser, ChatContext } from '../chat/types'

const SESSION_COOKIE = 'grimoire_session'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type SessionResult =
  | { ctx: ChatContext; setCookie: string | null; rateLimited: false }
  | { ctx: null; setCookie: null; rateLimited: true }

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const result: Record<string, string> = {}
  for (const pair of header.split('; ')) {
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return result
}

async function upsertUser(db: D1Database, email: string): Promise<ChatUser> {
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`
  ).bind(id, email).run()

  const row = await db.prepare(
    `SELECT id, email, role, display_name, created_at FROM users WHERE email = ?`
  ).bind(email).first<ChatUser>()

  return row!
}

export async function getOrCreateSession(
  request: Request,
  env: Env,
): Promise<SessionResult> {
  const cookies = parseCookies(request.headers.get('Cookie'))
  const existing = cookies[SESSION_COOKIE]

  if (existing && UUID_RE.test(existing)) {
    const email = `${existing}@session.hob.farm`
    const user = await upsertUser(env.HOBBOT_DB, email)
    return { ctx: { userId: user.id, email: user.email }, setCookie: null, rateLimited: false }
  }

  // New session: rate limit by IP before touching D1
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.SESSION_RATE_LIMIT.limit({ key: ip })
  if (!success) {
    return { ctx: null, setCookie: null, rateLimited: true }
  }

  const sessionId = crypto.randomUUID()
  const email = `${sessionId}@session.hob.farm`
  const user = await upsertUser(env.HOBBOT_DB, email)

  const secure = env.ENVIRONMENT === 'production' ? '; Secure' : ''
  const setCookie = `${SESSION_COOKIE}=${sessionId}; Path=/api/chat; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`

  return { ctx: { userId: user.id, email: user.email }, setCookie, rateLimited: false }
}
