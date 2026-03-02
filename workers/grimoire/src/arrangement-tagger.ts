/**
 * Atom Arrangement Tagging
 *
 * Computes harmonicSimilarity between every atom's harmonic profile
 * and every arrangement's harmonic profile. Tags atoms with arrangement
 * slugs where similarity >= THRESHOLD.
 *
 * Intended to run as:
 *   1. One-shot via admin endpoint POST /admin/tag-arrangements
 *   2. Incrementally via Grimoire cron Phase 4
 *
 * This file exports the core logic. Wire it into index.ts.
 */

interface HarmonicProfile {
  hardness: 'hard' | 'soft' | 'neutral'
  temperature: 'warm' | 'cool' | 'neutral'
  weight: 'heavy' | 'light' | 'neutral'
  formality: 'structured' | 'organic' | 'neutral'
  era_affinity: 'archaic' | 'industrial' | 'modern' | 'timeless'
  register?: number  // 0.0-1.0, null/undefined coalesces to 0.5
}

interface ArrangementRow {
  slug: string
  name: string
  harmonics: string
  category_weights: string
  register: number | null
}

const TAG_THRESHOLD = 0.50
const BATCH_SIZE = 500
const UPDATE_BATCH_SIZE = 50

const DIMENSION_VECTORS: Record<string, Record<string, number[]>> = {
  hardness:    { hard: [1, 0], soft: [0, 1], neutral: [0.5, 0.5] },
  temperature: { warm: [1, 0], cool: [0, 1], neutral: [0.5, 0.5] },
  weight:      { heavy: [1, 0], light: [0, 1], neutral: [0.5, 0.5] },
  formality:   { structured: [1, 0], organic: [0, 1], neutral: [0.5, 0.5] },
  era_affinity: { archaic: [1, 0, 0, 0], industrial: [0, 1, 0, 0], modern: [0, 0, 1, 0], timeless: [0, 0, 0, 1] },
}

function harmonicSimilarity(a: HarmonicProfile, b: HarmonicProfile): number {
  const categoricalDims: (keyof HarmonicProfile)[] = [
    'hardness', 'temperature', 'weight', 'formality', 'era_affinity',
  ]

  let totalSim = 0
  for (const dim of categoricalDims) {
    const vecA = DIMENSION_VECTORS[dim][a[dim] as string] || DIMENSION_VECTORS[dim]['neutral']
    const vecB = DIMENSION_VECTORS[dim][b[dim] as string] || DIMENSION_VECTORS[dim]['neutral']

    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i]
      magA += vecA[i] * vecA[i]
      magB += vecB[i] * vecB[i]
    }
    const cos = (magA > 0 && magB > 0) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0
    totalSim += cos
  }

  // Register dimension: continuous 0.0-1.0, coalesce null/undefined to 0.5
  const regA = a.register ?? 0.5
  const regB = b.register ?? 0.5
  const rVecA = [regA, 1 - regA]
  const rVecB = [regB, 1 - regB]
  const rDot = rVecA[0] * rVecB[0] + rVecA[1] * rVecB[1]
  const rMagA = Math.sqrt(rVecA[0] * rVecA[0] + rVecA[1] * rVecA[1])
  const rMagB = Math.sqrt(rVecB[0] * rVecB[0] + rVecB[1] * rVecB[1])
  const regSim = (rMagA > 0 && rMagB > 0) ? rDot / (rMagA * rMagB) : 0
  totalSim += regSim

  return totalSim / 6  // 5 categorical + 1 register
}

function safeParseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

export interface TaggingResult {
  processed: number
  remaining: number
  done: boolean
  arrangement_coverage: Record<string, number>
}

/**
 * Batch tagging pass. Processes one batch of untagged atoms per invocation.
 * Caller re-invokes until done=true.
 */
export async function tagAllAtoms(db: D1Database, batchSize: number = 5000): Promise<TaggingResult> {
  // Load arrangements
  const { results: arrResults } = await db.prepare(
    'SELECT slug, name, harmonics, category_weights, register FROM arrangements'
  ).all<ArrangementRow>()

  if (!arrResults || arrResults.length === 0) {
    return { processed: 0, remaining: 0, done: true, arrangement_coverage: {} }
  }

  const arrangements = arrResults.map(r => {
    const h = safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile)
    h.register = r.register ?? 0.5
    return { slug: r.slug, harmonics: h }
  })

  const coverage: Record<string, number> = {}
  for (const a of arrangements) coverage[a.slug] = 0

  // Select only untagged atoms with harmonics
  const { results: atoms } = await db.prepare(
    "SELECT id, harmonics, tags, register FROM atoms WHERE harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND (tags IS NULL OR tags = '[]' OR tags = '{}' OR LENGTH(tags) <= 2) AND status != 'rejected' LIMIT ?"
  ).bind(batchSize).all<{ id: string; harmonics: string; tags: string; register: number | null }>()

  if (!atoms || atoms.length === 0) {
    return { processed: 0, remaining: 0, done: true, arrangement_coverage: coverage }
  }

  const updates: { id: string; newTags: string }[] = []

  for (const atom of atoms) {
    const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
    harmonics.register = atom.register ?? 0.5

    if (!harmonics.hardness && !harmonics.temperature) {
      // No meaningful harmonics, mark as unaffiliated so it's not re-scanned
      updates.push({ id: atom.id, newTags: JSON.stringify(['unaffiliated']) })
      continue
    }

    const matchedSlugs: string[] = []

    for (const arr of arrangements) {
      if (!arr.harmonics.hardness) continue
      const sim = harmonicSimilarity(harmonics, arr.harmonics)
      if (sim >= TAG_THRESHOLD) {
        matchedSlugs.push(arr.slug)
        coverage[arr.slug]++
      }
    }

    const tagsStr = JSON.stringify(matchedSlugs.length > 0 ? matchedSlugs : ['unaffiliated'])
    updates.push({ id: atom.id, newTags: tagsStr })
  }

  // Batch update in chunks
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const chunk = updates.slice(i, i + UPDATE_BATCH_SIZE)
    const batch = chunk.map(u =>
      db.prepare("UPDATE atoms SET tags = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(u.newTags, u.id)
    )
    await db.batch(batch)
  }

  // Count remaining
  const { results: countResult } = await db.prepare(
    "SELECT COUNT(*) as cnt FROM atoms WHERE harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND (tags IS NULL OR tags = '[]' OR tags = '{}' OR LENGTH(tags) <= 2) AND status != 'rejected'"
  ).all<{ cnt: number }>()

  const remaining = countResult?.[0]?.cnt ?? 0

  console.log(`[tag] Batch done: ${atoms.length} processed, ${remaining} remaining`)

  return { processed: atoms.length, remaining, done: remaining === 0, arrangement_coverage: coverage }
}

/**
 * Incremental tagging for cron Phase 4.
 * Tags atoms with harmonics but empty/stale tags. Processes up to `limit` atoms per tick.
 */
export async function tagNewAtoms(db: D1Database, limit: number = 50): Promise<{ tagged: number; scanned: number }> {
  // Load arrangements
  const { results: arrResults } = await db.prepare(
    'SELECT slug, harmonics, register FROM arrangements'
  ).all<{ slug: string; harmonics: string; register: number | null }>()

  if (!arrResults || arrResults.length === 0) return { tagged: 0, scanned: 0 }

  const arrangements = arrResults.map(r => {
    const h = safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile)
    h.register = r.register ?? 0.5
    return { slug: r.slug, harmonics: h }
  })

  // Find atoms with harmonics but empty tags
  const { results: atoms } = await db.prepare(
    "SELECT id, harmonics, tags, register FROM atoms WHERE category_slug IS NOT NULL AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND (tags IS NULL OR tags = '[]' OR tags = '{}' OR LENGTH(tags) <= 2) AND status != 'rejected' LIMIT ?"
  ).bind(limit).all<{ id: string; harmonics: string; tags: string; register: number | null }>()

  if (!atoms || atoms.length === 0) return { tagged: 0, scanned: 0 }

  let tagged = 0
  const updates: { id: string; newTags: string }[] = []

  for (const atom of atoms) {
    const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
    harmonics.register = atom.register ?? 0.5
    if (!harmonics.hardness && !harmonics.temperature) continue

    const matchedSlugs: string[] = []
    for (const arr of arrangements) {
      if (!arr.harmonics.hardness) continue
      const sim = harmonicSimilarity(harmonics, arr.harmonics)
      if (sim >= TAG_THRESHOLD) {
        matchedSlugs.push(arr.slug)
      }
    }

    // Even if no arrangements match, set tags to empty array so this atom
    // isn't re-processed on subsequent cron ticks
    const tagsStr = JSON.stringify(matchedSlugs.length > 0 ? matchedSlugs : ['unaffiliated'])
    updates.push({ id: atom.id, newTags: tagsStr })
    if (matchedSlugs.length > 0) tagged++
  }

  // Batch update
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const chunk = updates.slice(i, i + UPDATE_BATCH_SIZE)
    const batch = chunk.map(u =>
      db.prepare("UPDATE atoms SET tags = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(u.newTags, u.id)
    )
    await db.batch(batch)
  }

  return { tagged, scanned: atoms.length }
}
