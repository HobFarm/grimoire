// Engagement tracking: fetch X metrics for recent posts.

import type { HobBotAgent } from '../agent'
import { getTweetMetrics } from '../x-api/client'

/**
 * Update engagement data for recent posts that have X post IDs.
 * Called every 4 hours.
 */
export async function updateEngagement(agent: HobBotAgent): Promise<number> {
  // Get posts from last 7 days that have X post IDs
  const posts = agent.sql<{
    id: string
    x_post_id: string
    engagement_updated_at: string | null
  }>`SELECT id, x_post_id, engagement_updated_at FROM posts
    WHERE x_post_id IS NOT NULL
      AND posted_at > datetime('now', '-7 days')
    ORDER BY posted_at DESC
    LIMIT 20`

  let updated = 0

  for (const post of posts) {
    try {
      const metrics = await getTweetMetrics(agent.secrets, post.x_post_id)
      const engagement = JSON.stringify(metrics.data.public_metrics)
      const now = new Date().toISOString()

      agent.sql`UPDATE posts
        SET engagement = ${engagement}, engagement_updated_at = ${now}
        WHERE id = ${post.id}`

      updated++
    } catch (e) {
      console.log(`[engagement] Failed for post ${post.x_post_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return updated
}
