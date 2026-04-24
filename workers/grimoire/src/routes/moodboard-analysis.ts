// Moodboard analysis routes (dimensional-pilot).
// Mounted at /admin/moodboard in index.ts alongside the existing moodboardApp.
//
// POST /admin/moodboard/:moodboard_id/center-of-mass
// POST /admin/moodboard/dropped-atoms/backfill

import { Hono } from 'hono'
import type { Env } from '../types'
import { getMoodboardByBusinessId } from '../state/moodboards'
import {
  resolveDimensionPosition,
  type DimensionAxis,
  type AtomCoordRow,
} from '../dimension-resolver'
import { resolvePhrasesToAtoms, ResolveError } from '../resolve'

export const moodboardAnalysisApp = new Hono<{ Bindings: Env }>()

const CHUNK = 80

// Aggregate IR bucket shape in R2. Atom fields are prompt-driven and may vary;
// we only read what we need and tolerate missing optional fields.
type AggregateIRAtom = {
  name?: unknown
  suggested_category?: unknown
  frequency?: unknown
  mean_confidence?: unknown
  utility?: unknown
  modality?: unknown
}

type AggregateIR = {
  invariants?: AggregateIRAtom[]
  vectors?: AggregateIRAtom[]
  low_frequency_elements?: AggregateIRAtom[]
}

const BUCKETS: Array<{ field: keyof AggregateIR; label: string }> = [
  { field: 'invariants', label: 'invariant' },
  { field: 'vectors', label: 'vector' },
  { field: 'low_frequency_elements', label: 'low_frequency' },
]

function confidenceFromMatched(n: number): 'low' | 'medium' | 'high' {
  if (n < 5) return 'low'
  if (n < 16) return 'medium'
  return 'high'
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function toNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

async function fetchAggregateIR(
  r2: R2Bucket,
  key: string,
): Promise<AggregateIR | null> {
  const obj = await r2.get(key)
  if (!obj) return null
  try {
    return JSON.parse(await obj.text()) as AggregateIR
  } catch {
    return null
  }
}

// --- POST /:moodboard_id/center-of-mass -------------------------------------

moodboardAnalysisApp.post('/:moodboard_id/center-of-mass', async (c) => {
  if (!c.env.GRIMOIRE_R2) {
    return c.json({ error: 'GRIMOIRE_R2 binding not available' }, 500)
  }

  const moodboard_id = decodeURIComponent(c.req.param('moodboard_id'))
  const body = await c.req.json<{ axes?: string[] }>().catch(() => ({} as { axes?: string[] }))
  const explicitAxes = Array.isArray(body.axes) ? body.axes.filter((s: unknown): s is string => typeof s === 'string') : null

  const moodboard = await getMoodboardByBusinessId(c.env.DB, moodboard_id)
  if (!moodboard) return c.json({ error: 'not_found', moodboard_id }, 404)
  if (moodboard.status !== 'aggregated' && moodboard.status !== 'reviewed') {
    return c.json({
      error: 'invalid_status',
      message: `expected status 'aggregated' or 'reviewed', got '${moodboard.status}'`,
    }, 409)
  }
  if (!moodboard.ir_r2_key) {
    return c.json({ error: 'ir_r2_key_missing' }, 409)
  }

  const ir = await fetchAggregateIR(c.env.GRIMOIRE_R2, moodboard.ir_r2_key)
  if (!ir) {
    return c.json({ error: 'ir_fetch_failed', ir_r2_key: moodboard.ir_r2_key }, 502)
  }

  // Load axes: explicit list takes precedence over active filter (allows
  // pre-flag-flip verification against a specific axis).
  let axesRows: DimensionAxis[]
  if (explicitAxes && explicitAxes.length > 0) {
    const placeholders = explicitAxes.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT slug, label_low, label_high, harmonic_key, description, active
       FROM dimension_axes WHERE slug IN (${placeholders})`
    ).bind(...explicitAxes).all<DimensionAxis>()
    axesRows = results ?? []
  } else {
    const { results } = await c.env.DB.prepare(
      `SELECT slug, label_low, label_high, harmonic_key, description, active
       FROM dimension_axes WHERE active = 1`
    ).all<DimensionAxis>()
    axesRows = results ?? []
  }

  if (axesRows.length === 0) {
    return c.json({ moodboard_id, axes: [] })
  }

  // Extract phrases across buckets, preserving order so resolver results align.
  const phraseList: Array<{ phrase: string; bucket: string }> = []
  for (const { field, label } of BUCKETS) {
    const arr = ir[field]
    if (!Array.isArray(arr)) continue
    for (const atom of arr) {
      const name = toStr(atom?.name)
      if (!name) continue
      phraseList.push({ phrase: name, bucket: label })
    }
  }
  const aggregateCount = phraseList.length

  // Resolve compound IR phrases to atom IDs via the vocabulary resolver
  // (three-pass: exact -> stem -> semantic). Replaces the prior raw
  // `WHERE text_lower IN` lookup that returned zero matches on compound input.
  let atomBucket: Map<string, string>
  let resolveStats: { fully_resolved: number; partially_resolved: number; unresolved: number }
  try {
    const resolved = await resolvePhrasesToAtoms(
      phraseList.map(p => p.phrase),
      c.env,
    )
    atomBucket = new Map<string, string>()
    resolved.results.forEach((res, i) => {
      const bucket = phraseList[i].bucket
      for (const atom of res.atoms) {
        if (!atomBucket.has(atom.id)) atomBucket.set(atom.id, bucket)
      }
    })
    resolveStats = {
      fully_resolved: resolved.stats.fully_resolved,
      partially_resolved: resolved.stats.partially_resolved,
      unresolved: resolved.stats.unresolved,
    }
  } catch (err) {
    if (err instanceof ResolveError) {
      return c.json({ error: 'phrase_resolution_failed', message: err.message }, err.status)
    }
    throw err
  }

  const allAtomIds = [...atomBucket.keys()]
  const axesOut: Array<Record<string, unknown>> = []

  for (const axis of axesRows) {
    // One membership-scoped query per axis; chunked by atom_id.
    type MemberRow = AtomCoordRow & { pole: 'low' | 'high' }
    const matched: MemberRow[] = []
    for (let i = 0; i < allAtomIds.length; i += CHUNK) {
      const chunk = allAtomIds.slice(i, i + CHUNK)
      const placeholders = chunk.map(() => '?').join(',')
      const { results } = await c.env.DB.prepare(
        `SELECT a.id, a.text_lower, a.harmonics, a.register, m.pole
         FROM dimension_memberships m
         JOIN atoms a ON a.id = m.atom_id
         WHERE m.axis_slug = ?
           AND m.atom_id IN (${placeholders})`
      ).bind(axis.slug, ...chunk).all<MemberRow>()
      matched.push(...(results ?? []))
    }

    // Resolve positions. Collect per-pole rows for driving lists.
    type Scored = {
      id: string
      text_lower: string
      coord: number
      pole: 'low' | 'high'
      bucket: string
    }
    const scored: Scored[] = []
    for (const row of matched) {
      const coord = resolveDimensionPosition(axis, row)
      if (coord === null) continue
      scored.push({
        id: row.id,
        text_lower: row.text_lower,
        coord,
        pole: row.pole,
        bucket: atomBucket.get(row.id) ?? 'unknown',
      })
    }

    const matchedCount = scored.length
    let mean = 0
    let stdev = 0
    if (matchedCount > 0) {
      let sum = 0
      for (const s of scored) sum += s.coord
      mean = sum / matchedCount
      if (matchedCount > 1) {
        let acc = 0
        for (const s of scored) acc += (s.coord - mean) ** 2
        stdev = Math.sqrt(acc / matchedCount)
      }
    }

    const highs = scored.filter(s => s.pole === 'high').sort((a, b) => b.coord - a.coord).slice(0, 5)
    const lows = scored.filter(s => s.pole === 'low').sort((a, b) => a.coord - b.coord).slice(0, 5)

    axesOut.push({
      axis_slug: axis.slug,
      harmonic_key: axis.harmonic_key,
      label_low: axis.label_low,
      label_high: axis.label_high,
      active: axis.active === 1,
      atom_count_aggregate: aggregateCount,
      atom_count_matched: matchedCount,
      confidence: confidenceFromMatched(matchedCount),
      mean: matchedCount > 0 ? Number(mean.toFixed(4)) : null,
      stdev: matchedCount > 0 ? Number(stdev.toFixed(4)) : null,
      atoms_driving_high: highs.map(s => ({ text: s.text_lower, coord: s.coord, bucket: s.bucket })),
      atoms_driving_low: lows.map(s => ({ text: s.text_lower, coord: s.coord, bucket: s.bucket })),
    })
  }

  return c.json({ moodboard_id, axes: axesOut, resolve_stats: resolveStats })
})

// --- POST /dropped-atoms/backfill -------------------------------------------

interface BackfillRequest {
  dry_run?: boolean
  moodboard_ids?: string[]
}

moodboardAnalysisApp.post('/dropped-atoms/backfill', async (c) => {
  if (!c.env.GRIMOIRE_R2) {
    return c.json({ error: 'GRIMOIRE_R2 binding not available' }, 500)
  }

  const body = await c.req.json<BackfillRequest>().catch(() => ({} as BackfillRequest))
  const dry_run = body.dry_run !== false // default true
  const explicitIds = Array.isArray(body.moodboard_ids) ? body.moodboard_ids.filter(s => typeof s === 'string') : null

  // Load valid slug set once.
  const { results: catRows } = await c.env.DB.prepare(
    'SELECT slug FROM categories'
  ).all<{ slug: string }>()
  const validSlugs = new Set((catRows ?? []).map(r => r.slug))

  // Resolve moodboard list.
  let moodboards: Array<{ moodboard_id: string; ir_r2_key: string | null }>
  if (explicitIds && explicitIds.length > 0) {
    const ph = explicitIds.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT moodboard_id, ir_r2_key FROM moodboards
       WHERE moodboard_id IN (${ph})
         AND status IN ('aggregated','reviewed')`
    ).bind(...explicitIds).all<{ moodboard_id: string; ir_r2_key: string | null }>()
    moodboards = results ?? []
  } else {
    const { results } = await c.env.DB.prepare(
      `SELECT moodboard_id, ir_r2_key FROM moodboards
       WHERE status IN ('aggregated','reviewed')
       ORDER BY moodboard_id`
    ).all<{ moodboard_id: string; ir_r2_key: string | null }>()
    moodboards = results ?? []
  }

  const skipped: Array<{ moodboard_id: string; reason: string; error?: string }> = []
  const rejectsByBucket: Record<string, number> = { invariant: 0, vector: 0, low_frequency: 0 }
  let scanned = 0
  let inserted = 0
  let alreadyPresent = 0

  for (const mb of moodboards) {
    scanned++
    if (!mb.ir_r2_key) {
      skipped.push({ moodboard_id: mb.moodboard_id, reason: 'ir_r2_key_missing' })
      continue
    }
    let ir: AggregateIR | null
    try {
      ir = await fetchAggregateIR(c.env.GRIMOIRE_R2, mb.ir_r2_key)
    } catch (err) {
      skipped.push({ moodboard_id: mb.moodboard_id, reason: 'r2_fetch_failed', error: (err as Error).message })
      continue
    }
    if (!ir) {
      skipped.push({ moodboard_id: mb.moodboard_id, reason: 'ir_fetch_failed' })
      continue
    }

    // Collect rejects from all three buckets for this moodboard.
    type Reject = {
      atom_name: string
      suggested_category: string
      bucket: string
      frequency: number | null
      mean_confidence: number | null
      utility: string | null
      modality: string | null
    }
    const rejects: Reject[] = []
    for (const { field, label } of BUCKETS) {
      const arr = ir[field]
      if (!Array.isArray(arr)) continue
      for (const atom of arr) {
        const suggested = toStr(atom?.suggested_category)
        const name = toStr(atom?.name)
        if (!suggested || !name) continue
        if (validSlugs.has(suggested)) continue
        rejects.push({
          atom_name: name,
          suggested_category: suggested,
          bucket: label,
          frequency: toNum(atom?.frequency),
          mean_confidence: toNum(atom?.mean_confidence),
          utility: toStr(atom?.utility),
          modality: toStr(atom?.modality),
        })
        rejectsByBucket[label] = (rejectsByBucket[label] ?? 0) + 1
      }
    }

    if (rejects.length === 0 || dry_run) continue

    // Batch INSERT OR IGNORE, chunked. Skip at drop-capture failure (observability).
    for (let i = 0; i < rejects.length; i += CHUNK) {
      const chunk = rejects.slice(i, i + CHUNK)
      const stmts = chunk.map(r =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO moodboard_dropped_atoms
             (moodboard_id, atom_name, suggested_category, bucket,
              frequency, mean_confidence, utility, modality)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          mb.moodboard_id,
          r.atom_name,
          r.suggested_category,
          r.bucket,
          r.frequency,
          r.mean_confidence,
          r.utility,
          r.modality,
        )
      )
      try {
        const results = await c.env.DB.batch(stmts)
        for (const res of results) {
          const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0
          if (changes) inserted++
          else alreadyPresent++
        }
      } catch (err) {
        console.warn(
          `[backfill] ${mb.moodboard_id}: batch insert failed, continuing: ${(err as Error).message}`,
        )
      }
    }
  }

  return c.json({
    dry_run,
    moodboards_scanned: scanned,
    moodboards_skipped: skipped,
    atoms_inserted: inserted,
    atoms_already_present: alreadyPresent,
    rejects_by_bucket: rejectsByBucket,
  })
})
