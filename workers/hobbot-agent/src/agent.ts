import { Agent } from 'agents'
import type { Env, ResolvedSecrets } from './env'
import { resolveSecrets } from './env'
import { initSchema } from './schema'
import { runContentPipeline } from './pipeline'
import { gatherSignals } from './pipeline/signal'
import { updateEngagement as updateEngagementJob } from './scheduling/engagement'
import { reviewCalendar as reviewCalendarJob, seedCalendar } from './scheduling/calendar'
import { createHobBotMcpServer } from './mcp/server'
import { createMcpHandler } from 'agents/mcp'

type ScheduleItem = { id: string; callback: string; cron?: string }

export class HobBotAgent extends Agent<Env> {
  /** Resolved secrets cache (plain strings, not RPC proxies). */
  private _secrets: ResolvedSecrets | null = null

  /** Expose env for pipeline functions that need bindings. */
  get bindings(): Env {
    return this.env
  }

  /** Get resolved secrets. Must be called after onStart. */
  get secrets(): ResolvedSecrets {
    if (!this._secrets) throw new Error('Secrets not resolved yet')
    return this._secrets
  }

  async onStart() {
    initSchema(this.sql.bind(this) as Parameters<typeof initSchema>[0])
    this._secrets = await resolveSecrets(this.env)
    await this.registerSchedules()
  }

  private async registerSchedules() {
    const existing = (await this.getSchedules()) as ScheduleItem[]
    const existingCallbacks = new Set(existing.map((s) => s.callback))

    const schedules = [
      { cron: '0 15 * * *', callback: 'contentMorning' as const },    // 8am PT
      { cron: '0 20 * * *', callback: 'contentAfternoon' as const },  // 1pm PT
      { cron: '0 2 * * *', callback: 'contentEvening' as const },     // 7pm PT
      { cron: '0 13 * * *', callback: 'gatherSignals' as const },     // 6am PT
      { cron: '0 */4 * * *', callback: 'updateEngagement' as const },
      { cron: '0 17 * * 0', callback: 'reviewCalendar' as const },    // Sunday 10am PT
    ]

    for (const s of schedules) {
      if (!existingCallbacks.has(s.callback)) {
        await this.schedule(s.cron, s.callback, {})
        console.log(`[schedule] Registered ${s.callback} (${s.cron})`)
      }
    }
  }

  // --- Scheduled methods (wired in later phases) ---

  async contentMorning() {
    const result = await runContentPipeline(this)
    console.log(`[pipeline] Morning: ${result.status}`, JSON.stringify(result.phases))
  }

  async contentAfternoon() {
    const result = await runContentPipeline(this)
    console.log(`[pipeline] Afternoon: ${result.status}`, JSON.stringify(result.phases))
  }

  async contentEvening() {
    const result = await runContentPipeline(this)
    console.log(`[pipeline] Evening: ${result.status}`, JSON.stringify(result.phases))
  }

  async gatherSignals() {
    const signals = await gatherSignals(this)
    console.log(`[signals] Gathered ${signals.length} signals`)
  }

  async updateEngagement() {
    const updated = await updateEngagementJob(this)
    console.log(`[engagement] Updated ${updated} posts`)
  }

  async reviewCalendar() {
    await reviewCalendarJob(this)
  }

  // --- HTTP request handler ---

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const ns = request.headers.get('x-partykit-namespace')
    const room = request.headers.get('x-partykit-room')
    const prefix = ns && room ? `/agents/${ns}/${room}` : ''
    const path = prefix ? url.pathname.slice(prefix.length) || '/' : url.pathname

    // MCP endpoint
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const mcpServer = createHobBotMcpServer(this)
      // createMcpHandler expects ExecutionContext; shim from DurableObjectState
      const execCtx = {
        waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
        passThroughOnException: () => {},
      } as ExecutionContext
      return createMcpHandler(mcpServer as unknown as Parameters<typeof createMcpHandler>[0])(request, this.bindings, execCtx)
    }

    if (path === '/health' || path === '/') {
      return Response.json({
        ok: true,
        agent: 'hobbot-v2',
        version: '2.0.0',
      })
    }

    if (path === '/admin/trigger' && request.method === 'POST') {
      const result = await runContentPipeline(this)
      return Response.json(result)
    }

    if (path === '/admin/schedules') {
      const schedules = await this.getSchedules()
      return Response.json(schedules)
    }

    if (path === '/admin/seed-calendar' && request.method === 'POST') {
      const created = await seedCalendar(this)
      return Response.json({ created })
    }

    if (path === '/admin/reseed-calendar' && request.method === 'POST') {
      this.sql`DELETE FROM calendar WHERE status = 'planned'`
      const created = await seedCalendar(this)
      return Response.json({ cleared: true, created })
    }

    if (path === '/admin/pull-forward' && request.method === 'POST') {
      const n = 3
      const slots = this.sql<{ id: string; theme: string; arrangement_slug: string | null }>`
        SELECT id, theme, arrangement_slug FROM calendar
        WHERE status = 'planned' ORDER BY scheduled_at ASC LIMIT ${n}`
      for (const slot of slots) {
        this.sql`UPDATE calendar SET scheduled_at = datetime('now') WHERE id = ${slot.id}`
      }
      return Response.json({ pulled: slots.length, slots })
    }

    if (path === '/admin/state') {
      const calendar = this.sql`SELECT COUNT(*) as count FROM calendar`
      const calendarSample = this.sql`SELECT theme, arrangement_slug, status, scheduled_at FROM calendar ORDER BY scheduled_at LIMIT 5`
      const posts = this.sql`SELECT COUNT(*) as count FROM posts`
      const recentPosts = this.sql`SELECT text, arrangement_slug, image_url, posted_at FROM posts ORDER BY posted_at DESC LIMIT 3`
      const threads = this.sql`SELECT COUNT(*) as count FROM threads`
      const signals = this.sql`SELECT COUNT(*) as count FROM signals`
      return Response.json({ calendar, calendarSample, posts, recentPosts, threads, signals })
    }

    return new Response('Not found', { status: 404 })
  }
}
