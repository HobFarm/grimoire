// Phase 2: Grimoire enrichment (fail-safe — never blocks pipeline)

import { createGrimoireHandle } from '@shared/grimoire/handle'
import type { SourceResult, EnrichResult } from './types'

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'they', 'were',
  'their', 'what', 'which', 'when', 'where', 'will', 'would', 'could',
  'should', 'about', 'into', 'more', 'some', 'than', 'then', 'also',
  'article', 'document', 'topic', 'content', 'type', 'category',
])

function extractKeywords(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w))
  const seen = new Set<string>()
  const unique: string[] = []
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); unique.push(w) }
    if (unique.length >= 5) break
  }
  return unique.join(' ')
}

export async function enrichSource(
  source: SourceResult,
  grimoire: D1Database
): Promise<EnrichResult> {
  try {
    const handle = createGrimoireHandle(grimoire)
    const keywords = extractKeywords(source.sourceContent)
    if (!keywords) return { atoms: [], correspondences: [] }

    const atoms = await handle.search(keywords, { limit: 10 })
    const enrichResult: EnrichResult = {
      atoms: atoms.map(a => ({ slug: a.id, label: a.text, category: a.category_slug ?? '' })),
      correspondences: [],
    }

    // For Grimoire/StyleFusion posts, pull correspondences for the primary matched atom
    if ((source.category === 'grimoire' || source.category === 'stylefusion') && atoms.length > 0) {
      try {
        const corrResult = await handle.correspondences(atoms[0].text, 1)
        if (corrResult?.correspondences.length) {
          enrichResult.arrangement = corrResult.correspondences[0]?.arrangement_scope ?? undefined
          enrichResult.correspondences = corrResult.correspondences.slice(0, 8).map(c => ({
            from: c.atom_a_id,
            to: c.atom_b_id,
            strength: c.strength,
          }))
        }
      } catch {
        // correspondence lookup is best-effort
      }
    }

    return enrichResult
  } catch {
    return { atoms: [], correspondences: [] }
  }
}
