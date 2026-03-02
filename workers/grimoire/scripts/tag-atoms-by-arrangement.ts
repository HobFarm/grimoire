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
}

interface ArrangementRow {
  slug: string
  name: string
  harmonics: string
  category_weights: string
}

const TAG_THRESHOLD = 0.65
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
  const dimensions: (keyof HarmonicProfile)[] = [
    'hardness', 'temperature', 'weight', 'formality', 'era_affinity',
  ]

  let totalSim = 0
  for (const dim of dimensions) {
    const vecA = DIMENSION_VECTORS[dim][a[dim]] || DIMENSION_VECTORS[dim]['neutral']
    const vecB = DIMENSION_VECTORS[dim][b[dim]] || DIMENSION_VECTORS[dim]['neutral']

    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i]
      magA += vecA[i] * vecA[i]
      magB += vecB[i] * vecB[i]
    }
    const cos = (magA > 0 && magB > 0) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0
    totalSim += cos
  }

  return totalSim / dimensions.length
}

function safeParseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

export interface TaggingResult {
  total_atoms_scanned: number
  atoms_tagged: number
  tags_added: number
  arrangement_coverage: Record<string, number>
  skipped_no_harmonics: number
}

/**
 * Full bulk tagging pass. Scans all atoms with harmonics, tags with matching arrangements.
 * Designed for one-shot use. For incremental, use tagNewAtoms().
 */
export async function tagAllAtoms(db: D1Database): Promise<TaggingResult> {
  // Load arrangements
  const { results: arrResults } = await db.prepare(
    'SELECT slug, name, harmonics, category_weights FROM arrangements'
  ).all<ArrangementRow>()

  if (!arrResults || arrResults.length === 0) {
    return { total_atoms_scanned: 0, atoms_tagged: 0, tags_added: 0, arrangement_coverage: {}, skipped_no_harmonics: 0 }
  }

  const arrangements = arrResults.map(r => ({
    slug: r.slug,
    harmonics: safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile),
  }))

  const coverage: Record<string, number> = {}
  for (const a of arrangements) coverage[a.slug] = 0

  let totalScanned = 0
  let atomsTagged = 0
  let tagsAdded = 0
  let skippedNoHarmonics = 0
  let offset = 0

  while (true) {
    const { results: atoms } = await db.prepare(
      "SELECT id, harmonics, tags FROM atoms WHERE status != 'rejected' LIMIT ? OFFSET ?"
    ).bind(BATCH_SIZE, offset).all<{ id: string; harmonics: string; tags: string }>()

    if (!atoms || atoms.length === 0) break
    offset += atoms.length
    totalScanned += atoms.length

    const updates: { id: string; newTags: string }[] = []

    for (const atom of atoms) {
      const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)

      // Skip atoms without meaningful harmonics
      if (!harmonics.hardness && !harmonics.temperature) {
        skippedNoHarmonics++
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

      if (matchedSlugs.length > 0) {
        // Merge with existing tags (preserve any non-arrangement tags)
        const existingTags = safeParseJSON<string[]>(atom.tags, [])
        const merged = [...new Set([...existingTags, ...matchedSlugs])]
        const newTagsStr = JSON.stringify(merged)

        // Only update if tags actually changed
        if (newTagsStr !== atom.tags) {
          updates.push({ id: atom.id, newTags: newTagsStr })
          atomsTagged++
          tagsAdded += matchedSlugs.length
        }
      }
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

    console.log(`[tag] Processed ${totalScanned} atoms, ${atomsTagged} tagged so far`)
  }

  return { total_atoms_scanned: totalScanned, atoms_tagged: atomsTagged, tags_added: tagsAdded, arrangement_coverage: coverage, skipped_no_harmonics: skippedNoHarmonics }
}

/**
 * Incremental tagging for cron Phase 4.
 * Tags atoms with harmonics but empty/stale tags. Processes up to `limit` atoms per tick.
 */
export async function tagNewAtoms(db: D1Database, limit: number = 50): Promise<{ tagged: number; scanned: number }> {
  // Load arrangements
  const { results: arrResults } = await db.prepare(
    'SELECT slug, harmonics FROM arrangements'
  ).all<{ slug: string; harmonics: string }>()

  if (!arrResults || arrResults.length === 0) return { tagged: 0, scanned: 0 }

  const arrangements = arrResults.map(r => ({
    slug: r.slug,
    harmonics: safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile),
  }))

  // Find atoms with harmonics but empty tags
  const { results: atoms } = await db.prepare(
    "SELECT id, harmonics, tags FROM atoms WHERE category_slug IS NOT NULL AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND (tags IS NULL OR tags = '[]' OR tags = '{}' OR LENGTH(tags) <= 2) AND status != 'rejected' LIMIT ?"
  ).bind(limit).all<{ id: string; harmonics: string; tags: string }>()

  if (!atoms || atoms.length === 0) return { tagged: 0, scanned: 0 }

  let tagged = 0
  const updates: { id: string; newTags: string }[] = []

  for (const atom of atoms) {
    const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
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
