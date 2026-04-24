// Calendar management: weekly review + seed calendar.

import type { HobBotAgent } from '../agent'
import { getArrangements } from '../pipeline/curate'

// Illustration/cartoon arrangements get weighted 3x in the pool
const ILLUSTRATION_SLUGS = new Set([
  'editorial-cartoon', 'magazine-cartoon', 'newspaper-strip', 'comic-book',
  'ligne-claire', 'underground-comix', 'ukiyo-e', 'woodcut-novel',
  'pin-up-retro', 'manga', 'webtoon', 'european-bd', 'painterly',
  'technical-illustration',
])

// Fallback themes when no arrangements are available
const DEFAULT_THEMES = [
  'noir industrial aesthetics',
  'brutalist architecture geometry',
  'art deco lighting and shadow',
  'retro futurism interfaces',
  'urban decay and patina',
  'film noir atmospheric tension',
  'cyberpunk visual culture',
  'material surfaces and texture',
  'architectural symmetry',
  'light through industrial glass',
]

/**
 * Seed the calendar with a week of planned content slots.
 * Fetches arrangements from Grimoire; weights illustration/cartoon styles 3x.
 * Creates 3 slots per day (morning, afternoon, evening).
 */
export async function seedCalendar(agent: HobBotAgent, days: number = 7): Promise<number> {
  const arrangements = await getArrangements(agent.bindings.GRIMOIRE)

  // Build weighted pool: illustration arrangements appear 3x
  const pool = arrangements.length > 0
    ? arrangements.flatMap(a =>
        ILLUSTRATION_SLUGS.has(a.slug) ? [a, a, a] : [a]
      )
    : []

  const themes = pool.length > 0 ? pool.map(a => a.name) : DEFAULT_THEMES
  const scheduleHoursUTC = [15, 20, 2] // 8am, 1pm, 7pm PT
  let created = 0

  for (let d = 0; d < days; d++) {
    for (const hour of scheduleHoursUTC) {
      const scheduledAt = new Date()
      scheduledAt.setDate(scheduledAt.getDate() + d)
      scheduledAt.setUTCHours(hour, 0, 0, 0)

      if (scheduledAt.getTime() < Date.now()) continue

      const iso = scheduledAt.toISOString()
      const existing = agent.sql<{ id: string }>`SELECT id FROM calendar
        WHERE scheduled_at = ${iso} AND status = 'planned'`
      if (existing.length > 0) continue

      // Pick from weighted pool with variety (shuffle by slot index)
      const idx = (d * 3 + scheduleHoursUTC.indexOf(hour)) % themes.length
      const theme = themes[idx]
      const arrangement = pool.length > 0 ? pool[idx % pool.length]?.slug : null
      const id = crypto.randomUUID()

      agent.sql`INSERT INTO calendar (id, scheduled_at, theme, arrangement_slug, status)
        VALUES (${id}, ${iso}, ${theme}, ${arrangement}, 'planned')`
      created++
    }
  }

  return created
}

/**
 * Weekly calendar review: analyze engagement and generate next week's calendar.
 */
export async function reviewCalendar(agent: HobBotAgent): Promise<void> {
  const topPosts = agent.sql<{
    arrangement_slug: string | null
    engagement: string | null
  }>`SELECT arrangement_slug, engagement FROM posts
    WHERE posted_at > datetime('now', '-7 days')
      AND engagement IS NOT NULL
    ORDER BY json_extract(engagement, '$.impression_count') DESC
    LIMIT 10`

  const arrangementScores: Record<string, number> = {}
  for (const post of topPosts) {
    if (post.arrangement_slug && post.engagement) {
      const metrics = JSON.parse(post.engagement) as {
        impression_count?: number
        like_count?: number
      }
      const score = (metrics.impression_count ?? 0) + (metrics.like_count ?? 0) * 10
      arrangementScores[post.arrangement_slug] = (arrangementScores[post.arrangement_slug] ?? 0) + score
    }
  }

  // Clean up old planned entries that were never used
  agent.sql`DELETE FROM calendar
    WHERE status = 'planned' AND scheduled_at < datetime('now')`

  const created = await seedCalendar(agent)
  console.log(`[calendar] Review complete. Created ${created} new slots. Top arrangements: ${JSON.stringify(arrangementScores)}`)
}
