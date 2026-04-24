// Shared semantic correspondence discovery logic
// Used by both admin endpoint (bulk rebuild) and cron Phase 6 (ongoing)

interface CorrespondenceCandidate {
  a: string
  b: string
  type: string
  strength: number
  scope: 'cross_category' | 'intra_category'
}

const CROSS_CATEGORY_THRESHOLD = 0.65
const INTRA_CATEGORY_THRESHOLD = 0.75
const MAX_CROSS_CATEGORY = 10
const MAX_INTRA_CATEGORY = 5

/**
 * Discover semantic correspondences for a batch of atoms.
 * Queries Vectorize for nearest neighbors, filters to cross-category matches,
 * validates neighbor IDs exist in D1 (Vectorize may contain stale vectors),
 * and upserts correspondences (keeping the higher strength on conflict).
 */
export async function discoverSemanticBatch(
  db: D1Database,
  vectorize: Vectorize,
  atoms: Array<{ id: string; text_lower: string; category_slug: string }>
): Promise<{ inserted: number }> {
  if (atoms.length === 0) return { inserted: 0 }

  const toInsert: CorrespondenceCandidate[] = []
  const neighborIds = new Set<string>()

  // Fetch vectors in chunks of 20 (Vectorize getByIds limit)
  const vectorMap = new Map<string, number[]>()
  const allIds = atoms.map(a => a.id)
  for (let i = 0; i < allIds.length; i += 20) {
    const chunk = allIds.slice(i, i + 20)
    const stored = await vectorize.getByIds(chunk)
    for (const v of stored) {
      if (v.values && v.values.length > 0) {
        vectorMap.set(v.id, v.values as number[])
      }
    }
  }

  // Query neighbors in parallel (concurrent Vectorize queries instead of sequential)
  const queryResults = await Promise.allSettled(
    atoms.map(async (atom) => {
      const vec = vectorMap.get(atom.id)
      if (!vec) return { atom, matches: [] as VectorizeMatch[] }
      const result = await vectorize.query(vec, {
        topK: 50,
        returnMetadata: 'indexed',
        returnValues: false,
      })
      return { atom, matches: result.matches }
    })
  )

  for (const settled of queryResults) {
    if (settled.status === 'rejected') {
      console.error(`[correspondence] query failed:`, settled.reason)
      continue
    }
    const { atom, matches } = settled.value

    let crossCatCount = 0
    let intraCatCount = 0
    for (const match of matches) {
      if (match.id === atom.id) continue
      const neighborCat = (match.metadata as Record<string, string> | undefined)?.category
      if (!neighborCat) continue

      const isSameCategory = neighborCat === atom.category_slug

      if (isSameCategory) {
        if (match.score < INTRA_CATEGORY_THRESHOLD) continue
        if (intraCatCount >= MAX_INTRA_CATEGORY) continue
        intraCatCount++
      } else {
        if (match.score < CROSS_CATEGORY_THRESHOLD) continue
        if (crossCatCount >= MAX_CROSS_CATEGORY) continue
        crossCatCount++
      }

      neighborIds.add(match.id)
      const type = match.score >= 0.75 ? 'resonates' : 'evokes'
      const scope = isSameCategory ? 'intra_category' as const : 'cross_category' as const
      const [lo, hi] = atom.id < match.id ? [atom.id, match.id] : [match.id, atom.id]
      toInsert.push({ a: lo, b: hi, type, strength: Math.round(match.score * 1000) / 1000, scope })
    }
  }

  if (toInsert.length === 0) return { inserted: 0 }

  // Validate neighbor IDs exist in D1 (Vectorize may have stale vectors for deleted atoms)
  // SQLite OR IGNORE does NOT cover FOREIGN KEY violations, so we must filter first
  const validIds = new Set<string>(atoms.map(a => a.id))
  const idsToCheck = [...neighborIds].filter(id => !validIds.has(id))

  if (idsToCheck.length > 0) {
    // Check in batches of 50 (D1 query param limit)
    for (let i = 0; i < idsToCheck.length; i += 50) {
      const chunk = idsToCheck.slice(i, i + 50)
      const placeholders = chunk.map(() => '?').join(',')
      const { results } = await db.prepare(
        `SELECT id FROM atoms WHERE id IN (${placeholders})`
      ).bind(...chunk).all<{ id: string }>()
      for (const row of results) {
        validIds.add(row.id)
      }
    }
  }

  // Deduplicate within this batch + filter out stale neighbor IDs
  const seen = new Set<string>()
  const unique = toInsert.filter(c => {
    if (!validIds.has(c.a) || !validIds.has(c.b)) return false
    const key = `${c.a}|${c.b}|${c.type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (unique.length === 0) return { inserted: 0 }

  // Batch insert (100 per D1 batch call)
  let inserted = 0
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    const stmts = chunk.map(corr =>
      db.prepare(
        `INSERT INTO correspondences (id, atom_a_id, atom_b_id, relationship_type, strength, provenance, arrangement_scope, scope, last_reinforced_at)
         VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, 'semantic', '', ?, datetime('now'))
         ON CONFLICT(atom_a_id, atom_b_id, relationship_type, arrangement_scope)
         DO UPDATE SET strength = MAX(correspondences.strength, excluded.strength),
                       last_reinforced_at = datetime('now')`
      ).bind(corr.a, corr.b, corr.type, corr.strength, corr.scope)
    )
    const results = await db.batch(stmts)
    for (const r of results) {
      inserted += r.meta?.changes ?? 0
    }
  }

  return { inserted }
}

/**
 * Delete all semantic correspondences (provenance='semantic').
 * Harmonic correspondences are preserved.
 */
export async function purgeSemanticCorrespondences(
  db: D1Database
): Promise<{ deleted: number }> {
  const result = await db.prepare(
    "DELETE FROM correspondences WHERE provenance = 'semantic'"
  ).run()
  return { deleted: result.meta.changes ?? 0 }
}
