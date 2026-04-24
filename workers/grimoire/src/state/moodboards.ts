/**
 * Moodboard artifact registry queries.
 * Operates on the moodboards table (migration 0031) and joins against
 * image_extraction_candidates for candidate counting.
 */

export type MoodboardStatus = 'pending' | 'extracted' | 'aggregated' | 'reviewed' | 'rejected'

export interface Moodboard {
  id: number
  moodboard_id: string
  source: string
  slug: string
  title: string | null
  source_url: string | null
  source_description: string | null
  license: string | null
  source_count: number
  composite_r2_key: string | null
  manifest_r2_key: string | null
  ir_r2_key: string | null
  status: MoodboardStatus
  created_at: string
  updated_at: string
  metadata: string | null
}

export interface CreateMoodboardInput {
  moodboard_id: string
  source: string
  slug: string
  title?: string | null
  source_url?: string | null
  source_description?: string | null
  license?: string | null
  source_count?: number
  composite_r2_key?: string | null
  manifest_r2_key?: string | null
  metadata?: string | null
}

export interface UpdateMoodboardPatch {
  ir_r2_key?: string
  composite_r2_key?: string
  manifest_r2_key?: string
  source_count?: number
  metadata?: string
}

export async function getMoodboardByBusinessId(
  db: D1Database,
  moodboard_id: string,
): Promise<Moodboard | null> {
  const row = await db
    .prepare('SELECT * FROM moodboards WHERE moodboard_id = ?1')
    .bind(moodboard_id)
    .first<Moodboard>()
  return row ?? null
}

export async function getMoodboardBySlug(
  db: D1Database,
  source: string,
  slug: string,
): Promise<Moodboard | null> {
  const row = await db
    .prepare('SELECT * FROM moodboards WHERE source = ?1 AND slug = ?2')
    .bind(source, slug)
    .first<Moodboard>()
  return row ?? null
}

export async function createMoodboard(
  db: D1Database,
  input: CreateMoodboardInput,
): Promise<Moodboard> {
  const sql = `
    INSERT INTO moodboards (
      moodboard_id, source, slug, title, source_url, source_description,
      license, source_count, composite_r2_key, manifest_r2_key, metadata
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT(moodboard_id) DO NOTHING
  `
  await db
    .prepare(sql)
    .bind(
      input.moodboard_id,
      input.source,
      input.slug,
      input.title ?? null,
      input.source_url ?? null,
      input.source_description ?? null,
      input.license ?? null,
      input.source_count ?? 0,
      input.composite_r2_key ?? null,
      input.manifest_r2_key ?? null,
      input.metadata ?? null,
    )
    .run()

  const row = await getMoodboardByBusinessId(db, input.moodboard_id)
  if (!row) {
    throw new Error(`createMoodboard failed: ${input.moodboard_id} not found after insert`)
  }
  return row
}

export async function updateMoodboardStatus(
  db: D1Database,
  moodboard_id: string,
  status: MoodboardStatus,
  patch?: UpdateMoodboardPatch,
): Promise<void> {
  const sets: string[] = ['status = ?2', "updated_at = datetime('now')"]
  const params: (string | number | null)[] = [moodboard_id, status]
  let paramIndex = 3

  if (patch?.ir_r2_key !== undefined) {
    sets.push(`ir_r2_key = ?${paramIndex}`)
    params.push(patch.ir_r2_key)
    paramIndex++
  }
  if (patch?.composite_r2_key !== undefined) {
    sets.push(`composite_r2_key = ?${paramIndex}`)
    params.push(patch.composite_r2_key)
    paramIndex++
  }
  if (patch?.manifest_r2_key !== undefined) {
    sets.push(`manifest_r2_key = ?${paramIndex}`)
    params.push(patch.manifest_r2_key)
    paramIndex++
  }
  if (patch?.source_count !== undefined) {
    sets.push(`source_count = ?${paramIndex}`)
    params.push(patch.source_count)
    paramIndex++
  }
  if (patch?.metadata !== undefined) {
    sets.push(`metadata = ?${paramIndex}`)
    params.push(patch.metadata)
    paramIndex++
  }

  const sql = `UPDATE moodboards SET ${sets.join(', ')} WHERE moodboard_id = ?1`
  await db.prepare(sql).bind(...params).run()
}

export async function countCandidatesForMoodboard(
  db: D1Database,
  moodboard_id: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS cnt FROM image_extraction_candidates WHERE moodboard_id = ?1')
    .bind(moodboard_id)
    .first<{ cnt: number }>()
  return row?.cnt ?? 0
}

export async function listCandidateSourceUrlsForMoodboard(
  db: D1Database,
  moodboard_id: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      'SELECT DISTINCT source_url FROM image_extraction_candidates WHERE moodboard_id = ?1 ORDER BY source_url',
    )
    .bind(moodboard_id)
    .all<{ source_url: string }>()
  return (result.results ?? []).map((r) => r.source_url)
}
