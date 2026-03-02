import type {
  AtomRow,
  CreateAtomInput,
  UpdateAtomInput,
  BulkAtomResult,
  AtomListQuery,
  AtomStats,
} from './types'

const CONFIRMATION_THRESHOLD = 3

export function generateId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// --- CRUD ---

export async function getAtom(db: D1Database, id: string): Promise<AtomRow | null> {
  return db.prepare('SELECT * FROM atoms WHERE id = ?').bind(id).first<AtomRow>()
}

export async function createAtom(db: D1Database, input: CreateAtomInput): Promise<AtomRow> {
  const id = generateId()
  const textLower = input.text.toLowerCase().trim()
  const now = new Date().toISOString()

  // Default status based on source
  const status = input.status ?? (input.source === 'ai' ? 'provisional' : 'confirmed')
  const confidence = input.confidence ?? (input.source === 'ai' ? 0.5 : 1.0)

  await db
    .prepare(
      `INSERT INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at, category_slug, harmonics, modality)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.text,
      textLower,
      input.collection_slug,
      input.observation ?? 'observation',
      status,
      confidence,
      JSON.stringify(input.tags ?? []),
      input.source,
      input.source_app ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
      input.category_slug ?? null,
      input.harmonics ?? '{}',
      input.modality ?? 'visual',
    )
    .run()

  return (await getAtom(db, id))!
}

export async function updateAtom(
  db: D1Database,
  id: string,
  input: UpdateAtomInput
): Promise<AtomRow | null> {
  const existing = await getAtom(db, id)
  if (!existing) return null

  const fields: string[] = []
  const values: unknown[] = []

  if (input.text !== undefined) {
    fields.push('text = ?', 'text_lower = ?')
    values.push(input.text, input.text.toLowerCase().trim())
  }
  if (input.collection_slug !== undefined) {
    fields.push('collection_slug = ?')
    values.push(input.collection_slug)
  }
  if (input.observation !== undefined) {
    fields.push('observation = ?')
    values.push(input.observation)
  }
  if (input.status !== undefined) {
    fields.push('status = ?')
    values.push(input.status)
  }
  if (input.confidence !== undefined) {
    fields.push('confidence = ?')
    values.push(input.confidence)
  }
  if (input.tags !== undefined) {
    fields.push('tags = ?')
    values.push(JSON.stringify(input.tags))
  }
  if (input.source_app !== undefined) {
    fields.push('source_app = ?')
    values.push(input.source_app)
  }
  if (input.metadata !== undefined) {
    fields.push('metadata = ?')
    values.push(JSON.stringify(input.metadata))
  }

  if (fields.length === 0) return existing

  fields.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  await db
    .prepare(`UPDATE atoms SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  return getAtom(db, id)
}

export async function deleteAtom(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM atoms WHERE id = ?').bind(id).run()
  return (res.meta.changes ?? 0) > 0
}

// --- List / Search ---

export async function listAtoms(
  db: D1Database,
  query: AtomListQuery
): Promise<{ atoms: AtomRow[]; total: number }> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (query.collection_slug) {
    conditions.push('collection_slug = ?')
    params.push(query.collection_slug)
  }
  if (query.status) {
    conditions.push('status = ?')
    params.push(query.status)
  }
  if (query.source) {
    conditions.push('source = ?')
    params.push(query.source)
  }
  if (query.source_app) {
    conditions.push('source_app = ?')
    params.push(query.source_app)
  }
  if (query.q) {
    conditions.push("text_lower LIKE '%' || ? || '%'")
    params.push(query.q.toLowerCase().trim())
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(query.limit ?? 50, 500)
  const offset = query.offset ?? 0

  const countRes = await db
    .prepare(`SELECT COUNT(*) as total FROM atoms ${where}`)
    .bind(...params)
    .first<{ total: number }>()

  const res = await db
    .prepare(`SELECT * FROM atoms ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all<AtomRow>()

  return { atoms: res.results, total: countRes?.total ?? 0 }
}

// --- Encounter Lifecycle ---

export async function encounterAtom(db: D1Database, id: string): Promise<AtomRow | null> {
  const existing = await getAtom(db, id)
  if (!existing) return null

  const now = new Date().toISOString()
  const newCount = existing.encounter_count + 1

  // Auto-confirm provisionals at threshold
  const shouldConfirm =
    existing.status === 'provisional' && newCount >= CONFIRMATION_THRESHOLD

  if (shouldConfirm) {
    await db
      .prepare(
        'UPDATE atoms SET encounter_count = ?, status = ?, updated_at = ? WHERE id = ?'
      )
      .bind(newCount, 'confirmed', now, id)
      .run()
  } else {
    await db
      .prepare('UPDATE atoms SET encounter_count = ?, updated_at = ? WHERE id = ?')
      .bind(newCount, now, id)
      .run()
  }

  return getAtom(db, id)
}

export async function listAtomsForReview(
  db: D1Database,
  limit = 50,
  offset = 0
): Promise<{ atoms: AtomRow[]; total: number }> {
  const countRes = await db
    .prepare("SELECT COUNT(*) as total FROM atoms WHERE status = 'provisional'")
    .first<{ total: number }>()

  const res = await db
    .prepare(
      "SELECT * FROM atoms WHERE status = 'provisional' ORDER BY encounter_count DESC, created_at ASC LIMIT ? OFFSET ?"
    )
    .bind(Math.min(limit, 500), offset)
    .all<AtomRow>()

  return { atoms: res.results, total: countRes?.total ?? 0 }
}

// --- Bulk ---

export async function bulkInsertAtoms(
  db: D1Database,
  inputs: CreateAtomInput[]
): Promise<BulkAtomResult> {
  let inserted = 0
  let duplicates = 0
  let errors = 0

  // Process in chunks of 100
  for (let i = 0; i < inputs.length; i += 100) {
    const chunk = inputs.slice(i, i + 100)
    const statements: D1PreparedStatement[] = []

    for (const input of chunk) {
      const id = generateId()
      const textLower = input.text.toLowerCase().trim()
      const now = new Date().toISOString()
      const status = input.status ?? (input.source === 'ai' ? 'provisional' : 'confirmed')
      const confidence = input.confidence ?? (input.source === 'ai' ? 0.5 : 1.0)

      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            input.text,
            textLower,
            input.collection_slug,
            input.observation ?? 'observation',
            status,
            confidence,
            JSON.stringify(input.tags ?? []),
            input.source,
            input.source_app ?? null,
            JSON.stringify(input.metadata ?? {}),
            now,
            now
          )
      )
    }

    try {
      const results = await db.batch(statements)
      for (const r of results) {
        if ((r.meta.changes ?? 0) > 0) {
          inserted++
        } else {
          duplicates++
        }
      }
    } catch {
      errors += chunk.length
    }
  }

  return { inserted, duplicates, errors }
}

// --- Stats ---

export async function getAtomStats(db: D1Database): Promise<AtomStats> {
  const [totalRes, collectionRes, statusRes, sourceRes] = await db.batch([
    db.prepare('SELECT COUNT(*) as total FROM atoms'),
    db.prepare(
      'SELECT collection_slug as key, COUNT(*) as count FROM atoms GROUP BY collection_slug'
    ),
    db.prepare('SELECT status as key, COUNT(*) as count FROM atoms GROUP BY status'),
    db.prepare('SELECT source as key, COUNT(*) as count FROM atoms GROUP BY source'),
  ])

  const total =
    (totalRes.results[0] as unknown as { total: number })?.total ?? 0

  const toRecord = (rows: unknown[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const row of rows) {
      const r = row as { key: string; count: number }
      out[r.key] = r.count
    }
    return out
  }

  return {
    total,
    by_collection: toRecord(collectionRes.results),
    by_status: toRecord(statusRes.results),
    by_source: toRecord(sourceRes.results),
  }
}

// --- Taxonomy lookup (for discover prompt) ---

export async function getDistinctTaxonomy(
  db: D1Database
): Promise<string[]> {
  const [atomCollections, allCollections] = await db.batch([
    db.prepare('SELECT DISTINCT collection_slug FROM atoms'),
    db.prepare('SELECT slug FROM collections'),
  ])

  const slugs = new Set<string>()
  for (const row of atomCollections.results) {
    slugs.add((row as { collection_slug: string }).collection_slug)
  }
  for (const row of allCollections.results) {
    slugs.add((row as { slug: string }).slug)
  }

  return Array.from(slugs).sort()
}

// --- Lookup by text (for discover dedup) ---

export async function findAtomByText(
  db: D1Database,
  text: string
): Promise<AtomRow | null> {
  const textLower = text.toLowerCase().trim()
  return db
    .prepare('SELECT * FROM atoms WHERE text_lower = ?')
    .bind(textLower)
    .first<AtomRow>()
}
