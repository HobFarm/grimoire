/**
 * Atom Arrangement Tagging
 *
 * Scores every atom's harmonic profile against every arrangement's profile
 * using 6D Euclidean distance (5 harmonic dims + register). Keeps top-N
 * closest arrangements with distance scores stored in arrangement_tags.
 *
 * Intended to run as:
 *   1. One-shot via admin endpoint POST /admin/tag-arrangements
 *   2. Incrementally via Grimoire cron Phase 4
 */

export interface HarmonicProfile {
  hardness: number
  temperature: number
  weight: number
  formality: number
  era_affinity: number
  register?: number
}

interface ArrangementRow {
  slug: string
  name: string
  harmonics: string
  category_weights: string
  register: number | null
}

// Bump TAGGER_VERSION when the scoring algorithm changes to force a full re-tag.
// currentVersion = Math.max(TAGGER_VERSION, arrangementCount) ensures new
// arrangements also trigger re-tagging without needing a code change.
const TAGGER_VERSION = 30
const TOP_N = 4
const MAX_DISTANCE = 0.8
const UPDATE_BATCH_SIZE = 50

const HARMONIC_DIMS = ['hardness', 'temperature', 'weight', 'formality', 'era_affinity'] as const

/**
 * Euclidean distance between two numeric harmonic profiles (6 dimensions: 5 harmonic + register).
 * Returns 0.0 (identical) to ~2.45 (maximally distant across all 6 dims).
 */
function harmonicDistance(
  atomH: HarmonicProfile,
  arrH: HarmonicProfile
): number {
  let sumSq = 0
  for (const dim of HARMONIC_DIMS) {
    const diff = (atomH[dim] ?? 0.5) - (arrH[dim] ?? 0.5)
    sumSq += diff * diff
  }
  const regDiff = (atomH.register ?? 0.5) - (arrH.register ?? 0.5)
  sumSq += regDiff * regDiff
  return Math.sqrt(sumSq)
}

export function safeParseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/**
 * Load and parse all arrangements from D1. Returns parsed profiles ready for scoring.
 * Exported for queue consumer use.
 */
export async function loadArrangements(db: D1Database): Promise<{
  arrangements: { slug: string; harmonics: HarmonicProfile }[]
  currentVersion: number
}> {
  const { results } = await db.prepare(
    'SELECT slug, harmonics, register FROM arrangements'
  ).all<{ slug: string; harmonics: string; register: number | null }>()

  if (!results || results.length === 0) {
    return { arrangements: [], currentVersion: TAGGER_VERSION }
  }

  const currentVersion = Math.max(TAGGER_VERSION, results.length)
  const arrangements = results.map(r => {
    const h = safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile)
    h.register = r.register ?? 0.5
    return { slug: r.slug, harmonics: h }
  })

  return { arrangements, currentVersion }
}

export interface ScoredArrangement {
  slug: string
  dist: number
}

/**
 * Score a single atom's harmonics against all arrangements.
 * Returns top-N closest within MAX_DISTANCE, or empty array.
 * Exported for queue consumer use.
 *
 * Signals:
 * 1. Text containment: if atom text matches an arrangement slug, force-include at dist 0
 * 2. Harmonic distance: 6D Euclidean distance (5 harmonic dims + register)
 */
export function scoreAtom(
  harmonics: HarmonicProfile,
  arrangements: { slug: string; harmonics: HarmonicProfile }[],
  textLower?: string
): ScoredArrangement[] {
  const scored: ScoredArrangement[] = []
  for (const arr of arrangements) {
    if (typeof arr.harmonics.hardness !== 'number') continue

    // Signal 1: Text containment force-include
    if (textLower && textLower.length >= 3) {
      const normalizedSlug = arr.slug.replace(/-/g, ' ')
      if (textLower.includes(normalizedSlug) || normalizedSlug.includes(textLower)) {
        scored.push({ slug: arr.slug, dist: 0 })
        continue
      }
    }

    // Signal 2: Harmonic distance
    const dist = harmonicDistance(harmonics, arr.harmonics)
    if (dist <= MAX_DISTANCE) {
      scored.push({ slug: arr.slug, dist: Math.round(dist * 1000) / 1000 })
    }
  }
  scored.sort((a, b) => a.dist - b.dist)
  return scored.slice(0, TOP_N)
}

/**
 * Atomic dual-write: arrangement_atoms join table + arrangement_tags JSON column.
 * Both writes happen in the same db.batch() for consistency.
 * Batches 10 atoms at a time (~60 stmts) to stay within D1 limits.
 */
export async function dualWriteArrangementTags(
  db: D1Database,
  updates: { id: string; newTags: string }[],
  currentVersion: number
): Promise<void> {
  const DUAL_BATCH_SIZE = 10

  for (let i = 0; i < updates.length; i += DUAL_BATCH_SIZE) {
    const chunk = updates.slice(i, i + DUAL_BATCH_SIZE)
    const stmts: D1PreparedStatement[] = []

    for (const u of chunk) {
      // 1. Delete old arrangement_atoms rows for this atom
      stmts.push(
        db.prepare('DELETE FROM arrangement_atoms WHERE atom_id = ?').bind(u.id)
      )

      // 2. Insert new rows (skip 'unaffiliated' sentinel)
      const tags: { slug: string; dist: number }[] = JSON.parse(u.newTags)
      for (const tag of tags) {
        if (tag.slug !== 'unaffiliated') {
          stmts.push(
            db.prepare(
              'INSERT OR REPLACE INTO arrangement_atoms (arrangement_slug, atom_id, distance) VALUES (?, ?, ?)'
            ).bind(tag.slug, u.id, tag.dist)
          )
        }
      }

      // 3. Update JSON column + tag_version (backward compat)
      stmts.push(
        db.prepare(
          "UPDATE atoms SET arrangement_tags = ?, tag_version = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(u.newTags, currentVersion, u.id)
      )
    }

    await db.batch(stmts)
  }
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
  const { results: arrResults } = await db.prepare(
    'SELECT slug, name, harmonics, category_weights, register FROM arrangements'
  ).all<ArrangementRow>()

  if (!arrResults || arrResults.length === 0) {
    return { processed: 0, remaining: 0, done: true, arrangement_coverage: {} }
  }

  const currentVersion = Math.max(TAGGER_VERSION, arrResults.length)

  const arrangements = arrResults.map(r => {
    const h = safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile)
    h.register = r.register ?? 0.5
    return { slug: r.slug, harmonics: h }
  })

  const coverage: Record<string, number> = {}
  for (const a of arrangements) coverage[a.slug] = 0

  const { results: atoms } = await db.prepare(
    "SELECT id, text_lower, harmonics, register FROM atoms WHERE harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tag_version < ? AND status != 'rejected' LIMIT ?"
  ).bind(currentVersion, batchSize).all<{ id: string; text_lower: string; harmonics: string; register: number | null }>()

  if (!atoms || atoms.length === 0) {
    return { processed: 0, remaining: 0, done: true, arrangement_coverage: coverage }
  }

  const updates: { id: string; newTags: string }[] = []

  for (const atom of atoms) {
    const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
    harmonics.register = atom.register ?? 0.5

    if (typeof harmonics.hardness !== 'number') {
      updates.push({ id: atom.id, newTags: JSON.stringify([{ slug: 'unaffiliated', dist: 0 }]) })
      continue
    }

    const topMatches = scoreAtom(harmonics, arrangements, atom.text_lower)
    for (const m of topMatches) coverage[m.slug]++

    const tagsStr = JSON.stringify(topMatches.length > 0 ? topMatches : [{ slug: 'unaffiliated', dist: 0 }])
    updates.push({ id: atom.id, newTags: tagsStr })
  }

  await dualWriteArrangementTags(db, updates, currentVersion)

  const { results: countResult } = await db.prepare(
    "SELECT COUNT(*) as cnt FROM atoms WHERE harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tag_version < ? AND status != 'rejected'"
  ).bind(currentVersion).all<{ cnt: number }>()

  const remaining = countResult?.[0]?.cnt ?? 0

  console.log(`[tag] Batch done: ${atoms.length} processed, ${remaining} remaining`)

  return { processed: atoms.length, remaining, done: remaining === 0, arrangement_coverage: coverage }
}

/**
 * Incremental tagging for cron Phase 4.
 * Scores atoms against arrangements, writes top-N with distances to arrangement_tags.
 */
export async function tagNewAtoms(db: D1Database, limit: number = 50): Promise<{ tagged: number; scanned: number }> {
  const { results: arrResults } = await db.prepare(
    'SELECT slug, harmonics, register FROM arrangements'
  ).all<{ slug: string; harmonics: string; register: number | null }>()

  if (!arrResults || arrResults.length === 0) return { tagged: 0, scanned: 0 }

  const currentVersion = Math.max(TAGGER_VERSION, arrResults.length)

  const arrangements = arrResults.map(r => {
    const h = safeParseJSON<HarmonicProfile>(r.harmonics, {} as HarmonicProfile)
    h.register = r.register ?? 0.5
    return { slug: r.slug, harmonics: h }
  })

  const { results: atoms } = await db.prepare(
    "SELECT id, text_lower, harmonics, register FROM atoms WHERE category_slug IS NOT NULL AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tag_version < ? AND status != 'rejected' LIMIT ?"
  ).bind(currentVersion, limit).all<{ id: string; text_lower: string; harmonics: string; register: number | null }>()

  if (!atoms || atoms.length === 0) return { tagged: 0, scanned: 0 }

  let tagged = 0
  const updates: { id: string; newTags: string }[] = []

  for (const atom of atoms) {
    const harmonics = safeParseJSON<HarmonicProfile>(atom.harmonics, {} as HarmonicProfile)
    harmonics.register = atom.register ?? 0.5

    if (typeof harmonics.hardness !== 'number') {
      updates.push({ id: atom.id, newTags: JSON.stringify([{ slug: 'unaffiliated', dist: 0 }]) })
      continue
    }

    const topMatches = scoreAtom(harmonics, arrangements, atom.text_lower)

    const tagsStr = JSON.stringify(topMatches.length > 0 ? topMatches : [{ slug: 'unaffiliated', dist: 0 }])
    updates.push({ id: atom.id, newTags: tagsStr })
    if (topMatches.length > 0) tagged++
  }

  await dualWriteArrangementTags(db, updates, currentVersion)

  return { tagged, scanned: atoms.length }
}
