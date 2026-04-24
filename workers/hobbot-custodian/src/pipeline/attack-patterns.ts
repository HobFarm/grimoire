// Immune pattern detection for the Grimoire write path
// Detects bulk override attempts, circular category relations, contradictory arrangements

import type { GrimoireAtom, IntegrityIssue } from '@shared/grimoire/types'
import { logValidationEvent } from '@shared/state/audit'

const BULK_IMPORT_THRESHOLD = 50

interface RecentInsertRow {
  source_app: string | null
  count: number
}

export async function detectBulkImport(db: D1Database): Promise<IntegrityIssue[]> {
  const cutoff = new Date()
  cutoff.setHours(cutoff.getHours() - 1)

  const result = await db.prepare(
    `SELECT source_app, COUNT(*) as count FROM atoms
     WHERE created_at >= ? AND source_app IS NOT NULL
     GROUP BY source_app HAVING count > ?`
  ).bind(cutoff.toISOString(), BULK_IMPORT_THRESHOLD).all<RecentInsertRow>()

  return (result.results ?? []).map(row => ({
    type: 'coverage_gap' as const,
    description: `bulk import: source_app='${row.source_app}' inserted ${row.count} atoms in last hour`,
    severity: 'high' as const,
  }))
}

interface CircularRelationRow {
  from_slug: string
  to_slug: string
}

export async function detectCircularRelations(db: D1Database): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = []

  const result = await db.prepare(
    'SELECT from_slug, to_slug FROM category_relations'
  ).all<CircularRelationRow>()

  const edges = result.results ?? []
  const edgeSet = new Set(edges.map(e => `${e.from_slug}:${e.to_slug}`))

  for (const edge of edges) {
    if (edgeSet.has(`${edge.to_slug}:${edge.from_slug}`)) {
      issues.push({
        type: 'circular_ref',
        description: `circular relation: ${edge.from_slug} <-> ${edge.to_slug}`,
        severity: 'medium',
      })
    }
  }

  return issues
}

export async function checkContradictoryArrangements(
  db: D1Database,
  atom: Partial<GrimoireAtom>
): Promise<IntegrityIssue[]> {
  if (!atom.category_slug) return []

  const result = await db.prepare(
    "SELECT slug, category_weights FROM arrangements WHERE category_weights LIKE ?"
  ).bind(`%"${atom.category_slug}"%`).all<{ slug: string; category_weights: string }>()

  const matches = result.results ?? []
  if (matches.length <= 1) return []

  const weights = matches.map(arr => {
    const parsed = JSON.parse(arr.category_weights) as Record<string, number>
    return parsed[atom.category_slug!] ?? 0
  })

  const spread = Math.max(...weights) - Math.min(...weights)
  if (spread > 0.8) {
    return [{
      type: 'coverage_gap',
      description: `category '${atom.category_slug}' has contradictory weights across ${matches.length} arrangements (spread=${spread.toFixed(2)})`,
      severity: 'low',
    }]
  }

  return []
}

export async function logImmuneThreat(
  db: D1Database,
  atomId: string | null,
  issues: IntegrityIssue[]
): Promise<void> {
  await logValidationEvent(db, 'scan', atomId, 'warn', { immune_issues: issues })
}
