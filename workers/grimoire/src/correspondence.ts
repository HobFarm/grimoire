// Shared semantic correspondence discovery logic
// Used by both admin endpoint (bulk rebuild) and cron Phase 6 (ongoing)

interface CorrespondenceCandidate {
  a: string
  b: string
  type: string
  strength: number
}

/**
 * Discover semantic correspondences for a batch of atoms.
 * Queries Vectorize for nearest neighbors, filters to cross-category matches,
 * validates neighbor IDs exist in D1 (Vectorize may contain stale vectors),
 * and inserts new correspondences with INSERT OR IGNORE.
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

  // Query neighbors sequentially
  for (const atom of atoms) {
    const vec = vectorMap.get(atom.id)
    if (!vec) continue

    try {
      const matches = await vectorize.query(vec, {
        topK: 50,
        returnMetadata: 'indexed',
        returnValues: false,
      })

      let crossCatCount = 0
      for (const match of matches.matches) {
        if (match.id === atom.id) continue
        const neighborCat = (match.metadata as Record<string, string> | undefined)?.category
        if (!neighborCat || neighborCat === atom.category_slug) continue
        if (match.score < 0.65) continue
        if (crossCatCount >= 10) break
        crossCatCount++

        neighborIds.add(match.id)
        const type = match.score >= 0.75 ? 'resonates' : 'evokes'
        const [lo, hi] = atom.id < match.id ? [atom.id, match.id] : [match.id, atom.id]
        toInsert.push({ a: lo, b: hi, type, strength: Math.round(match.score * 1000) / 1000 })
      }
    } catch (err) {
      console.error(`[correspondence] query failed for atom ${atom.id}:`, err)
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
        "INSERT OR IGNORE INTO correspondences (id, atom_a_id, atom_b_id, relationship_type, strength, provenance) VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, 'semantic')"
      ).bind(corr.a, corr.b, corr.type, corr.strength)
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
