// Phase 5: Image generation via Workers AI FLUX.
// Uses Grimoire visual vocabulary (camera, lighting, color, composition atoms)
// to build semantically rich image prompts.

import type { HobBotAgent } from '../agent'
import { generateImage } from '../providers/workers-ai'
import { MODELS } from '../models'
import type { PostDraft } from './compose'
import type { CuratedAtom, ArrangementDetail } from './curate'

/**
 * Extract FLUX-compatible style direction from arrangement context guidance.
 * Pulls from style.medium and style.genre categories.
 */
function extractStyleDirection(contexts: ArrangementDetail['contexts']): string {
  const styleCategories = ['style.medium', 'style.genre']
  const relevant = contexts
    .filter(c => styleCategories.includes(c.category_slug))
    .map(c => c.guidance)

  if (relevant.length === 0) return 'Illustration style, single panel cartoon'

  return relevant
    .map(g => g.split('.').slice(0, 2).join('.').trim())
    .join('. ')
    .slice(0, 250)
}

/**
 * Build visual vocabulary injection from curated visual atoms.
 * Groups by category parent for structured prompt injection.
 */
function buildVisualTerms(visualAtoms: CuratedAtom[]): string {
  if (visualAtoms.length === 0) return ''

  // Group by category parent
  const groups: Record<string, string[]> = {}
  for (const atom of visualAtoms) {
    const parent = atom.category_slug.split('.')[0]
    if (!groups[parent]) groups[parent] = []
    groups[parent].push(atom.text)
  }

  // Build compact visual vocabulary string
  const parts: string[] = []
  if (groups.lighting) parts.push(`Lighting: ${groups.lighting.join(', ')}`)
  if (groups.camera) parts.push(`Camera: ${groups.camera.join(', ')}`)
  if (groups.color) parts.push(`Color: ${groups.color.join(', ')}`)
  if (groups.composition) parts.push(`Composition: ${groups.composition.join(', ')}`)
  if (groups.style) parts.push(`Style: ${groups.style.join(', ')}`)

  return parts.join('. ')
}

/**
 * Generate an image from the post's visual direction.
 * Enriches FLUX prompt with Grimoire visual vocabulary and arrangement style.
 * Tries FLUX-2 Dev -> FLUX-1 Schnell -> Lucid Origin.
 * Returns CDN URL on success, null on failure (post goes text-only).
 */
export async function generateVisual(
  agent: HobBotAgent,
  draft: PostDraft,
  arrangementDetail?: ArrangementDetail,
  visualAtoms?: CuratedAtom[],
): Promise<{ url: string; provider: string } | null> {
  const vd = draft.visualDirection

  // Build style prefix from arrangement context guidance
  const stylePrefix = arrangementDetail?.contexts?.length
    ? extractStyleDirection(arrangementDetail.contexts)
    : 'Illustration style, single panel cartoon'

  // Build Grimoire visual vocabulary injection
  const visualTerms = buildVisualTerms(visualAtoms ?? [])

  // Build image prompt: arrangement style + subject + visual vocab + mood
  const prompt = [
    stylePrefix,
    vd.subject,
    visualTerms,
    `Mood: ${vd.mood}`,
    vd.palette ? `Colors: ${vd.palette}` : '',
    'Single panel composition. No text, no speech bubbles, no captions, no watermarks, no logos',
  ].filter(Boolean).join('. ')

  const chain = [MODELS.visualize.primary, ...MODELS.visualize.fallbacks]

  for (const entry of chain) {
    try {
      const imageData = await generateImage(
        agent.bindings.AI,
        entry.model,
        prompt,
        { width: 1024, height: 1024 }
      )

      // Upload to R2
      const key = `agents/hobbot/images/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`
      await agent.bindings.CDN.put(key, imageData, {
        httpMetadata: { contentType: 'image/png' },
      })

      const url = `https://cdn.hob.farm/${key}`
      console.log(`[visualize] Image generated via ${entry.model}, uploaded to ${key}`)
      return { url, provider: `${entry.provider}/${entry.model}` }
    } catch (e) {
      console.log(`[visualize] ${entry.model} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log('[visualize] All image providers failed, post will be text-only')
  return null
}
