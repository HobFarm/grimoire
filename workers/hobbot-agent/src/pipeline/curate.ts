// Phase 3: Grimoire atom curation via service binding.
// Semantic search driven by theme/signal context.
// Returns scored atoms separated into content and visual categories.

export interface CuratedAtom {
  id: string
  text: string
  category_slug: string
  collection_slug: string
  observation?: string
  harmonics?: Record<string, unknown>
  score?: number
}

export interface ArrangementDetail {
  slug: string
  name: string
  harmonics: string
  context_key: string
  contexts: Array<{ category_slug: string; guidance: string; context_mode: string }>
}

export interface CurationResult {
  atoms: CuratedAtom[]
  visualAtoms: CuratedAtom[]
  arrangement?: string
  arrangementDetail?: ArrangementDetail
}

interface SearchResult {
  atom: {
    id: string
    text: string
    text_lower: string
    category_slug: string
    collection_slug: string
    harmonics: string
  }
  score: number
}

const VISUAL_CATEGORIES = new Set([
  'camera.angle', 'camera.lens', 'camera.movement',
  'lighting.direction', 'lighting.quality', 'lighting.source',
  'color.palette', 'color.temperature', 'color.effect',
  'composition.layout', 'composition.framing', 'composition.element',
  'style.medium', 'style.genre', 'style.rendering',
])

function isVisualCategory(slug: string): boolean {
  if (VISUAL_CATEGORIES.has(slug)) return true
  // Match parent categories (e.g. "camera" matches "camera.angle")
  const parent = slug.split('.')[0]
  return ['camera', 'lighting', 'color', 'composition'].includes(parent)
}

/**
 * Query Grimoire for atoms matching the given theme.
 * Uses semantic search (Vectorize embeddings + reranker) via service binding.
 * Separates visual vocabulary atoms from content atoms.
 */
export async function curateAtoms(
  grimoire: Fetcher,
  theme: string,
  arrangement?: string
): Promise<CurationResult> {
  const allAtoms: CuratedAtom[] = []

  try {
    const searchRes = await grimoire.fetch('https://grimoire/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: theme, limit: 30 }),
    })
    if (searchRes.ok) {
      const data = (await searchRes.json()) as { results?: SearchResult[] }
      if (data.results) {
        for (const r of data.results) {
          let harmonics: Record<string, unknown> | undefined
          try { harmonics = JSON.parse(r.atom.harmonics) } catch {}
          allAtoms.push({
            id: r.atom.id,
            text: r.atom.text || r.atom.text_lower,
            category_slug: r.atom.category_slug,
            collection_slug: r.atom.collection_slug,
            harmonics,
            score: r.score,
          })
        }
      }
    }
  } catch (e) {
    console.log(`[curate] Search failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Sort by relevance score (highest first)
  allAtoms.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  // Separate visual atoms from content atoms
  const visualAtoms = allAtoms.filter(a => isVisualCategory(a.category_slug))
  const contentAtoms = allAtoms.filter(a => !isVisualCategory(a.category_slug))

  // Take top 15 content atoms, top 10 visual atoms
  const atoms = contentAtoms.slice(0, 15)
  const visual = visualAtoms.slice(0, 10)

  // Fetch arrangement detail if specified
  let arrangementDetail: ArrangementDetail | undefined
  if (arrangement) {
    arrangementDetail = (await getArrangementDetail(grimoire, arrangement)) ?? undefined
  }

  return { atoms, visualAtoms: visual, arrangement, arrangementDetail }
}

/**
 * Get all arrangements from Grimoire.
 */
export async function getArrangements(
  grimoire: Fetcher
): Promise<Array<{ slug: string; name: string; harmonics: string; context_key: string }>> {
  try {
    const res = await grimoire.fetch('https://grimoire/arrangements')
    if (res.ok) return ((await res.json()) as any[]) ?? []
  } catch (e) {
    console.log(`[curate] Failed to fetch arrangements: ${e instanceof Error ? e.message : String(e)}`)
  }
  return []
}

/**
 * Get full arrangement detail including context guidance.
 */
export async function getArrangementDetail(
  grimoire: Fetcher,
  slug: string
): Promise<ArrangementDetail | null> {
  try {
    const res = await grimoire.fetch(`https://grimoire/arrangements/${encodeURIComponent(slug)}`)
    if (res.ok) return (await res.json()) as ArrangementDetail
  } catch (e) {
    console.log(`[curate] Failed to fetch arrangement ${slug}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return null
}
