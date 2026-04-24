// MCP server: expose HobBot tools for CC and other agents.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { HobBotAgent } from '../agent'

export function createHobBotMcpServer(agent: HobBotAgent): McpServer {
  const server = new McpServer({
    name: 'HobBot',
    version: '2.0.0',
  })

  server.tool(
    'get_content_calendar',
    'Get planned content calendar entries',
    {
      status: z.enum(['planned', 'generating', 'posted', 'failed']).optional()
        .describe('Filter by status. Defaults to planned.'),
      limit: z.number().optional().describe('Max entries to return. Defaults to 20.'),
    },
    async ({ status, limit }) => {
      const filterStatus = status ?? 'planned'
      const maxLimit = limit ?? 20
      const rows = agent.sql`SELECT * FROM calendar
        WHERE status = ${filterStatus}
        ORDER BY scheduled_at ASC
        LIMIT ${maxLimit}`
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] }
    }
  )

  server.tool(
    'get_post_history',
    'Get recent post history with engagement data',
    {
      limit: z.number().optional().describe('Max posts to return. Defaults to 20.'),
    },
    async ({ limit }) => {
      const maxLimit = limit ?? 20
      const rows = agent.sql`SELECT * FROM posts
        ORDER BY posted_at DESC
        LIMIT ${maxLimit}`
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] }
    }
  )

  server.tool(
    'get_audience_signals',
    'Get current audience signals from X Search',
    {},
    async () => {
      const rows = agent.sql`SELECT * FROM signals
        WHERE expires_at > datetime('now')
        ORDER BY relevance_score DESC
        LIMIT 20`
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] }
    }
  )

  server.tool(
    'trigger_content_cycle',
    'Manually trigger a content generation pipeline run',
    {},
    async () => {
      await agent.queue('contentMorning' as keyof HobBotAgent, {})
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'queued' }) }] }
    }
  )

  server.tool(
    'update_calendar',
    'Update the theme for a planned calendar entry',
    {
      id: z.string().describe('Calendar entry ID'),
      theme: z.string().describe('New theme for this slot'),
    },
    async ({ id, theme }) => {
      agent.sql`UPDATE calendar SET theme = ${theme} WHERE id = ${id} AND status = 'planned'`
      return { content: [{ type: 'text' as const, text: JSON.stringify({ updated: true, id, theme }) }] }
    }
  )

  server.tool(
    'get_threads',
    'Get narrative threads',
    {
      status: z.enum(['active', 'complete', 'paused']).optional()
        .describe('Filter by thread status. Defaults to active.'),
    },
    async ({ status }) => {
      const filterStatus = status ?? 'active'
      const rows = agent.sql`SELECT * FROM threads
        WHERE status = ${filterStatus}
        ORDER BY created_at DESC`
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] }
    }
  )

  server.tool(
    'get_agent_state',
    'Get summary of agent state (table counts)',
    {},
    async () => {
      const calendar = agent.sql<{ count: number }>`SELECT COUNT(*) as count FROM calendar`
      const posts = agent.sql<{ count: number }>`SELECT COUNT(*) as count FROM posts`
      const threads = agent.sql<{ count: number }>`SELECT COUNT(*) as count FROM threads`
      const signals = agent.sql<{ count: number }>`SELECT COUNT(*) as count FROM signals`
      const state = {
        calendar: calendar[0]?.count ?? 0,
        posts: posts[0]?.count ?? 0,
        threads: threads[0]?.count ?? 0,
        activeSignals: signals[0]?.count ?? 0,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }] }
    }
  )

  return server
}
