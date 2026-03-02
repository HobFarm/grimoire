import type { CategoryRow, ContextRow, RelationRow, ResolvedCategory, ResolvedContext } from './types'

/**
 * Resolve glob patterns to actual category rows from D1.
 * Patterns: "*" = all, "covering.*" = parent match, "covering.clothing" = exact slug.
 */
export async function resolveCategories(
  db: D1Database,
  patterns: string[]
): Promise<ResolvedCategory[]> {
  const seen = new Set<string>()
  const results: ResolvedCategory[] = []

  for (const pattern of patterns) {
    let rows: CategoryRow[]

    if (pattern === '*') {
      const res = await db.prepare('SELECT * FROM categories').all<CategoryRow>()
      rows = res.results
    } else if (pattern.endsWith('.*')) {
      const parent = pattern.slice(0, -2)
      const res = await db.prepare('SELECT * FROM categories WHERE parent = ?')
        .bind(parent)
        .all<CategoryRow>()
      rows = res.results
    } else {
      const row = await db.prepare('SELECT * FROM categories WHERE slug = ?')
        .bind(pattern)
        .first<CategoryRow>()
      rows = row ? [row] : []
    }

    for (const row of rows) {
      if (seen.has(row.slug)) continue
      seen.add(row.slug)
      results.push({
        slug: row.slug,
        parent: row.parent,
        label: row.label,
        description: row.description,
        output_schema: JSON.parse(row.output_schema),
      })
    }
  }

  return results
}

/**
 * Fetch context guidance for resolved categories + requested contexts.
 * Always includes "default" context.
 */
export async function getContextGuidance(
  db: D1Database,
  categorySlugs: string[],
  contexts: string[]
): Promise<ResolvedContext[]> {
  const allContexts = new Set(contexts)
  allContexts.add('default')
  const contextList = Array.from(allContexts)

  if (categorySlugs.length === 0) return []

  const slugPlaceholders = categorySlugs.map(() => '?').join(',')
  const ctxPlaceholders = contextList.map(() => '?').join(',')

  const res = await db
    .prepare(
      `SELECT category_slug, context, guidance FROM category_contexts
       WHERE category_slug IN (${slugPlaceholders})
       AND context IN (${ctxPlaceholders})`
    )
    .bind(...categorySlugs, ...contextList)
    .all<ContextRow>()

  return res.results
}

/**
 * Fetch category relations where at least one side is in the resolved category slugs.
 * Gives the agent context about overlaps, exclusions, and pairings even when only
 * one side of the relation is being classified.
 */
export async function getRelevantRelations(
  db: D1Database,
  categorySlugs: string[]
): Promise<RelationRow[]> {
  if (categorySlugs.length === 0) return []

  const placeholders = categorySlugs.map(() => '?').join(',')

  const res = await db
    .prepare(
      `SELECT source_slug, target_slug, relation, note FROM category_relations
       WHERE source_slug IN (${placeholders})
       OR target_slug IN (${placeholders})`
    )
    .bind(...categorySlugs, ...categorySlugs)
    .all<RelationRow>()

  return res.results
}

/**
 * List categories, optionally filtered by parent group.
 */
export async function listCategories(
  db: D1Database,
  parent?: string
): Promise<CategoryRow[]> {
  if (parent) {
    const res = await db
      .prepare('SELECT * FROM categories WHERE parent = ? ORDER BY slug')
      .bind(parent)
      .all<CategoryRow>()
    return res.results
  }
  const res = await db.prepare('SELECT * FROM categories ORDER BY slug').all<CategoryRow>()
  return res.results
}

/**
 * Get context guidance for a specific category, optionally filtered by context name.
 */
export async function getCategoryContexts(
  db: D1Database,
  slug: string,
  contextFilter?: string
): Promise<ContextRow[]> {
  if (contextFilter) {
    const res = await db
      .prepare(
        'SELECT category_slug, context, guidance FROM category_contexts WHERE category_slug = ? AND context = ?'
      )
      .bind(slug, contextFilter)
      .all<ContextRow>()
    return res.results
  }
  const res = await db
    .prepare('SELECT category_slug, context, guidance FROM category_contexts WHERE category_slug = ? ORDER BY context')
    .bind(slug)
    .all<ContextRow>()
  return res.results
}

/**
 * Get all valid category slugs (for error messages).
 */
export async function getAllSlugs(db: D1Database): Promise<string[]> {
  const res = await db.prepare('SELECT slug FROM categories ORDER BY slug').all<{ slug: string }>()
  return res.results.map(r => r.slug)
}
