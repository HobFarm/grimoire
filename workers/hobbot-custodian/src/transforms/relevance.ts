// Keyword-based relevance scorer for RSS feed items.
// Zero LLM cost: uses arrangement slugs, category parent names, and curated terms.

import type { FeedItem } from './rss'

export interface FeedSourceConfig {
  tier: 'core' | 'adjacent' | 'long_tail'
  weight: number
}

// Curated domain terms beyond what the DB provides.
// These cover AI image generation, visual art, hospitality, and live events.
const CURATED_TERMS = [
  // AI / generative
  'stable diffusion', 'midjourney', 'dall-e', 'comfyui', 'flux',
  'diffusion model', 'image generation', 'text-to-image', 'img2img',
  'controlnet', 'lora', 'checkpoint', 'inpainting', 'outpainting',
  'generative ai', 'generative art', 'ai art', 'neural style',
  // Visual art
  'art deco', 'art nouveau', 'bauhaus', 'brutalism', 'cyberpunk',
  'steampunk', 'noir', 'vaporwave', 'retrofuturism', 'solarpunk',
  'surrealism', 'impressionism', 'expressionism', 'minimalism',
  'chiaroscuro', 'cinematography', 'color grading', 'color theory',
  'composition', 'framing', 'lighting', 'mood board', 'aesthetic',
  'visual style', 'design system', 'typography',
  // Photography / film
  'photography', 'film grain', 'bokeh', 'wide angle', 'telephoto',
  'golden hour', 'blue hour', 'long exposure', 'double exposure',
  // Hospitality / live events
  'stage design', 'lighting design', 'concert', 'festival',
  'venue', 'hospitality', 'immersive', 'projection mapping',
  'led wall', 'moving head', 'stage lighting',
  // Creative tech
  'creative coding', 'shader', 'procedural', 'generative design',
  'touchdesigner', 'processing', 'openframeworks',
]

let cachedKeywords: Set<string> | null = null

/**
 * Load arrangement slugs and category parent names from Grimoire DB
 * to use as relevance keywords. Cached after first call.
 */
export async function loadKeywords(grimoireDb: D1Database): Promise<Set<string>> {
  if (cachedKeywords) return cachedKeywords

  const keywords = new Set<string>()

  // Add curated terms
  for (const term of CURATED_TERMS) {
    keywords.add(term.toLowerCase())
  }

  try {
    // Arrangement slugs (e.g., "atomic-noir", "film-noir", "comic-book")
    const arrangements = await grimoireDb.prepare(
      'SELECT slug, name FROM arrangements'
    ).all<{ slug: string; name: string }>()
    for (const a of arrangements.results ?? []) {
      keywords.add(a.slug.toLowerCase())
      keywords.add(a.name.toLowerCase())
    }

    // Category parent names (unique prefix before the dot)
    const categories = await grimoireDb.prepare(
      "SELECT DISTINCT substr(category_slug, 1, instr(category_slug, '.') - 1) as parent FROM atoms WHERE category_slug LIKE '%.%' AND status = 'confirmed' LIMIT 100"
    ).all<{ parent: string }>()
    for (const c of categories.results ?? []) {
      if (c.parent) keywords.add(c.parent.toLowerCase())
    }
  } catch (e) {
    console.warn(`[relevance] failed to load DB keywords: ${e instanceof Error ? e.message : e}`)
  }

  cachedKeywords = keywords
  return keywords
}

/**
 * Score a feed item's relevance to Grimoire domains.
 * Returns 0.0-1.0 score.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function scoreItem(
  item: FeedItem,
  config: FeedSourceConfig,
  keywords: Set<string>,
): number {
  const text = `${item.title} ${item.description}`.toLowerCase()

  let matchCount = 0
  let matchWeight = 0

  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i')
    if (pattern.test(text)) {
      matchCount++
      // Longer keywords are more specific and worth more
      matchWeight += keyword.length > 10 ? 2 : 1
    }
  }

  if (matchCount === 0) return 0

  // Base score: diminishing returns on keyword density
  const density = Math.min(matchWeight / 10, 1.0)
  const baseScore = 0.1 + (density * 0.8)

  // Apply feed weight
  return Math.min(baseScore * config.weight, 1.0)
}

/**
 * Get the ingest threshold for a feed tier.
 */
export function getThreshold(tier: FeedSourceConfig['tier']): number {
  switch (tier) {
    case 'core': return 0.3
    case 'adjacent': return 0.5
    case 'long_tail': return 0.7
  }
}
