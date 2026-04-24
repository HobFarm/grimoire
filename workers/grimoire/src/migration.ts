import { generateId } from './atoms'

// --- Filter interface (parameterized, no raw SQL) ---

export interface MigrationFilter {
  min_length?: number
  max_length?: number
  category_like?: string
  category_in?: string[]
  text_like?: string
  text_pattern?: string   // uses ESCAPE '\'
  text_in?: string[]
  text_not_in?: string[]
  text_glob?: string
  category_is_null?: boolean
}

interface MigrateParams {
  doc_title: string
  doc_description: string
  doc_tags: string[]
  filter: MigrationFilter
  dry_run?: boolean
}

interface RejectParams {
  filter: MigrationFilter
  reason: string
  dry_run?: boolean
}

interface MigrateResult {
  document_id: string | null
  chunks_created: number
  atoms_rejected: number
  dry_run: boolean
  sample?: Array<{ id: string; text: string }>
}

interface RejectResult {
  atoms_rejected: number
  dry_run: boolean
  sample?: Array<{ id: string; text: string }>
}

// --- Filter builder ---

function buildFilterQuery(filter: MigrationFilter): { conditions: string[]; binds: (string | number)[] } {
  const conditions: string[] = ["status != 'rejected'"]
  const binds: (string | number)[] = []

  if (filter.min_length != null) {
    conditions.push('length(text_lower) > ?')
    binds.push(filter.min_length)
  }
  if (filter.max_length != null) {
    conditions.push('length(text_lower) <= ?')
    binds.push(filter.max_length)
  }
  if (filter.category_like) {
    conditions.push('category_slug LIKE ?')
    binds.push(filter.category_like)
  }
  if (filter.category_in && filter.category_in.length > 0) {
    const placeholders = filter.category_in.map(() => '?').join(',')
    conditions.push(`category_slug IN (${placeholders})`)
    binds.push(...filter.category_in)
  }
  if (filter.text_like) {
    conditions.push('text_lower LIKE ?')
    binds.push(filter.text_like)
  }
  if (filter.text_pattern) {
    conditions.push("text LIKE ? ESCAPE '\\'")
    binds.push(filter.text_pattern)
  }
  if (filter.text_in && filter.text_in.length > 0) {
    const placeholders = filter.text_in.map(() => '?').join(',')
    conditions.push(`text_lower IN (${placeholders})`)
    binds.push(...filter.text_in)
  }
  if (filter.text_not_in && filter.text_not_in.length > 0) {
    const placeholders = filter.text_not_in.map(() => '?').join(',')
    conditions.push(`text_lower NOT IN (${placeholders})`)
    binds.push(...filter.text_not_in)
  }
  if (filter.text_glob) {
    conditions.push('text_lower GLOB ?')
    binds.push(filter.text_glob)
  }
  if (filter.category_is_null) {
    conditions.push('category_slug IS NULL')
  }

  return { conditions, binds }
}

function hasFilterCriteria(filter: MigrationFilter): boolean {
  return !!(
    filter.min_length != null ||
    filter.max_length != null ||
    filter.category_like ||
    (filter.category_in && filter.category_in.length > 0) ||
    filter.text_like ||
    filter.text_pattern ||
    (filter.text_in && filter.text_in.length > 0) ||
    (filter.text_not_in && filter.text_not_in.length > 0) ||
    filter.text_glob ||
    filter.category_is_null
  )
}

// --- Migrate atoms to document chunks ---

export async function migrateAtoms(db: D1Database, params: MigrateParams): Promise<MigrateResult> {
  if (!hasFilterCriteria(params.filter)) {
    throw new Error('At least one filter criterion is required')
  }

  const { conditions, binds } = buildFilterQuery(params.filter)
  const where = conditions.join(' AND ')

  // Count matching atoms
  const countRes = await db
    .prepare(`SELECT COUNT(*) as count FROM atoms WHERE ${where}`)
    .bind(...binds)
    .first<{ count: number }>()
  const total = countRes?.count ?? 0

  if (params.dry_run) {
    const sampleRes = await db
      .prepare(`SELECT id, text FROM atoms WHERE ${where} LIMIT 5`)
      .bind(...binds)
      .all<{ id: string; text: string }>()
    return {
      document_id: null,
      chunks_created: total,
      atoms_rejected: total,
      dry_run: true,
      sample: sampleRes.results,
    }
  }

  if (total === 0) {
    return { document_id: null, chunks_created: 0, atoms_rejected: 0, dry_run: false }
  }

  // Fetch all matching atoms
  const atomsRes = await db
    .prepare(
      `SELECT id, text, text_lower, category_slug, collection_slug, harmonics, arrangement_tags
       FROM atoms WHERE ${where}`
    )
    .bind(...binds)
    .all<{
      id: string
      text: string
      text_lower: string
      category_slug: string | null
      collection_slug: string
      harmonics: string | null
      arrangement_tags: string | null
    }>()
  const atoms = atomsRes.results

  // Create document
  const docId = generateId()
  const tagsJson = JSON.stringify(params.doc_tags)

  await db
    .prepare(
      `INSERT INTO documents (id, title, description, mime_type, tags, chunk_count, status, source_app, created_at, updated_at)
       VALUES (?, ?, ?, 'text/plain', ?, 0, 'chunked', 'migration-v1', datetime('now'), datetime('now'))`
    )
    .bind(docId, params.doc_title, params.doc_description, tagsJson)
    .run()

  // Process in batches of 50 (2 stmts per atom = 100 per db.batch())
  const BATCH_SIZE = 50
  let totalTokens = 0

  for (let offset = 0; offset < atoms.length; offset += BATCH_SIZE) {
    const batch = atoms.slice(offset, offset + BATCH_SIZE)
    const stmts: D1PreparedStatement[] = []

    for (let i = 0; i < batch.length; i++) {
      const atom = batch[i]
      const chunkId = generateId()
      const chunkIndex = offset + i

      // Extract arrangement slugs from JSON
      let arrangementSlugs: string[] = []
      try {
        const tags = JSON.parse(atom.arrangement_tags || '[]')
        arrangementSlugs = tags.map((t: { slug: string }) => t.slug).filter((s: string) => s !== 'unaffiliated')
      } catch {}

      const chunkMeta = JSON.stringify({
        source_atom_id: atom.id,
        source_collection: atom.collection_slug,
        original_harmonics: atom.harmonics ? JSON.parse(atom.harmonics) : {},
      })

      totalTokens += Math.ceil(atom.text.length / 4)

      stmts.push(
        db
          .prepare(
            `INSERT INTO document_chunks (id, document_id, chunk_index, content, category_slug, arrangement_slugs, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(
            chunkId,
            docId,
            chunkIndex,
            atom.text,
            atom.category_slug,
            JSON.stringify(arrangementSlugs),
            chunkMeta
          )
      )

      // Dual-write: arrangement_chunks join table
      for (const slug of arrangementSlugs) {
        stmts.push(
          db.prepare(
            'INSERT OR IGNORE INTO arrangement_chunks (arrangement_slug, chunk_id) VALUES (?, ?)'
          ).bind(slug, chunkId)
        )
      }

      const migrationReason = params.doc_tags[0] || 'migrated'
      stmts.push(
        db
          .prepare(
            `UPDATE atoms SET status = 'rejected',
             metadata = json_set(COALESCE(metadata, '{}'), '$.migrated_to_doc', ?, '$.migration_reason', ?),
             updated_at = datetime('now')
             WHERE id = ?`
          )
          .bind(docId, migrationReason, atom.id)
      )
    }

    await db.batch(stmts)
  }

  // Update document with final counts
  await db
    .prepare(
      `UPDATE documents SET chunk_count = ?, token_count = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(atoms.length, totalTokens, docId)
    .run()

  return {
    document_id: docId,
    chunks_created: atoms.length,
    atoms_rejected: atoms.length,
    dry_run: false,
  }
}

// --- Reject atoms (no document creation) ---

export async function rejectAtoms(db: D1Database, params: RejectParams): Promise<RejectResult> {
  if (!hasFilterCriteria(params.filter)) {
    throw new Error('At least one filter criterion is required')
  }

  const { conditions, binds } = buildFilterQuery(params.filter)
  const where = conditions.join(' AND ')

  // Count matching atoms
  const countRes = await db
    .prepare(`SELECT COUNT(*) as count FROM atoms WHERE ${where}`)
    .bind(...binds)
    .first<{ count: number }>()
  const total = countRes?.count ?? 0

  if (params.dry_run) {
    const sampleRes = await db
      .prepare(`SELECT id, text FROM atoms WHERE ${where} LIMIT 5`)
      .bind(...binds)
      .all<{ id: string; text: string }>()
    return {
      atoms_rejected: total,
      dry_run: true,
      sample: sampleRes.results,
    }
  }

  if (total === 0) {
    return { atoms_rejected: 0, dry_run: false }
  }

  // Fetch all matching atom IDs
  const atomsRes = await db
    .prepare(`SELECT id FROM atoms WHERE ${where}`)
    .bind(...binds)
    .all<{ id: string }>()
  const atoms = atomsRes.results

  // Batch reject in chunks of 100
  const BATCH_SIZE = 100
  for (let offset = 0; offset < atoms.length; offset += BATCH_SIZE) {
    const batch = atoms.slice(offset, offset + BATCH_SIZE)
    const stmts = batch.map((atom) =>
      db
        .prepare(
          `UPDATE atoms SET status = 'rejected',
           metadata = json_set(COALESCE(metadata, '{}'), '$.rejection_reason', ?),
           updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(params.reason, atom.id)
    )
    await db.batch(stmts)
  }

  return { atoms_rejected: atoms.length, dry_run: false }
}

// --- Atom validation gate ---

export function isValidAtom(text: string): { valid: boolean; reason?: string } {
  const trimmed = text.trim()
  if (trimmed.length < 3) return { valid: false, reason: 'too_short' }
  if (trimmed.length > 80) return { valid: false, reason: 'too_long' }
  if (/^[#/\-]/.test(trimmed) && (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('--'))) {
    return { valid: false, reason: 'comment' }
  }
  if (trimmed.includes('\n')) return { valid: false, reason: 'multiline' }
  if (trimmed.split(/\s+/).length > 6) return { valid: false, reason: 'too_many_words' }
  if (/^:[a-z<>()3dp]{1,2}$/i.test(trimmed)) return { valid: false, reason: 'emoticon' }
  if (/^[\d\W]+$/.test(trimmed)) return { valid: false, reason: 'non_text' }
  if (/stock photo|clip ?art|vector illustration/i.test(trimmed)) return { valid: false, reason: 'stock_caption' }
  return { valid: true }
}
