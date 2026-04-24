// Image extraction candidate review endpoints.
// Split from fromImage.ts to keep files under 500 lines.
// Hono sub-app merged into imageApp in fromImage.ts.

import { Hono } from 'hono'
import type { Env, CandidateAtom, CandidateCorrespondence, ImageExtractionCandidate } from './types'
import { createAtom } from './atoms'

// --- Constants ---

const DEFAULT_CANDIDATE_LIMIT = 50
const MAX_CANDIDATE_LIMIT = 500
const BATCH_REVIEW_MAX = 100

// --- Shared review logic ---

interface ReviewResult {
  id: number
  status: 'approved' | 'rejected'
  reviewed_at: string
  created_atom?: unknown
  created_correspondence?: unknown
  error?: string
}

const UTILITY_MAP: Record<string, string> = {
  directive: 'visual',
  modifier: 'literary',
  descriptor: 'dual',
}

async function reviewCandidate(
  db: D1Database,
  candidate: ImageExtractionCandidate,
  action: 'approve' | 'reject',
  notes?: string,
): Promise<ReviewResult> {
  const now = new Date().toISOString()

  if (action === 'reject') {
    await db.prepare(
      `UPDATE image_extraction_candidates SET status = 'rejected', review_notes = ?, reviewed_at = ? WHERE id = ?`
    ).bind(notes || null, now, candidate.id).run()
    return { id: candidate.id, status: 'rejected', reviewed_at: now }
  }

  // Approve atom
  if (candidate.candidate_type === 'atom') {
    const atomData: CandidateAtom = JSON.parse(candidate.candidate_data)

    const catCheck = await db.prepare('SELECT slug FROM categories WHERE slug = ?')
      .bind(atomData.suggested_category).first()
    const finalCategory = catCheck ? atomData.suggested_category : null

    const newAtom = await createAtom(db, {
      text: atomData.name,
      collection_slug: 'uncategorized',
      observation: 'observation',
      status: 'provisional',
      confidence: atomData.confidence,
      source: 'ai',
      source_app: 'fromImage',
      metadata: {
        source_url: candidate.source_url,
        source_attribution: candidate.source_attribution,
        extraction_description: atomData.description,
        candidate_id: candidate.id,
      },
      category_slug: finalCategory,
      modality: atomData.modality,
      utility: UTILITY_MAP[atomData.utility] ?? 'visual',
    })

    await db.prepare(
      `UPDATE image_extraction_candidates SET status = 'approved', review_notes = ?, reviewed_at = ? WHERE id = ?`
    ).bind(notes || null, now, candidate.id).run()

    return { id: candidate.id, status: 'approved', reviewed_at: now, created_atom: newAtom }
  }

  // Approve correspondence
  if (candidate.candidate_type === 'correspondence') {
    const corrData: CandidateCorrespondence = JSON.parse(candidate.candidate_data)

    const [sourceAtom, targetAtom] = await Promise.all([
      db.prepare('SELECT id FROM atoms WHERE text_lower = ?')
        .bind(corrData.source_name.toLowerCase().trim()).first<{ id: string }>(),
      db.prepare('SELECT id FROM atoms WHERE text_lower = ?')
        .bind(corrData.target_name.toLowerCase().trim()).first<{ id: string }>(),
    ])

    if (!sourceAtom || !targetAtom) {
      throw new Error(
        `Cannot resolve atoms: source="${corrData.source_name}" (${sourceAtom ? 'found' : 'missing'}), target="${corrData.target_name}" (${targetAtom ? 'found' : 'missing'}). Approve atom candidates first.`
      )
    }

    const relationshipType = corrData.suggested_strength >= 0.75 ? 'resonates' : 'evokes'

    await db.prepare(
      `INSERT OR IGNORE INTO correspondences (atom_a_id, atom_b_id, relationship_type, strength, provenance)
       VALUES (?, ?, ?, ?, 'image_extraction')`
    ).bind(sourceAtom.id, targetAtom.id, relationshipType, corrData.suggested_strength).run()

    await db.prepare(
      `UPDATE image_extraction_candidates SET status = 'approved', review_notes = ?, reviewed_at = ? WHERE id = ?`
    ).bind(notes || null, now, candidate.id).run()

    return {
      id: candidate.id,
      status: 'approved',
      reviewed_at: now,
      created_correspondence: {
        atom_a_id: sourceAtom.id,
        atom_b_id: targetAtom.id,
        relationship_type: relationshipType,
        strength: corrData.suggested_strength,
      },
    }
  }

  throw new Error(`Unknown candidate_type: ${candidate.candidate_type}`)
}

// --- Candidate summary for grouped listing ---

interface CandidateSummary {
  id: number
  type: 'atom' | 'correspondence'
  name?: string
  category?: string
  confidence?: number
  source_name?: string
  target_name?: string
  strength?: number
}

function summarizeCandidate(c: ImageExtractionCandidate): CandidateSummary {
  const data = JSON.parse(c.candidate_data)
  if (c.candidate_type === 'atom') {
    return {
      id: c.id,
      type: 'atom',
      name: data.name,
      category: data.suggested_category,
      confidence: data.confidence,
    }
  }
  return {
    id: c.id,
    type: 'correspondence',
    source_name: data.source_name,
    target_name: data.target_name,
    strength: data.suggested_strength,
  }
}

// --- Hono sub-app ---

export const reviewApp = new Hono<{ Bindings: Env }>()

// GET /candidates - List candidates by status with optional filters and grouping
reviewApp.get('/candidates', async (c) => {
  const status = c.req.query('status') || 'pending'
  const limit = Math.min(parseInt(c.req.query('limit') || String(DEFAULT_CANDIDATE_LIMIT), 10), MAX_CANDIDATE_LIMIT)
  const sourceUrl = c.req.query('source_url')
  const candidateType = c.req.query('candidate_type')
  const minConfidence = c.req.query('min_confidence') ? parseFloat(c.req.query('min_confidence')!) : undefined
  const category = c.req.query('category')
  const groupBySource = c.req.query('group_by_source') === 'true'

  // Build query with optional source_url and candidate_type filters
  let sql = 'SELECT * FROM image_extraction_candidates WHERE status = ?'
  const binds: unknown[] = [status]

  if (sourceUrl) {
    sql += ' AND source_url = ?'
    binds.push(sourceUrl)
  }
  if (candidateType && ['atom', 'correspondence'].includes(candidateType)) {
    sql += ' AND candidate_type = ?'
    binds.push(candidateType)
  }

  sql += ' ORDER BY source_url, id LIMIT ?'
  binds.push(limit)

  const result = await c.env.DB.prepare(sql).bind(...binds).all<ImageExtractionCandidate>()
  let candidates = result.results ?? []

  // Post-query filters on JSON fields (category, min_confidence)
  if (category || minConfidence !== undefined) {
    candidates = candidates.filter(cand => {
      if (cand.candidate_type !== 'atom') return !category // correspondences pass if no category filter
      const data = JSON.parse(cand.candidate_data) as CandidateAtom
      if (category && data.suggested_category !== category) return false
      if (minConfidence !== undefined && data.confidence < minConfidence) return false
      return true
    })
  }

  if (!groupBySource) {
    return c.json({ status, count: candidates.length, candidates: candidates.map(summarizeCandidate) })
  }

  // Grouped mode
  const groupMap = new Map<string, { source_url: string; source_attribution: string | null; candidates: CandidateSummary[] }>()
  for (const cand of candidates) {
    let group = groupMap.get(cand.source_url)
    if (!group) {
      group = { source_url: cand.source_url, source_attribution: cand.source_attribution, candidates: [] }
      groupMap.set(cand.source_url, group)
    }
    group.candidates.push(summarizeCandidate(cand))
  }

  const groups = Array.from(groupMap.values())
  return c.json({ status, total_groups: groups.length, total_candidates: candidates.length, groups })
})

// POST /candidates/:id/review - Approve or reject a single candidate
reviewApp.post('/candidates/:id/review', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'invalid candidate id' }, 400)

  const body = await c.req.json<{ action?: string; notes?: string }>()
  if (!body.action || !['approve', 'reject'].includes(body.action)) {
    return c.json({ error: 'action must be "approve" or "reject"' }, 400)
  }

  const candidate = await c.env.DB.prepare(
    'SELECT * FROM image_extraction_candidates WHERE id = ?'
  ).bind(id).first<ImageExtractionCandidate>()

  if (!candidate) return c.json({ error: 'candidate not found' }, 404)
  if (candidate.status !== 'pending') {
    return c.json({ error: 'candidate already reviewed', current_status: candidate.status }, 409)
  }

  try {
    const result = await reviewCandidate(c.env.DB, candidate, body.action as 'approve' | 'reject', body.notes)
    return c.json(result)
  } catch (err) {
    return c.json({ error: 'review_failed', message: (err as Error).message }, 422)
  }
})

// POST /candidates/batch-review - Batch approve/reject multiple candidates
reviewApp.post('/candidates/batch-review', async (c) => {
  const body = await c.req.json<{
    actions: Array<{ id: number; action: 'approve' | 'reject'; notes?: string }>
    dry_run?: boolean
  }>()

  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    return c.json({ error: 'actions array is required and must not be empty' }, 400)
  }
  if (body.actions.length > BATCH_REVIEW_MAX) {
    return c.json({ error: `max ${BATCH_REVIEW_MAX} actions per call` }, 400)
  }

  // Validate all actions have valid fields
  for (const a of body.actions) {
    if (typeof a.id !== 'number' || !['approve', 'reject'].includes(a.action)) {
      return c.json({ error: `invalid action entry: id=${a.id} action=${a.action}` }, 400)
    }
  }

  // Fetch all candidates in one batch
  const ids = body.actions.map(a => a.id)
  const placeholders = ids.map(() => '?').join(',')
  const fetched = await c.env.DB.prepare(
    `SELECT * FROM image_extraction_candidates WHERE id IN (${placeholders})`
  ).bind(...ids).all<ImageExtractionCandidate>()

  const candidateMap = new Map<number, ImageExtractionCandidate>()
  for (const cand of (fetched.results ?? [])) {
    candidateMap.set(cand.id, cand)
  }

  const approved: Array<{ id: number; name?: string; category?: string }> = []
  const rejected: number[] = []
  const failed: Array<{ id: number; error: string }> = []
  const createdAtoms: Array<{ id: string; name: string; category: string }> = []
  const createdCorrespondences: Array<{ source: string; target: string }> = []

  for (const a of body.actions) {
    const candidate = candidateMap.get(a.id)
    if (!candidate) {
      failed.push({ id: a.id, error: 'candidate not found' })
      continue
    }
    if (candidate.status !== 'pending') {
      failed.push({ id: a.id, error: `already ${candidate.status}` })
      continue
    }

    if (body.dry_run) {
      // Dry run: just count what would happen
      if (a.action === 'approve') approved.push({ id: a.id })
      else rejected.push(a.id)
      continue
    }

    try {
      const result = await reviewCandidate(c.env.DB, candidate, a.action, a.notes)
      if (a.action === 'approve') {
        approved.push({ id: a.id })
        if (result.created_atom) {
          const atom = result.created_atom as Record<string, unknown>
          createdAtoms.push({ id: String(atom.id ?? ''), name: String(atom.text ?? ''), category: String(atom.category_slug ?? '') })
        }
        if (result.created_correspondence) {
          const corr = result.created_correspondence as Record<string, unknown>
          createdCorrespondences.push({ source: String(corr.atom_a_id ?? ''), target: String(corr.atom_b_id ?? '') })
        }
      } else {
        rejected.push(a.id)
      }
    } catch (err) {
      failed.push({ id: a.id, error: (err as Error).message })
    }
  }

  return c.json({
    total: body.actions.length,
    approved: approved.length,
    rejected: rejected.length,
    failed,
    created_atoms: createdAtoms,
    created_correspondences: createdCorrespondences,
    dry_run: !!body.dry_run,
  })
})

// POST /candidates/approve-source - Approve all pending candidates from a source URL
reviewApp.post('/candidates/approve-source', async (c) => {
  const body = await c.req.json<{ source_url?: string; exclude_ids?: number[] }>()
  if (!body.source_url) {
    return c.json({ error: 'source_url is required' }, 400)
  }

  const excludeSet = new Set(body.exclude_ids ?? [])

  // Fetch all pending candidates for this source
  const result = await c.env.DB.prepare(
    `SELECT * FROM image_extraction_candidates WHERE source_url = ? AND status = 'pending' ORDER BY id`
  ).bind(body.source_url).all<ImageExtractionCandidate>()

  const candidates = (result.results ?? []).filter(c => !excludeSet.has(c.id))

  if (candidates.length === 0) {
    return c.json({ error: 'no pending candidates found for this source_url (after exclusions)' }, 404)
  }

  const approved: number[] = []
  const failed: Array<{ id: number; error: string }> = []
  const createdAtoms: Array<{ id: string; name: string; category: string }> = []
  const createdCorrespondences: Array<{ source: string; target: string }> = []

  // Process atoms first (correspondences may reference them)
  const atoms = candidates.filter(c => c.candidate_type === 'atom')
  const correspondences = candidates.filter(c => c.candidate_type === 'correspondence')

  for (const candidate of [...atoms, ...correspondences]) {
    try {
      const reviewResult = await reviewCandidate(c.env.DB, candidate, 'approve')
      approved.push(candidate.id)
      if (reviewResult.created_atom) {
        const atom = reviewResult.created_atom as Record<string, unknown>
        createdAtoms.push({ id: String(atom.id ?? ''), name: String(atom.text ?? ''), category: String(atom.category_slug ?? '') })
      }
      if (reviewResult.created_correspondence) {
        const corr = reviewResult.created_correspondence as Record<string, unknown>
        createdCorrespondences.push({ source: String(corr.atom_a_id ?? ''), target: String(corr.atom_b_id ?? '') })
      }
    } catch (err) {
      failed.push({ id: candidate.id, error: (err as Error).message })
    }
  }

  return c.json({
    source_url: body.source_url,
    total: candidates.length,
    approved: approved.length,
    excluded: excludeSet.size,
    failed,
    created_atoms: createdAtoms,
    created_correspondences: createdCorrespondences,
  })
})
