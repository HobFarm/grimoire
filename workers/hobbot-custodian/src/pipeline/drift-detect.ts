// Correspondence drift detection
// Finds atoms with stale category assignments, orphaned collection references,
// and arrangements referencing missing categories

import { getArrangements } from '@shared/state/grimoire'
import type { IntegrityIssue } from '@shared/grimoire/types'

interface ScanChunk {
  id: string
  category_slug: string | null
  collection_slug: string
}

export async function detectDrift(db: D1Database): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = []

  const arrangements = await getArrangements(db)

  // Atoms referencing categories that don't exist in the categories table
  const badCatResult = await db.prepare(
    `SELECT id, category_slug FROM atoms
     WHERE category_slug IS NOT NULL AND category_slug != ''
     AND category_slug NOT IN (SELECT slug FROM categories)
     LIMIT 100`
  ).all<ScanChunk>()
  for (const row of badCatResult.results ?? []) {
    issues.push({
      type: 'missing_category',
      atom_id: row.id,
      description: `category '${row.category_slug}' not in categories table`,
      severity: 'high',
    })
  }

  // Atoms referencing collections that don't exist
  const badColResult = await db.prepare(
    `SELECT id, collection_slug FROM atoms
     WHERE collection_slug NOT IN (SELECT slug FROM collections)
     LIMIT 100`
  ).all<ScanChunk>()
  for (const row of badColResult.results ?? []) {
    issues.push({
      type: 'orphan',
      atom_id: row.id,
      description: `collection '${row.collection_slug}' not in collections table`,
      severity: 'medium',
    })
  }

  // Arrangements referencing missing categories
  const catSlugs = new Set(
    ((await db.prepare('SELECT slug FROM categories').all<{ slug: string }>()).results ?? []).map(r => r.slug)
  )
  for (const arr of arrangements) {
    const weights = arr.category_weights as Record<string, number>
    for (const slug of Object.keys(weights)) {
      if (!catSlugs.has(slug)) {
        issues.push({
          type: 'missing_category',
          description: `arrangement '${arr.slug}' references missing category '${slug}'`,
          severity: 'medium',
        })
      }
    }
  }

  // Atoms with complete embeddings but no correspondence entries (bounded sample)
  const embeddingRow = await db.prepare(
    `SELECT COUNT(*) as count FROM (
       SELECT a.id FROM atoms a
       LEFT JOIN correspondences c ON (c.atom_a_id = a.id OR c.atom_b_id = a.id)
       WHERE a.embedding_status = 'complete'
         AND a.status != 'rejected'
         AND c.id IS NULL
       LIMIT 1000
     )`
  ).first<{ count: number }>()
  const ungraphed = embeddingRow?.count ?? 0
  if (ungraphed > 0) {
    issues.push({
      type: 'embedding_gap',
      description: `${ungraphed}${ungraphed >= 1000 ? '+' : ''} atoms have complete embeddings but no correspondence entries`,
      severity: 'medium',
    })
  }

  // Correspondences referencing deleted atoms (sampled, limit to avoid full scan)
  const orphanedRefRow = await db.prepare(
    `SELECT COUNT(*) as count FROM (
       SELECT 1 FROM correspondences c
       WHERE NOT EXISTS (SELECT 1 FROM atoms WHERE id = c.atom_a_id)
          OR NOT EXISTS (SELECT 1 FROM atoms WHERE id = c.atom_b_id)
       LIMIT 1000
     )`
  ).first<{ count: number }>()
  const orphanedRefs = orphanedRefRow?.count ?? 0
  if (orphanedRefs > 0) {
    issues.push({
      type: 'orphaned_ref',
      description: `${orphanedRefs}+ correspondence rows reference atom IDs not in atoms table`,
      severity: 'high',
    })
  }

  // Categories with zero atoms (single query, no chunk scan)
  const emptyCatResult = await db.prepare(
    `SELECT c.slug FROM categories c
     WHERE NOT EXISTS (SELECT 1 FROM atoms WHERE category_slug = c.slug)
     LIMIT 20`
  ).all<{ slug: string }>()
  for (const row of emptyCatResult.results ?? []) {
    issues.push({
      type: 'coverage_gap',
      description: `category '${row.slug}' has no atoms assigned`,
      severity: 'low',
    })
  }

  return issues
}
