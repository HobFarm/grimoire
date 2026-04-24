// Phase 7: Post to X and record in SQLite.

import type { HobBotAgent } from '../agent'
import { postTweet, uploadMedia } from '../x-api/client'
import type { PostDraft } from './compose'

export interface PostResult {
  xPostId: string
  imageUrl: string | null
}

/**
 * Post a tweet, optionally with an image.
 * Records the post in SQLite and updates calendar status.
 */
export async function publishPost(
  agent: HobBotAgent,
  draft: PostDraft,
  imageUrl: string | null,
  imageProvider: string | null,
  calendarId: string | null
): Promise<PostResult> {
  let mediaIds: string[] | undefined

  // Upload image if we have one
  if (imageUrl) {
    try {
      const imageRes = await fetch(imageUrl)
      if (imageRes.ok) {
        const imageData = await imageRes.arrayBuffer()
        const mediaId = await uploadMedia(agent.secrets, imageData, 'image/png')
        mediaIds = [mediaId]
      }
    } catch (e) {
      console.log(`[post] Image upload failed, posting text-only: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Post tweet
  const tweetRes = await postTweet(agent.secrets, draft.text, mediaIds)
  const xPostId = tweetRes.data.id

  // Record in posts table
  const postId = crypto.randomUUID()
  const now = new Date().toISOString()

  agent.sql`INSERT INTO posts (id, calendar_id, text, alt_text, image_url, image_provider, text_provider, atoms_used, arrangement_slug, posted_at, x_post_id, created_at)
    VALUES (
      ${postId},
      ${calendarId},
      ${draft.text},
      ${draft.altText},
      ${imageUrl},
      ${imageProvider},
      ${`${draft.textProvider}/${draft.textModel}`},
      ${JSON.stringify(draft.atomsUsed)},
      ${draft.arrangementSlug ?? null},
      ${now},
      ${xPostId},
      ${now}
    )`

  // Update calendar status if linked to a slot
  if (calendarId) {
    agent.sql`UPDATE calendar SET status = 'posted' WHERE id = ${calendarId}`
  }

  console.log(`[post] Published tweet ${xPostId}`)
  return { xPostId, imageUrl }
}
