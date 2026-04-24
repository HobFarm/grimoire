// Phase 8: Connectivity Agent.
// Event-driven KV-backed queue populated at atom confirmation sites, drained by
// cron Phase 8. Three algorithmic scorers (no LLM calls in Phase A):
//   - Tag propagation: neighbor vote via Vectorize similarity
//   - Dimensional membership: pole-centroid cosine distance (cached per axis)
//   - Correspondence discovery: Vectorize neighbor insertion
// Ambiguous band cases are counted in stats for Phase B (LLM tier) handoff.

import type {
  Env,
  ConnectivityStats,
  ConnectivityStatsDaily,
  ConnectivityStatsRun,
  ConnectivityStatsDailyTotals,
  ConnectivityAxisCentroids,
} from './types'

// --- Tunable constants ---

export const BATCH_SIZE = 50
const QUEUE_MAX_PENDING = 1000
const TAG_NEIGHBOR_TOPK = 15
const TAG_NEIGHBOR_SIM_THRESHOLD = 0.75
const TAG_PROPAGATE_MIN_VOTES = 3
const TAG_AMBIGUOUS_VOTES = 2
const CORR_NEIGHBOR_TOPK = 8
const CORR_NEIGHBOR_SIM_THRESHOLD = 0.8
const CORR_MIN_EXISTING = 3
const DIM_SIM_ASSIGN_THRESHOLD = 0.7
const DIM_SIM_GAP_REQUIREMENT = 0.2
const DIM_AMBIGUOUS_BAND_LOW = 0.5
const DIM_AMBIGUOUS_BAND_HIGH = 0.7
const DIM_MIN_SEED_COUNT = 3
const ROW_BUDGET = 50_000
const CENTROID_TTL_SECONDS = 3600
const STATS_TTL_SECONDS = 14 * 86400
const VECTORIZE_GETBYIDS_CHUNK = 20
const TAG_SOURCE = 'connectivity-agent'
const MEMBERSHIP_SOURCE = 'connectivity-agent'
const CHUNK_ID_PREFIX = 'doc_chunk_'

const KEY_PENDING = 'connectivity:pending'
const KEY_WATERMARK = 'connectivity:watermark'
const keyCentroids = (slug: string) => `connectivity:axis:${slug}:centroids`
const keyStats = (date: string) => `connectivity:stats:${date}`
const keyFailed = (date: string) => `connectivity:failed:${date}`
const FAILED_MAX_ENTRIES = 500

// --- Queue helpers (KV-backed) ---

export async function enqueueForConnectivity(kv: KVNamespace, atomId: string): Promise<void> {
  const raw = await kv.get(KEY_PENDING)
  const pending: string[] = raw ? JSON.parse(raw) : []
  if (pending.length >= QUEUE_MAX_PENDING) return
  if (pending.includes(atomId)) return
  pending.push(atomId)
  await kv.put(KEY_PENDING, JSON.stringify(pending))
}

export async function enqueueForConnectivityBatch(
  kv: KVNamespace,
  atomIds: string[],
): Promise<void> {
  if (atomIds.length === 0) return
  const raw = await kv.get(KEY_PENDING)
  const pending: string[] = raw ? JSON.parse(raw) : []
  const seen = new Set(pending)
  for (const id of atomIds) {
    if (pending.length >= QUEUE_MAX_PENDING) break
    if (seen.has(id)) continue
    seen.add(id)
    pending.push(id)
  }
  await kv.put(KEY_PENDING, JSON.stringify(pending))
}

export async function dequeueConnectivityBatch(
  kv: KVNamespace,
  batchSize: number,
): Promise<string[]> {
  const raw = await kv.get(KEY_PENDING)
  if (!raw) return []
  const pending: string[] = JSON.parse(raw)
  if (pending.length === 0) return []
  const batch = pending.splice(0, batchSize)
  await kv.put(KEY_PENDING, JSON.stringify(pending))
  return batch
}

export async function getSweepBatch(
  db: D1Database,
  watermark: string,
  limit: number,
): Promise<Array<{ id: string }>> {
  const { results } = await db
    .prepare("SELECT id FROM atoms WHERE status = 'confirmed' AND id > ? ORDER BY id LIMIT ?")
    .bind(watermark, limit)
    .all<{ id: string }>()
  return results
}

export async function getWatermark(kv: KVNamespace): Promise<string> {
  return (await kv.get(KEY_WATERMARK)) ?? ''
}

export async function setWatermark(kv: KVNamespace, watermark: string): Promise<void> {
  await kv.put(KEY_WATERMARK, watermark)
}

// Record a failed batch for investigation. Sweep failures should not block
// watermark advance (poison-atom protection); event failures re-enqueue to the
// pending queue instead, so their atoms also land here for visibility.
export async function recordFailedBatch(
  kv: KVNamespace,
  source: 'event' | 'sweep',
  atomIds: string[],
  error: string,
): Promise<void> {
  if (atomIds.length === 0) return
  const date = new Date().toISOString().slice(0, 10)
  const key = keyFailed(date)
  const raw = await kv.get(key)
  const existing: Array<{ at: string; source: string; atom_ids: string[]; error: string }> =
    raw ? JSON.parse(raw) : []
  existing.push({
    at: new Date().toISOString(),
    source,
    atom_ids: atomIds,
    error: error.slice(0, 500),
  })
  // Bound the log so a persistent bug can't balloon the KV value
  const trimmed = existing.slice(-FAILED_MAX_ENTRIES)
  await kv.put(key, JSON.stringify(trimmed), { expirationTtl: STATS_TTL_SECONDS })
}

// --- Internal types ---

interface AxisRow {
  slug: string
  label_low: string
  label_high: string
  harmonic_key: string
}

interface BudgetContext {
  rowsRead: number
  rowsWritten: number
  cachedActiveAxes?: AxisRow[]
}

interface SkipCheckRow {
  has_tags: number
  has_dim: number
  corr_count: number
}

// --- Math helpers ---

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function toNumberArray(values: unknown): number[] | null {
  if (!values) return null
  if (values instanceof Float32Array || values instanceof Float64Array) {
    return Array.from(values as Float32Array | Float64Array)
  }
  if (Array.isArray(values) && values.length > 0) return values as number[]
  return null
}

// --- Vector retrieval ---

async function getOwnVector(env: Env, atomId: string): Promise<number[] | null> {
  try {
    const res = await env.VECTORIZE.getByIds([atomId])
    if (!res || res.length === 0) return null
    return toNumberArray(res[0]?.values)
  } catch {
    return null
  }
}

async function getVectorsChunked(
  env: Env,
  ids: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  for (let i = 0; i < ids.length; i += VECTORIZE_GETBYIDS_CHUNK) {
    const chunk = ids.slice(i, i + VECTORIZE_GETBYIDS_CHUNK)
    const stored = await env.VECTORIZE.getByIds(chunk)
    for (const v of stored) {
      const arr = toNumberArray(v?.values)
      if (arr) out.set(v.id, arr)
    }
  }
  return out
}

// --- Active axes (cached per batch) ---

async function getActiveAxes(db: D1Database, ctx: BudgetContext): Promise<AxisRow[]> {
  if (ctx.cachedActiveAxes) return ctx.cachedActiveAxes
  const { results } = await db
    .prepare('SELECT slug, label_low, label_high, harmonic_key FROM dimension_axes WHERE active = 1')
    .all<AxisRow>()
  ctx.rowsRead += results.length
  ctx.cachedActiveAxes = results
  return results
}

// --- Skip check (single round-trip, all PK probes) ---

async function skipCheckAtom(
  db: D1Database,
  ctx: BudgetContext,
  atomId: string,
): Promise<{ skip: boolean; corrCount: number; exists: boolean }> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM atom_tags WHERE atom_id = ?1 LIMIT 1) AS has_tags,
         EXISTS(SELECT 1 FROM dimension_memberships WHERE atom_id = ?1 LIMIT 1) AS has_dim,
         semantic_correspondence_count AS corr_count
       FROM atoms WHERE id = ?1`,
    )
    .bind(atomId)
    .first<SkipCheckRow>()
  ctx.rowsRead += 3
  if (!row) return { skip: true, corrCount: 0, exists: false }
  const skip =
    row.has_tags === 1 && row.has_dim === 1 && (row.corr_count ?? 0) >= CORR_MIN_EXISTING
  return { skip, corrCount: row.corr_count ?? 0, exists: true }
}

// --- Centroid cache (KV, 1h TTL) ---

async function loadAxisCentroids(
  env: Env,
  ctx: BudgetContext,
  axis: AxisRow,
): Promise<{ low: number[]; high: number[] } | null> {
  const key = keyCentroids(axis.slug)
  const cached = (await env.CONNECTIVITY_KV.get(key, 'json')) as ConnectivityAxisCentroids | null
  if (cached) {
    if (cached.insufficient) return null
    if (cached.low && cached.high) return { low: cached.low, high: cached.high }
  }

  // Miss path: fetch seed atom ids per pole
  const fetchSeeds = async (pole: 'low' | 'high'): Promise<string[]> => {
    const { results } = await env.DB
      .prepare('SELECT atom_id FROM dimension_memberships WHERE axis_slug = ? AND pole = ?')
      .bind(axis.slug, pole)
      .all<{ atom_id: string }>()
    ctx.rowsRead += results.length
    return results.map(r => r.atom_id)
  }
  const lowIds = await fetchSeeds('low')
  const highIds = await fetchSeeds('high')

  const storeSentinel = async () => {
    const sentinel: ConnectivityAxisCentroids = {
      v: 1,
      axis_slug: axis.slug,
      computed_at: new Date().toISOString(),
      seed_counts: { low: lowIds.length, high: highIds.length },
      insufficient: true,
    }
    await env.CONNECTIVITY_KV.put(key, JSON.stringify(sentinel), {
      expirationTtl: CENTROID_TTL_SECONDS,
    })
  }

  if (lowIds.length < DIM_MIN_SEED_COUNT || highIds.length < DIM_MIN_SEED_COUNT) {
    await storeSentinel()
    return null
  }

  const [lowVecs, highVecs] = await Promise.all([
    getVectorsChunked(env, lowIds),
    getVectorsChunked(env, highIds),
  ])

  const centroid = (vecs: Map<string, number[]>): number[] | null => {
    if (vecs.size === 0) return null
    const arrays = Array.from(vecs.values())
    const dim = arrays[0].length
    const sum = new Array<number>(dim).fill(0)
    for (const arr of arrays) {
      for (let i = 0; i < dim; i++) sum[i] += arr[i]
    }
    for (let i = 0; i < dim; i++) sum[i] /= arrays.length
    return sum
  }

  const low = centroid(lowVecs)
  const high = centroid(highVecs)
  if (!low || !high) {
    await storeSentinel()
    return null
  }

  const payload: ConnectivityAxisCentroids = {
    v: 1,
    axis_slug: axis.slug,
    computed_at: new Date().toISOString(),
    seed_counts: { low: lowIds.length, high: highIds.length },
    low,
    high,
  }
  await env.CONNECTIVITY_KV.put(key, JSON.stringify(payload), {
    expirationTtl: CENTROID_TTL_SECONDS,
  })
  return { low, high }
}

// --- Scorers ---

async function propagateTags(
  env: Env,
  ctx: BudgetContext,
  atomId: string,
  ownVec: number[],
): Promise<{ applied: number; ambiguous: number }> {
  const result = await env.VECTORIZE.query(ownVec, {
    topK: TAG_NEIGHBOR_TOPK,
    returnMetadata: 'none',
    returnValues: false,
  })
  const neighbors = result.matches
    .filter(m => !m.id.startsWith(CHUNK_ID_PREFIX) && m.id !== atomId)
    .filter(m => (m.score ?? 0) >= TAG_NEIGHBOR_SIM_THRESHOLD)

  if (neighbors.length === 0) return { applied: 0, ambiguous: 0 }

  const voteMap = new Map<number, number>()
  for (const n of neighbors) {
    const { results } = await env.DB
      .prepare('SELECT tag_id FROM atom_tags WHERE atom_id = ?')
      .bind(n.id)
      .all<{ tag_id: number }>()
    ctx.rowsRead += results.length
    for (const row of results) {
      voteMap.set(row.tag_id, (voteMap.get(row.tag_id) ?? 0) + 1)
    }
  }

  const inserts: D1PreparedStatement[] = []
  let ambiguous = 0
  for (const [tagId, votes] of voteMap.entries()) {
    if (votes >= TAG_PROPAGATE_MIN_VOTES) {
      const confidence = votes / neighbors.length
      inserts.push(
        env.DB
          .prepare(
            'INSERT OR IGNORE INTO atom_tags (atom_id, tag_id, confidence, source) VALUES (?, ?, ?, ?)',
          )
          .bind(atomId, tagId, confidence, TAG_SOURCE),
      )
    } else if (votes === TAG_AMBIGUOUS_VOTES) {
      ambiguous++
    }
  }

  let applied = 0
  if (inserts.length > 0) {
    const results = await env.DB.batch(inserts)
    for (const r of results) {
      const changes = r.meta?.changes ?? 0
      if (changes > 0) applied++
      ctx.rowsWritten += changes
    }
  }
  return { applied, ambiguous }
}

async function scoreDimensionalMemberships(
  env: Env,
  ctx: BudgetContext,
  atomId: string,
  ownVec: number[],
  axes: AxisRow[],
): Promise<{ created: number; ambiguous: number }> {
  if (axes.length === 0) return { created: 0, ambiguous: 0 }

  const inserts: D1PreparedStatement[] = []
  let ambiguous = 0

  for (const axis of axes) {
    const centroids = await loadAxisCentroids(env, ctx, axis)
    if (!centroids) continue

    const simLow = cosineSim(ownVec, centroids.low)
    const simHigh = cosineSim(ownVec, centroids.high)
    const maxSim = Math.max(simLow, simHigh)
    const gap = Math.abs(simLow - simHigh)

    if (maxSim >= DIM_SIM_ASSIGN_THRESHOLD && gap >= DIM_SIM_GAP_REQUIREMENT) {
      const pole: 'low' | 'high' = simLow > simHigh ? 'low' : 'high'
      inserts.push(
        env.DB
          .prepare(
            'INSERT OR IGNORE INTO dimension_memberships (atom_id, axis_slug, pole, source) VALUES (?, ?, ?, ?)',
          )
          .bind(atomId, axis.slug, pole, MEMBERSHIP_SOURCE),
      )
    } else if (
      (maxSim >= DIM_AMBIGUOUS_BAND_LOW && maxSim < DIM_AMBIGUOUS_BAND_HIGH) ||
      (maxSim >= DIM_SIM_ASSIGN_THRESHOLD && gap < DIM_SIM_GAP_REQUIREMENT)
    ) {
      ambiguous++
    }
  }

  let created = 0
  if (inserts.length > 0) {
    const results = await env.DB.batch(inserts)
    for (const r of results) {
      const changes = r.meta?.changes ?? 0
      if (changes > 0) created++
      ctx.rowsWritten += changes
    }
  }
  return { created, ambiguous }
}

async function discoverCorrespondences(
  env: Env,
  ctx: BudgetContext,
  atomId: string,
  ownVec: number[],
  existingCount: number,
): Promise<{ created: number }> {
  if (existingCount >= CORR_MIN_EXISTING) return { created: 0 }

  const result = await env.VECTORIZE.query(ownVec, {
    topK: CORR_NEIGHBOR_TOPK,
    returnMetadata: 'none',
    returnValues: false,
  })
  const neighbors = result.matches
    .filter(m => !m.id.startsWith(CHUNK_ID_PREFIX) && m.id !== atomId)
    .filter(m => (m.score ?? 0) >= CORR_NEIGHBOR_SIM_THRESHOLD)

  if (neighbors.length === 0) return { created: 0 }

  const inserts: D1PreparedStatement[] = []
  for (const n of neighbors) {
    const a = atomId < n.id ? atomId : n.id
    const b = atomId < n.id ? n.id : atomId
    inserts.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO correspondences
             (id, atom_a_id, atom_b_id, relationship_type, strength, provenance, arrangement_scope, scope, last_reinforced_at, metadata)
           VALUES ('con:' || ?1 || ':' || ?2, ?1, ?2, 'resonates', ?3, 'semantic', '', 'cross_category', datetime('now'), '{}')`,
        )
        .bind(a, b, n.score ?? 0.8),
    )
  }

  let created = 0
  const results = await env.DB.batch(inserts)
  for (const r of results) {
    const changes = r.meta?.changes ?? 0
    if (changes > 0) created++
    ctx.rowsWritten += changes
  }
  return { created }
}

// --- Orchestrator ---

export async function processConnectivityBatch(
  env: Env,
  atomIds: string[],
  source: 'event' | 'sweep',
): Promise<ConnectivityStats> {
  const start = Date.now()
  const ctx: BudgetContext = { rowsRead: 0, rowsWritten: 0 }

  const stats: ConnectivityStats = {
    source,
    atoms_processed: 0,
    atoms_skipped: 0,
    tags_applied: 0,
    tags_ambiguous: 0,
    memberships_created: 0,
    memberships_ambiguous: 0,
    correspondences_created: 0,
    rows_read_estimate: 0,
    rows_written: 0,
    budget_exhausted: false,
    duration_ms: 0,
    active_axes_count: 0,
  }

  const axes = await getActiveAxes(env.DB, ctx)
  stats.active_axes_count = axes.length

  for (const atomId of atomIds) {
    if (ctx.rowsRead >= ROW_BUDGET) {
      stats.budget_exhausted = true
      break
    }

    const check = await skipCheckAtom(env.DB, ctx, atomId)
    if (!check.exists || check.skip) {
      stats.atoms_skipped++
      continue
    }

    const ownVec = await getOwnVector(env, atomId)
    if (!ownVec) {
      // Atom not yet embedded; sweep will retry after Phase 2.
      stats.atoms_skipped++
      continue
    }

    const tagResult = await propagateTags(env, ctx, atomId, ownVec)
    stats.tags_applied += tagResult.applied
    stats.tags_ambiguous += tagResult.ambiguous

    const dimResult = await scoreDimensionalMemberships(env, ctx, atomId, ownVec, axes)
    stats.memberships_created += dimResult.created
    stats.memberships_ambiguous += dimResult.ambiguous

    const corrResult = await discoverCorrespondences(env, ctx, atomId, ownVec, check.corrCount)
    stats.correspondences_created += corrResult.created

    stats.atoms_processed++
  }

  stats.rows_read_estimate = ctx.rowsRead
  stats.rows_written = ctx.rowsWritten
  stats.duration_ms = Date.now() - start
  return stats
}

// --- Stats logging ---

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function emptyTotals(): ConnectivityStatsDailyTotals {
  return {
    atoms_processed: 0,
    atoms_skipped: 0,
    tags_applied: 0,
    tags_ambiguous: 0,
    memberships_created: 0,
    memberships_ambiguous: 0,
    correspondences_created: 0,
    rows_read_estimate: 0,
    rows_written: 0,
    budget_exhausted_count: 0,
    total_duration_ms: 0,
  }
}

function recomputeTotals(runs: ConnectivityStatsRun[]): ConnectivityStatsDailyTotals {
  const t = emptyTotals()
  for (const r of runs) {
    t.atoms_processed += r.atoms_processed
    t.atoms_skipped += r.atoms_skipped
    t.tags_applied += r.tags_applied
    t.tags_ambiguous += r.tags_ambiguous
    t.memberships_created += r.memberships_created
    t.memberships_ambiguous += r.memberships_ambiguous
    t.correspondences_created += r.correspondences_created
    t.rows_read_estimate += r.rows_read_estimate
    t.rows_written += r.rows_written
    if (r.budget_exhausted) t.budget_exhausted_count++
    t.total_duration_ms += r.duration_ms
  }
  return t
}

export async function logConnectivityStats(
  kv: KVNamespace,
  stats: ConnectivityStats,
): Promise<void> {
  const date = todayKey()
  const key = keyStats(date)
  const existing = (await kv.get(key, 'json')) as ConnectivityStatsDaily | null

  const run: ConnectivityStatsRun = {
    at: new Date().toISOString(),
    source: stats.source,
    atoms_processed: stats.atoms_processed,
    atoms_skipped: stats.atoms_skipped,
    tags_applied: stats.tags_applied,
    tags_ambiguous: stats.tags_ambiguous,
    memberships_created: stats.memberships_created,
    memberships_ambiguous: stats.memberships_ambiguous,
    correspondences_created: stats.correspondences_created,
    rows_read_estimate: stats.rows_read_estimate,
    rows_written: stats.rows_written,
    budget_exhausted: stats.budget_exhausted,
    duration_ms: stats.duration_ms,
    active_axes_count: stats.active_axes_count,
  }

  const daily: ConnectivityStatsDaily = existing ?? {
    v: 1,
    date,
    runs: [],
    totals: emptyTotals(),
  }
  daily.runs.push(run)
  daily.totals = recomputeTotals(daily.runs)

  await kv.put(key, JSON.stringify(daily), {
    expirationTtl: STATS_TTL_SECONDS,
  })
}
