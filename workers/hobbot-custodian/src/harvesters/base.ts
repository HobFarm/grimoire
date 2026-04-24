import type { Env } from '../index'

export interface HarvesterResult {
  items_fetched: number
  items_ingested: number
  items_rejected: number
  items_skipped: number
  new_cursor: string | null
  error?: string
}

export interface Harvester {
  source_id: string
  harvest(env: Env, cursor: string | null, batch_size: number): Promise<HarvesterResult>
}

export interface SourceRecord {
  id: string
  name: string
  type: string
  endpoint_url: string | null
  sync_cadence: string
  sync_cursor: string | null
  transform_module: string
  target_collection: string
  rate_limit_per_second: number
  batch_size: number
  enabled: number
}

export interface AtomCandidate {
  text: string
  collection_slug: string
  source: 'seed' | 'ai' | 'manual'
  source_app: string
  category_slug?: string | null
  metadata?: Record<string, unknown>
  external_uri: string // for dedup tracking in source_atoms
}

export async function loadSource(db: D1Database, source_id: string): Promise<SourceRecord | null> {
  return db.prepare('SELECT * FROM sources WHERE id = ? AND enabled = 1').bind(source_id).first<SourceRecord>()
}

export async function startSyncRun(db: D1Database, source_id: string, cursor: string | null): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO sync_runs (source_id, started_at, status, cursor_before)
     VALUES (?, datetime('now'), 'running', ?)`
  ).bind(source_id, cursor).run()
  return result.meta.last_row_id as number
}

export async function completeSyncRun(
  db: D1Database,
  run_id: number,
  status: 'completed' | 'failed' | 'partial',
  result: HarvesterResult,
  cursor_after: string | null,
  error_message?: string
): Promise<void> {
  await db.prepare(
    `UPDATE sync_runs SET
      completed_at = datetime('now'),
      status = ?,
      items_fetched = ?,
      items_ingested = ?,
      items_rejected = ?,
      items_skipped = ?,
      error_message = ?,
      cursor_after = ?
    WHERE id = ?`
  ).bind(
    status,
    result.items_fetched,
    result.items_ingested,
    result.items_rejected,
    result.items_skipped,
    error_message ?? null,
    cursor_after,
    run_id
  ).run()
}

export async function checkDedup(db: D1Database, source_id: string, external_uri: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT id FROM source_atoms WHERE source_id = ? AND external_uri = ?'
  ).bind(source_id, external_uri).first()
  return row !== null
}

export async function recordSourceAtom(
  db: D1Database,
  source_id: string,
  external_uri: string,
  candidate_text: string,
  candidate_category: string | null,
  status: 'pending' | 'ingested' | 'rejected' | 'skipped',
  raw_data?: string
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO source_atoms (source_id, external_uri, candidate_text, candidate_category, status, raw_data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(source_id, external_uri, candidate_text, candidate_category, status, raw_data ?? null).run()
}

export async function batchRecordSourceAtoms(
  db: D1Database,
  atoms: { source_id: string; external_uri: string; candidate_text: string; candidate_category: string | null; status: string; raw_data?: string }[]
): Promise<void> {
  if (atoms.length === 0) return
  const stmts = atoms.map(a =>
    db.prepare(
      `INSERT OR IGNORE INTO source_atoms (source_id, external_uri, candidate_text, candidate_category, status, raw_data)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(a.source_id, a.external_uri, a.candidate_text, a.candidate_category, a.status, a.raw_data ?? null)
  )
  // D1 batch limit is 100 statements
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100))
  }
}

export async function updateSourceCursor(db: D1Database, source_id: string, cursor: string | null): Promise<void> {
  await db.prepare(
    `UPDATE sources SET sync_cursor = ?, last_sync_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).bind(cursor, source_id).run()
}

export async function ingestToGrimoire(
  grimoire: Fetcher,
  atoms: { text: string; collection_slug: string; source: string; source_app: string; category_slug?: string | null; metadata?: Record<string, unknown> }[]
): Promise<{ inserted: number; duplicates: number; errors: number }> {
  if (atoms.length === 0) return { inserted: 0, duplicates: 0, errors: 0 }

  const res = await grimoire.fetch(new Request('https://grimoire/atoms/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ atoms }),
  }))

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Grimoire ingest failed (${res.status}): ${text}`)
  }

  return res.json()
}

export async function ensureCollection(
  grimoire: Fetcher,
  slug: string,
  name: string,
  description: string,
): Promise<void> {
  const res = await grimoire.fetch(new Request(`https://grimoire/collections/${slug}`))
  if (res.ok) return // already exists

  const createRes = await grimoire.fetch(new Request('https://grimoire/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, name, description }),
  }))

  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text()
    throw new Error(`Failed to create collection '${slug}' (${createRes.status}): ${text}`)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
