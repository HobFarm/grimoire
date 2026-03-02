import type { CollectionRow, CollectionTree } from './types'

export async function listCollections(db: D1Database): Promise<CollectionRow[]> {
  const res = await db.prepare('SELECT * FROM collections ORDER BY slug').all<CollectionRow>()
  return res.results
}

export async function getCollectionTree(db: D1Database): Promise<CollectionTree[]> {
  const rows = await listCollections(db)

  const nodeMap = new Map<string, CollectionTree>()
  for (const row of rows) {
    nodeMap.set(row.slug, { ...row, children: [] })
  }

  const roots: CollectionTree[] = []
  for (const node of nodeMap.values()) {
    if (node.parent_slug) {
      const parent = nodeMap.get(node.parent_slug)
      if (parent) {
        parent.children.push(node)
        continue
      }
    }
    roots.push(node)
  }

  return roots
}

export async function getCollection(
  db: D1Database,
  slug: string
): Promise<CollectionRow | null> {
  return db
    .prepare('SELECT * FROM collections WHERE slug = ?')
    .bind(slug)
    .first<CollectionRow>()
}

export async function createCollection(
  db: D1Database,
  input: { slug: string; name: string; description?: string; parent_slug?: string }
): Promise<CollectionRow> {
  const now = new Date().toISOString()
  await db
    .prepare(
      'INSERT INTO collections (slug, name, description, parent_slug, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(input.slug, input.name, input.description ?? null, input.parent_slug ?? null, now)
    .run()

  const row = await getCollection(db, input.slug)
  return row!
}

export async function updateCollection(
  db: D1Database,
  slug: string,
  input: { name?: string; description?: string; parent_slug?: string | null }
): Promise<CollectionRow | null> {
  const existing = await getCollection(db, slug)
  if (!existing) return null

  const fields: string[] = []
  const values: unknown[] = []

  if (input.name !== undefined) {
    fields.push('name = ?')
    values.push(input.name)
  }
  if (input.description !== undefined) {
    fields.push('description = ?')
    values.push(input.description)
  }
  if (input.parent_slug !== undefined) {
    fields.push('parent_slug = ?')
    values.push(input.parent_slug)
  }

  if (fields.length === 0) return existing

  values.push(slug)
  await db
    .prepare(`UPDATE collections SET ${fields.join(', ')} WHERE slug = ?`)
    .bind(...values)
    .run()

  return getCollection(db, slug)
}

export async function deleteCollection(
  db: D1Database,
  slug: string
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM collections WHERE slug = ?')
    .bind(slug)
    .run()
  return (res.meta.changes ?? 0) > 0
}

export async function getCollectionSlugs(
  db: D1Database
): Promise<Array<{ slug: string; name: string; description: string | null }>> {
  const res = await db
    .prepare('SELECT slug, name, description FROM collections ORDER BY slug')
    .all<{ slug: string; name: string; description: string | null }>()
  return res.results
}
