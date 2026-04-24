// Wildcard bootstrap: applies a manifest chunk (one stage at a time) to D1.
// Companion to scripts/wildcard-bootstrap.mjs (Phase 1) and
// scripts/wildcard-bootstrap-apply.mjs (Phase 2). All inserts are
// INSERT OR IGNORE, so re-running is idempotent and existing manual
// curation (e.g. the 171 pre-bootstrap dimension_memberships) is preserved.

import type { Env } from './types'

const D1_BATCH_SIZE = 50

export type WildcardStage = 'tags' | 'atom_tags' | 'memberships' | 'correspondences'

export interface TagInput {
  slug: string          // 'body-region:upper-body'
  category: string      // 'body-region'
  description?: string
}

export interface AtomTagInput {
  atom_id: string
  tag_slug: string
}

export interface MembershipInput {
  atom_id: string
  axis_slug: string
  pole: 'low' | 'high'
}

export interface CorrespondenceInput {
  atom_a_id: string
  atom_b_id: string
  source: 'wildcard-co-membership' | 'movement-membership'
  file?: string
  movement?: string
  strength?: number  // defaults to 0.5 for co-membership, 0.7 for movement
}

export interface WildcardApplyRequest {
  stage: WildcardStage
  payload: TagInput[] | AtomTagInput[] | MembershipInput[] | CorrespondenceInput[]
  dry_run?: boolean
}

export interface WildcardApplyResponse {
  stage: WildcardStage
  inserted: number
  skipped: number
  missing_atoms?: number
  missing_tags?: number
  missing_axes?: number
  dry_run?: boolean
}

class ApplyError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

// Deterministic ID for wildcard correspondences so re-runs INSERT-OR-IGNORE on the
// existing row instead of inserting a duplicate edge. The `correspondences` table
// has no UNIQUE constraint on (atom_a_id, atom_b_id), so the random-id pattern
// used by semantic correspondence discovery is not idempotent for our use case.
// Format: 'wbs:<source>:<a>:<b>' where a < b (caller normalizes).
function deterministicCorrespondenceId(source: string, a: string, b: string): string {
  return `wbs:${source}:${a}:${b}`
}

async function runBatched<T>(
  items: T[],
  buildStmt: (item: T) => D1PreparedStatement,
  db: D1Database,
): Promise<{ rowsAffected: number }> {
  let rowsAffected = 0
  for (let i = 0; i < items.length; i += D1_BATCH_SIZE) {
    const chunk = items.slice(i, i + D1_BATCH_SIZE)
    const stmts = chunk.map(buildStmt)
    const results = await db.batch(stmts)
    for (const res of results) {
      const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0
      rowsAffected += changes
    }
  }
  return { rowsAffected }
}

async function applyTags(env: Env, payload: TagInput[], dryRun: boolean): Promise<WildcardApplyResponse> {
  if (dryRun) return { stage: 'tags', inserted: 0, skipped: payload.length, dry_run: true }
  const { rowsAffected } = await runBatched(payload, (t) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO tags (slug, category, description, source)
       VALUES (?, ?, ?, 'wildcard-bootstrap')`
    ).bind(t.slug, t.category, t.description ?? null), env.DB)
  return { stage: 'tags', inserted: rowsAffected, skipped: payload.length - rowsAffected }
}

async function applyAtomTags(env: Env, payload: AtomTagInput[], dryRun: boolean): Promise<WildcardApplyResponse> {
  // Resolve unique tag slugs to ids in one pass (chunked at 80 for D1 binding limit).
  const uniqueSlugs = Array.from(new Set(payload.map(p => p.tag_slug)))
  const slugToId = new Map<string, number>()
  for (let i = 0; i < uniqueSlugs.length; i += 80) {
    const chunk = uniqueSlugs.slice(i, i + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT id, slug FROM tags WHERE slug IN (${placeholders})`
    ).bind(...chunk).all<{ id: number; slug: string }>()
    for (const r of (results ?? [])) slugToId.set(r.slug, r.id)
  }

  let missingTags = 0
  const resolvable: Array<{ atom_id: string; tag_id: number }> = []
  for (const p of payload) {
    const tagId = slugToId.get(p.tag_slug)
    if (tagId === undefined) { missingTags++; continue }
    resolvable.push({ atom_id: p.atom_id, tag_id: tagId })
  }

  if (dryRun) {
    return { stage: 'atom_tags', inserted: 0, skipped: payload.length - missingTags, missing_tags: missingTags, dry_run: true }
  }

  const { rowsAffected } = await runBatched(resolvable, (p) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO atom_tags (atom_id, tag_id, source)
       VALUES (?, ?, 'wildcard-bootstrap')`
    ).bind(p.atom_id, p.tag_id), env.DB)

  return {
    stage: 'atom_tags',
    inserted: rowsAffected,
    skipped: resolvable.length - rowsAffected,
    missing_tags: missingTags,
  }
}

async function applyMemberships(env: Env, payload: MembershipInput[], dryRun: boolean): Promise<WildcardApplyResponse> {
  if (dryRun) return { stage: 'memberships', inserted: 0, skipped: payload.length, dry_run: true }

  const { rowsAffected } = await runBatched(payload, (m) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO dimension_memberships (atom_id, axis_slug, pole, source)
       VALUES (?, ?, ?, 'wildcard-bootstrap')`
    ).bind(m.atom_id, m.axis_slug, m.pole), env.DB)

  return { stage: 'memberships', inserted: rowsAffected, skipped: payload.length - rowsAffected }
}

async function applyCorrespondences(env: Env, payload: CorrespondenceInput[], dryRun: boolean): Promise<WildcardApplyResponse> {
  if (dryRun) return { stage: 'correspondences', inserted: 0, skipped: payload.length, dry_run: true }

  const { rowsAffected } = await runBatched(payload, (c) => {
    const strength = c.strength ?? (c.source === 'movement-membership' ? 0.7 : 0.5)
    const metadata = c.source === 'movement-membership'
      ? JSON.stringify({ source: c.source, movement: c.movement, file: c.file })
      : JSON.stringify({ source: c.source, file: c.file })
    // Normalize ordering so atom_a_id < atom_b_id (avoids inserting reverse edges).
    const [a, b] = c.atom_a_id < c.atom_b_id ? [c.atom_a_id, c.atom_b_id] : [c.atom_b_id, c.atom_a_id]
    return env.DB.prepare(
      `INSERT OR IGNORE INTO correspondences
         (id, atom_a_id, atom_b_id, relationship_type, strength, provenance, scope, metadata)
       VALUES (?, ?, ?, 'evokes', ?, 'co_occurrence', 'cross_category', ?)`
    ).bind(deterministicCorrespondenceId(c.source, a, b), a, b, strength, metadata)
  }, env.DB)

  return { stage: 'correspondences', inserted: rowsAffected, skipped: payload.length - rowsAffected }
}

export async function applyWildcardBootstrap(
  env: Env,
  req: WildcardApplyRequest,
): Promise<WildcardApplyResponse> {
  const dryRun = req.dry_run === true
  if (!Array.isArray(req.payload)) throw new ApplyError('payload must be an array')
  if (req.payload.length === 0) {
    return { stage: req.stage, inserted: 0, skipped: 0, dry_run: dryRun }
  }
  switch (req.stage) {
    case 'tags':            return applyTags(env, req.payload as TagInput[], dryRun)
    case 'atom_tags':       return applyAtomTags(env, req.payload as AtomTagInput[], dryRun)
    case 'memberships':     return applyMemberships(env, req.payload as MembershipInput[], dryRun)
    case 'correspondences': return applyCorrespondences(env, req.payload as CorrespondenceInput[], dryRun)
    default:
      throw new ApplyError(`unknown stage: ${req.stage}`)
  }
}

export { ApplyError }
