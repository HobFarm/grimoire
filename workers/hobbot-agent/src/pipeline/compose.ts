// Phase 4: Text composition via Claude Opus.

import type { HobBotAgent } from '../agent'
import { callWithFallback, buildModelContext } from '../providers'
import type { CallWithFallbackOptions } from '../providers/types'
import { buildComposePrompt } from '../prompts/compose'
import { tryParseJson } from '../utils/json'
import type { CuratedAtom, ArrangementDetail } from './curate'
import type { Signal } from './signal'
import type { KnowledgeResult } from './knowledge'

export interface PostDraft {
  text: string
  altText: string
  visualDirection: {
    subject: string
    style: string
    lighting: string
    mood: string
    palette?: string
  }
  atomsUsed: string[]
  arrangementSlug?: string
  textProvider: string
  textModel: string
}

/**
 * Extract style guidance from arrangement context data.
 * Filters for style.medium and style.genre categories.
 */
function extractStyleGuidance(detail: ArrangementDetail): string {
  const styleCategories = ['style.medium', 'style.genre']
  const relevant = detail.contexts
    .filter(c => styleCategories.includes(c.category_slug))
    .map(c => c.guidance)

  if (relevant.length === 0) return `${detail.name} illustration style`

  // Take first 2 sentences from each, cap total length for prompt budget
  return relevant
    .map(g => g.split('.').slice(0, 2).join('.').trim())
    .join('. ')
    .slice(0, 500)
}

export async function composePost(
  agent: HobBotAgent,
  atoms: CuratedAtom[],
  knowledge: KnowledgeResult | null,
  signals: Signal[],
  theme?: string,
  arrangementDetail?: ArrangementDetail,
  options?: CallWithFallbackOptions,
): Promise<PostDraft | null> {
  const ctx = buildModelContext(agent.bindings, agent.secrets)

  // Get recent posts to avoid repetition
  const recentPosts = agent.sql<{ text: string }>`SELECT text FROM posts
    ORDER BY posted_at DESC LIMIT 10`

  // Get active thread if any
  const threads = agent.sql<{
    name: string; description: string | null; posts_count: number
  }>`SELECT name, description, posts_count FROM threads
    WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  const thread = threads.length > 0
    ? { name: threads[0].name, description: threads[0].description ?? undefined, postsCount: threads[0].posts_count }
    : null

  // Build signal summary
  const signalSummary = signals.length > 0
    ? signals.map((s) => {
        const data = tryParseJson<{ summary?: string }>(s.data)
        return data?.summary ?? ''
      }).filter(Boolean).join('; ')
    : undefined

  // Build arrangement context with harmonic profile
  let arrangement: Parameters<typeof buildComposePrompt>[0]['arrangement']
  if (arrangementDetail) {
    let harmonicProfile: Record<string, number> | undefined
    try { harmonicProfile = JSON.parse(arrangementDetail.harmonics) } catch {}
    arrangement = {
      name: arrangementDetail.name,
      slug: arrangementDetail.slug,
      styleGuidance: extractStyleGuidance(arrangementDetail),
      harmonicProfile,
    }
  }

  const prompt = buildComposePrompt({
    atoms,
    knowledge: knowledge?.answer,
    signals: signalSummary,
    recentPosts: recentPosts.map((p) => p.text),
    thread,
    theme,
    arrangement,
  })

  const result = await callWithFallback(ctx, 'compose', prompt, options)
  if (!result) return null

  const parsed = tryParseJson<{
    text?: string
    altText?: string
    visualDirection?: PostDraft['visualDirection']
  }>(result.result)

  if (!parsed?.text || !parsed?.visualDirection) {
    const preview = typeof result.result === 'string' ? result.result.slice(0, 300) : JSON.stringify(result.result).slice(0, 300)
    console.log(`[compose] Failed to parse (${result.provider}/${result.model}): ${preview}`)
    return null
  }

  return {
    text: parsed.text,
    altText: parsed.altText ?? '',
    visualDirection: parsed.visualDirection,
    atomsUsed: atoms.slice(0, 10).map((a) => a.id),
    arrangementSlug: arrangementDetail?.slug,
    textProvider: result.provider,
    textModel: result.model,
  }
}
