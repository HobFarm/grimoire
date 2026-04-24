// Dimensional vocabulary admin routes.
// Mounted at /admin/dimension in index.ts (admin Bearer auth middleware applies).
//
// POST /admin/dimension/ingest-manifest
//   Curator-asserted atom membership ingestion. Idempotent via INSERT OR IGNORE.
//   Surfaces conflicts (atom in opposite pole) and missing atoms without auto-resolving.

import { Hono } from 'hono'
import type { Env } from '../types'

export const dimensionApp = new Hono<{ Bindings: Env }>()

interface ManifestRequest {
  axis_slug: string
  pole: 'low' | 'high'
  source: string
  atom_slugs: string[]
  dry_run?: boolean
  category_filter?: string
}

interface ExistingMembership {
  atom_id: string
  pole: 'low' | 'high'
}

const CHUNK = 80

dimensionApp.post('/ingest-manifest', async (c) => {
  const startMs = Date.now()
  const body = await c.req.json<ManifestRequest>().catch(() => null)

  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const {
    axis_slug,
    pole,
    source,
    atom_slugs,
    dry_run = true,
    category_filter,
  } = body

  if (typeof axis_slug !== 'string' || !axis_slug) {
    return c.json({ error: 'Required: axis_slug (string)' }, 400)
  }
  if (pole !== 'low' && pole !== 'high') {
    return c.json({ error: "Required: pole ('low' or 'high')" }, 400)
  }
  if (typeof source !== 'string' || !source) {
    return c.json({ error: 'Required: source (non-empty string)' }, 400)
  }
  if (!Array.isArray(atom_slugs) || atom_slugs.length === 0) {
    return c.json({ error: 'Required: atom_slugs (non-empty array)' }, 400)
  }
  if (category_filter !== undefined && (typeof category_filter !== 'string' || !category_filter)) {
    return c.json({ error: 'category_filter must be a non-empty string when present' }, 400)
  }

  const axisRow = await c.env.DB.prepare(
    'SELECT slug FROM dimension_axes WHERE slug = ?'
  ).bind(axis_slug).first<{ slug: string }>()
  if (!axisRow) {
    return c.json({ error: `Unknown axis_slug: ${axis_slug}` }, 400)
  }

  if (category_filter) {
    const catRow = await c.env.DB.prepare(
      'SELECT slug FROM categories WHERE slug = ?'
    ).bind(category_filter).first<{ slug: string }>()
    if (!catRow) {
      return c.json({ error: `Unknown category_filter: ${category_filter}` }, 400)
    }
  }

  // Normalize + dedupe slug input.
  const slugs = [...new Set(
    atom_slugs
      .filter(s => typeof s === 'string')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  )]

  // Resolve slugs -> atom ids. When category_filter is present, only atoms in
  // that category qualify (polysemy guard: the curator wants the body-reading
  // version of "heavy", not the narrative.mood one).
  const resolved = new Map<string, string>() // text_lower -> atom_id
  const scopedSql = category_filter
    ? 'SELECT id, text_lower FROM atoms WHERE category_slug = ? AND text_lower IN'
    : 'SELECT id, text_lower FROM atoms WHERE text_lower IN'
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const chunk = slugs.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const binds = category_filter ? [category_filter, ...chunk] : chunk
    const { results } = await c.env.DB.prepare(
      `${scopedSql} (${placeholders})`
    ).bind(...binds).all<{ id: string; text_lower: string }>()
    for (const row of results) resolved.set(row.text_lower, row.id)
  }

  const missing: string[] = []
  const resolvedPairs: Array<{ atom_id: string; text_lower: string }> = []
  for (const slug of slugs) {
    const id = resolved.get(slug)
    if (id) resolvedPairs.push({ atom_id: id, text_lower: slug })
    else missing.push(slug)
  }

  // Check existing memberships for this axis.
  const existing = new Map<string, 'low' | 'high'>() // atom_id -> pole
  const resolvedIds = resolvedPairs.map(r => r.atom_id)
  for (let i = 0; i < resolvedIds.length; i += CHUNK) {
    const chunk = resolvedIds.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await c.env.DB.prepare(
      `SELECT atom_id, pole FROM dimension_memberships
       WHERE axis_slug = ? AND atom_id IN (${placeholders})`
    ).bind(axis_slug, ...chunk).all<ExistingMembership>()
    for (const row of results) existing.set(row.atom_id, row.pole)
  }

  const toInsert: Array<{ atom_id: string; text_lower: string }> = []
  const alreadyPresent: Array<{ atom_id: string; text_lower: string }> = []
  const conflicts: Array<{ atom_id: string; text_lower: string; current_pole: 'low' | 'high' }> = []

  for (const pair of resolvedPairs) {
    const current = existing.get(pair.atom_id)
    if (!current) {
      toInsert.push(pair)
    } else if (current === pole) {
      alreadyPresent.push(pair)
    } else {
      conflicts.push({ ...pair, current_pole: current })
    }
  }

  if (dry_run) {
    return c.json({
      dry_run: true,
      axis_slug,
      pole,
      source,
      category_filter: category_filter ?? null,
      would_insert: toInsert.length,
      already_present: alreadyPresent.length,
      conflicts,
      missing,
      preview: toInsert.slice(0, 50),
    })
  }

  // Execute: INSERT OR IGNORE for to_insert. d1 batch semantics give us atomicity
  // per statement; concurrent ingest of the same manifest is a no-op via PK.
  let inserted = 0
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK)
    const statements = chunk.map(pair =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO dimension_memberships
           (atom_id, axis_slug, pole, source)
         VALUES (?, ?, ?, ?)`
      ).bind(pair.atom_id, axis_slug, pole, source)
    )
    const results = await c.env.DB.batch(statements)
    for (const r of results) {
      if ((r.meta as { changes?: number } | undefined)?.changes) inserted++
    }
  }

  return c.json({
    ok: true,
    axis_slug,
    pole,
    source,
    category_filter: category_filter ?? null,
    inserted,
    already_present: alreadyPresent.length,
    conflicts,
    missing,
    duration_ms: Date.now() - startMs,
  })
})
