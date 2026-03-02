import { Hono } from 'hono'
import type { Env, AtomRow } from './types'
import { vectorizeAtomBatch, vectorizeBatchProcess } from './vectorize'
import { classifyAtom, classifyBatchProcess, classifyRegister } from './atom-classify'
import { generateId } from './atoms'
import { CATEGORY_MODALITY } from './constants'
import { discoverSemanticBatch, purgeSemanticCorrespondences } from './correspondence'

const adminApp = new Hono<{ Bindings: Env }>()

// D1 write with retry for transient DO resets (error 7500)
async function d1WriteWithRetry(
  db: D1Database, sql: string, binds: unknown[], maxRetries = 3
): Promise<D1Result> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await db.prepare(sql).bind(...binds).run()
    } catch (err) {
      if (attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, attempt * 2000))
    }
  }
  throw new Error('unreachable')
}

// --- POST /vectorize-batch ---

adminApp.post('/vectorize-batch', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
  const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 1000)

  const result = await vectorizeBatchProcess(c.env.DB, c.env.AI, c.env.VECTORIZE, { limit })

  const remainingRes = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL"
  ).first<{ count: number }>()

  return c.json({ ...result, remaining: remainingRes?.count ?? 0 })
})

// --- POST /classify-batch ---

adminApp.post('/classify-batch', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100)

  const result = await classifyBatchProcess(c.env.DB, c.env.GEMINI_API_KEY, { limit })

  const remainingRes = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM atoms WHERE (category_slug IS NULL OR category_slug = '')"
  ).first<{ count: number }>()

  return c.json({ classified: result.classified, failed: result.failed, remaining: remainingRes?.count ?? 0 })
})

// --- POST /ingest-batch ---

adminApp.post('/ingest-batch', async (c) => {
  const { atoms } = await c.req.json()
  if (!Array.isArray(atoms) || atoms.length === 0) {
    return c.json({ error: 'atoms array required' }, 400)
  }

  const db = c.env.DB
  const limit = Math.min(atoms.length, 1000)
  const batch = atoms.slice(0, limit)

  let inserted = 0
  let skipped = 0

  const CHUNK = 50
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK)
    const stmts: D1PreparedStatement[] = []

    for (const atom of chunk) {
      const text = (atom.text || '').trim()
      const collection = (atom.collection_slug || 'uncategorized').trim()
      const category = atom.category_slug ? atom.category_slug.trim() : null
      if (!text || text.length > 500) continue

      const id = generateId()
      const textLower = text.toLowerCase()
      const now = new Date().toISOString()

      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, category_slug, observation, status, confidence, encounter_count, tags, source, metadata, embedding_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'observation', 'provisional', 0.5, 1, '[]', 'manual', '{}', 'pending', ?, ?)`
        ).bind(id, text, textLower, collection, category, now, now)
      )
    }

    if (stmts.length > 0) {
      try {
        const results = await db.batch(stmts)
        for (const r of results) {
          if ((r.meta?.changes ?? 0) > 0) inserted++
          else skipped++
        }
      } catch (err: unknown) {
        skipped += stmts.length
        console.error(`batch insert error: ${(err as Error).message}`)
      }
    }
  }

  return c.json({
    inserted,
    skipped,
    total: batch.length,
    remaining: Math.max(0, atoms.length - limit),
  })
})

// --- GET /status ---

adminApp.get('/status', async (c) => {
  const [totalRes, classifiedRes, embeddingRes] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM atoms'),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM atoms WHERE category_slug IS NOT NULL'),
    c.env.DB.prepare('SELECT embedding_status, COUNT(*) as count FROM atoms GROUP BY embedding_status'),
  ])

  const total = (totalRes.results[0] as unknown as { count: number })?.count ?? 0
  const classified = (classifiedRes.results[0] as unknown as { count: number })?.count ?? 0

  const embedding_status: Record<string, number> = {
    pending: 0,
    processing: 0,
    complete: 0,
    failed: 0,
  }

  for (const row of embeddingRes.results) {
    const r = row as { embedding_status: string; count: number }
    if (r.embedding_status in embedding_status) {
      embedding_status[r.embedding_status] = r.count
    }
  }

  return c.json({
    total,
    classified,
    unclassified: total - classified,
    embedding_status,
  })
})


// --- POST /discover-correspondences ---

adminApp.post('/discover-correspondences', async (c) => {
  const body = await c.req.json<{
    min_match?: number      // 4 or 5 harmonic dimensions must match (default 5)
    max_per_atom?: number   // cap correspondences per atom (default 5)
    relationship?: string   // 'resonates' | 'opposes' | 'both' (default 'both')
    dry_run?: boolean
  }>().catch(() => ({}))

  const minMatch = Math.max(3, Math.min(5, Number(body.min_match) || 5))
  const maxPerAtom = Math.max(1, Math.min(20, Number(body.max_per_atom) || 5))
  const relationship = body.relationship || 'both'
  const dryRun = body.dry_run ?? false

  // Fetch all atoms with harmonics
  const { results: atoms } = await c.env.DB.prepare(
    "SELECT id, text_lower, category_slug, harmonics, modality FROM atoms WHERE length(harmonics) > 2 AND category_slug IS NOT NULL"
  ).all<{ id: string; text_lower: string; category_slug: string; harmonics: string; modality: string }>()

  // Parse harmonics and build profile groups
  interface ParsedAtom {
    id: string
    text_lower: string
    category_slug: string
    modality: string
    h: { hardness: string; temperature: string; weight: string; formality: string; era_affinity: string }
    profileKey: string
  }

  const parsed: ParsedAtom[] = []
  for (const atom of atoms) {
    try {
      const h = JSON.parse(atom.harmonics)
      if (!h.hardness) continue
      parsed.push({
        id: atom.id,
        text_lower: atom.text_lower,
        category_slug: atom.category_slug,
        modality: atom.modality,
        h,
        profileKey: `${h.hardness}|${h.temperature}|${h.weight}|${h.formality}|${h.era_affinity}`,
      })
    } catch { continue }
  }

  // Group by profile key
  const profileGroups = new Map<string, ParsedAtom[]>()
  for (const atom of parsed) {
    const group = profileGroups.get(atom.profileKey) || []
    group.push(atom)
    profileGroups.set(atom.profileKey, group)
  }

  // Opposite mapping for opposition detection
  const OPPOSITES: Record<string, Record<string, string>> = {
    hardness: { hard: 'soft', soft: 'hard' },
    temperature: { warm: 'cool', cool: 'warm' },
    weight: { heavy: 'light', light: 'heavy' },
    formality: { structured: 'organic', organic: 'structured' },
  }

  function harmonicMatchCount(a: ParsedAtom, b: ParsedAtom): number {
    let m = 0
    if (a.h.hardness === b.h.hardness) m++
    if (a.h.temperature === b.h.temperature) m++
    if (a.h.weight === b.h.weight) m++
    if (a.h.formality === b.h.formality) m++
    if (a.h.era_affinity === b.h.era_affinity) m++
    return m
  }

  function oppositionCount(a: ParsedAtom, b: ParsedAtom): number {
    let o = 0
    for (const dim of ['hardness', 'temperature', 'weight', 'formality'] as const) {
      if (OPPOSITES[dim]?.[a.h[dim]] === b.h[dim]) o++
    }
    return o
  }

  // Track per-atom correspondence counts
  const atomCorrCount = new Map<string, number>()
  function canAdd(atomId: string): boolean {
    return (atomCorrCount.get(atomId) || 0) < maxPerAtom
  }
  function markAdded(a: string, b: string) {
    atomCorrCount.set(a, (atomCorrCount.get(a) || 0) + 1)
    atomCorrCount.set(b, (atomCorrCount.get(b) || 0) + 1)
  }

  // Collect correspondences
  const correspondences: Array<{
    atom_a_id: string; atom_b_id: string; type: string; strength: number
  }> = []

  // --- Resonates: cross-category atoms with matching harmonic profiles ---
  if (relationship === 'resonates' || relationship === 'both') {
    if (minMatch === 5) {
      // Exact profile match: use grouping (fast)
      for (const group of profileGroups.values()) {
        // Split by category
        const byCategory = new Map<string, ParsedAtom[]>()
        for (const atom of group) {
          const cat = byCategory.get(atom.category_slug) || []
          cat.push(atom)
          byCategory.set(atom.category_slug, cat)
        }
        if (byCategory.size < 2) continue

        const categories = [...byCategory.keys()]
        for (let ci = 0; ci < categories.length; ci++) {
          for (let cj = ci + 1; cj < categories.length; cj++) {
            const catA = byCategory.get(categories[ci])!
            const catB = byCategory.get(categories[cj])!
            for (const a of catA) {
              if (!canAdd(a.id)) continue
              for (const b of catB) {
                if (!canAdd(b.id)) continue
                const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
                correspondences.push({ atom_a_id: lo, atom_b_id: hi, type: 'resonates', strength: 1.0 })
                markAdded(a.id, b.id)
                break // one per atom pair direction per category pair
              }
            }
          }
        }
      }
    } else {
      // Partial match: compare within overlapping profile groups
      // For each pair of profiles that differ by at most (5 - minMatch) dimensions
      const profileList = [...profileGroups.entries()]
      for (let pi = 0; pi < profileList.length; pi++) {
        for (let pj = pi + 1; pj < profileList.length; pj++) {
          const [, groupA] = profileList[pi]
          const [, groupB] = profileList[pj]
          // Quick check: sample one from each to see if they match enough
          if (groupA.length === 0 || groupB.length === 0) continue
          const matchCount = harmonicMatchCount(groupA[0], groupB[0])
          if (matchCount < minMatch) continue

          const strength = matchCount / 5
          for (const a of groupA) {
            if (!canAdd(a.id)) continue
            for (const b of groupB) {
              if (a.category_slug === b.category_slug) continue
              if (!canAdd(b.id)) continue
              const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
              correspondences.push({ atom_a_id: lo, atom_b_id: hi, type: 'resonates', strength })
              markAdded(a.id, b.id)
              break
            }
          }
        }
      }
    }
  }

  // --- Opposes: cross-category atoms with opposite harmonic profiles ---
  if (relationship === 'opposes' || relationship === 'both') {
    // Build opposite profile keys for each group
    function flipProfile(key: string): string | null {
      const [h, t, w, f, e] = key.split('|')
      const fh = OPPOSITES.hardness[h]
      const ft = OPPOSITES.temperature[t]
      const fw = OPPOSITES.weight[w]
      const ff = OPPOSITES.formality[f]
      if (!fh || !ft || !fw || !ff) return null
      return `${fh}|${ft}|${fw}|${ff}|${e}`
    }

    const seenOpposePairs = new Set<string>()
    for (const [profileKey, group] of profileGroups) {
      const oppKey = flipProfile(profileKey)
      if (!oppKey || oppKey === profileKey) continue
      const oppGroup = profileGroups.get(oppKey)
      if (!oppGroup) continue

      const pairKey = [profileKey, oppKey].sort().join('::')
      if (seenOpposePairs.has(pairKey)) continue
      seenOpposePairs.add(pairKey)

      for (const a of group) {
        if (!canAdd(a.id)) continue
        for (const b of oppGroup) {
          if (a.category_slug === b.category_slug) continue
          if (!canAdd(b.id)) continue
          const opp = oppositionCount(a, b)
          if (opp < 3) continue
          const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
          correspondences.push({ atom_a_id: lo, atom_b_id: hi, type: 'opposes', strength: opp / 4 })
          markAdded(a.id, b.id)
          break
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  const unique = correspondences.filter(c => {
    const key = `${c.atom_a_id}|${c.atom_b_id}|${c.type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let inserted = 0
  if (!dryRun && unique.length > 0) {
    // Batch insert (100 per batch, D1 limit)
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100)
      const stmts = chunk.map(corr =>
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO correspondences (id, atom_a_id, atom_b_id, relationship_type, strength, provenance) VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, 'harmonic')"
        ).bind(corr.atom_a_id, corr.atom_b_id, corr.type, corr.strength)
      )
      const results = await c.env.DB.batch(stmts)
      for (const r of results) {
        inserted += r.meta?.changes ?? 0
      }
    }
  }

  const resonatesCount = unique.filter(c => c.type === 'resonates').length
  const opposesCount = unique.filter(c => c.type === 'opposes').length

  return c.json({
    atoms_with_harmonics: parsed.length,
    profile_groups: profileGroups.size,
    correspondences_found: unique.length,
    resonates: resonatesCount,
    opposes: opposesCount,
    inserted,
    dry_run: dryRun,
    config: { minMatch, maxPerAtom, relationship },
  })
})

// --- POST /discover-semantic-correspondences ---

adminApp.post('/discover-semantic-correspondences', async (c) => {
  try {
    const body = await c.req.json<{ batchSize?: number; afterId?: string }>()
      .catch(() => ({} as { batchSize?: number; afterId?: string }))
    const batchSize = Math.min(Math.max(Number(body.batchSize) || 25, 1), 500)
    const afterId = body.afterId ?? ''

    // Cursor-based pagination: process all atoms sequentially by ID
    // Every atom gets queried exactly once regardless of existing correspondences
    const { results: atoms } = await c.env.DB.prepare(`
      SELECT a.id, a.text_lower, a.category_slug FROM atoms a
      WHERE a.embedding_status = 'complete'
        AND a.category_slug IS NOT NULL
        AND a.id > ?
      ORDER BY a.id LIMIT ?
    `).bind(afterId, batchSize).all<{ id: string; text_lower: string; category_slug: string }>()

    if (atoms.length === 0) {
      return c.json({ processed: 0, inserted: 0, remaining: 0, lastId: afterId })
    }

    const { inserted } = await discoverSemanticBatch(c.env.DB, c.env.VECTORIZE, atoms)

    const lastId = atoms[atoms.length - 1].id
    const remaining = atoms.length >= batchSize ? 1 : 0
    return c.json({ processed: atoms.length, inserted, remaining, lastId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    return c.json({ error: msg, stack }, 500)
  }
})

// --- POST /purge-semantic-correspondences ---

adminApp.post('/purge-semantic-correspondences', async (c) => {
  const { deleted } = await purgeSemanticCorrespondences(c.env.DB)
  return c.json({ deleted })
})

// --- POST /assign-modality ---

adminApp.post('/assign-modality', async (c) => {
  let updated = 0

  for (const [category, modality] of Object.entries(CATEGORY_MODALITY)) {
    const res = await c.env.DB.prepare(
      'UPDATE atoms SET modality = ? WHERE category_slug = ? AND modality != ?'
    ).bind(modality, category, modality).run()
    updated += res.meta.changes ?? 0
  }

  return c.json({ updated })
})

// --- POST /enrich-harmonics ---

adminApp.post('/enrich-harmonics', async (c) => {
  const body = await c.req.json<{ limit?: number; category?: string; collection?: string }>().catch(() => ({} as { limit?: number; category?: string; collection?: string }))
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 100)

  // Build query with optional filters
  const conditions = [
    "category_slug IS NOT NULL",
    "(harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2)",
    "status != 'rejected'"
  ]
  const binds: (string | number)[] = []

  if (body.category) {
    conditions.push("category_slug = ?")
    binds.push(body.category)
  }
  if (body.collection) {
    conditions.push("collection_slug = ?")
    binds.push(body.collection)
  }

  binds.push(limit)
  const sql = `SELECT id, text_lower, collection_slug, category_slug FROM atoms WHERE ${conditions.join(' AND ')} LIMIT ?`
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()

  let enriched = 0
  let failed = 0
  const sample: Array<{ id: string; text: string; harmonics: Record<string, string> }> = []

  // Process in chunks of 5 concurrent with 500ms delay
  for (let i = 0; i < results.length; i += 5) {
    if (i > 0) await new Promise(r => setTimeout(r, 500))
    const chunk = results.slice(i, i + 5)

    const settled = await Promise.allSettled(
      chunk.map(async (atom) => {
        const classification = await classifyAtom(
          atom.text_lower as string,
          c.env.GEMINI_API_KEY
        )
        if (!classification) return false

        // Update harmonics and modality only; preserve existing category_slug
        await d1WriteWithRetry(c.env.DB,
          "UPDATE atoms SET harmonics = ?, modality = ?, updated_at = datetime('now') WHERE id = ?",
          [JSON.stringify(classification.harmonics), classification.modality, atom.id]
        )

        if (sample.length < 3) {
          sample.push({ id: atom.id as string, text: atom.text_lower as string, harmonics: classification.harmonics })
        }
        return true
      })
    )

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) enriched++
      else failed++
    }
  }

  // Count remaining
  const remainingRes = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM atoms WHERE category_slug IS NOT NULL AND (harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2) AND status != 'rejected'"
  ).first<{ count: number }>()

  return c.json({ enriched, failed, remaining: remainingRes?.count ?? 0, sample })
})

// --- POST /register-classify-batch ---

adminApp.post('/register-classify-batch', async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }))
  const limit = Math.min(Math.max(Number(body.limit) || 30, 1), 100)

  const { results } = await c.env.DB.prepare(
    'SELECT id, text_lower, category_slug FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL ORDER BY RANDOM() LIMIT ?'
  ).bind(limit).all<{ id: string; text_lower: string; category_slug: string }>()

  let classified = 0
  const errors: Array<{ atom: string; error: string }> = []

  // Process in chunks of 4 concurrent Gemini calls with 500ms delay between chunks
  for (let i = 0; i < results.length; i += 4) {
    if (i > 0) await new Promise(r => setTimeout(r, 500))
    const chunk = results.slice(i, i + 4)
    const settled = await Promise.allSettled(
      chunk.map(async (atom) => {
        const result = await classifyRegister(
          atom.text_lower,
          atom.category_slug,
          c.env.GEMINI_API_KEY
        )
        if ('error' in result) {
          errors.push({ atom: atom.text_lower.slice(0, 40), error: result.error })
          return false
        }

        await d1WriteWithRetry(c.env.DB,
          'UPDATE atoms SET register = ? WHERE id = ?',
          [result.register, atom.id]
        )
        return true
      })
    )

    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        classified++
      }
    }
  }

  const remainingRes = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL'
  ).first<{ count: number }>()

  return c.json({ classified, remaining: remainingRes?.count ?? 0, errors })
})

export { adminApp }
