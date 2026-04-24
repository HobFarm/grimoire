/**
 * Manifest Builder
 *
 * Packages slices of the Grimoire graph into pre-computed JSON artifacts in R2.
 * Consumers (StyleFusion, HobBot, external tools) fetch a single file from
 * ref.hob.fm/manifests/{slug}.json instead of querying D1.
 *
 * Specs live at R2 specs/manifests/{slug}.json. Built manifests land at
 * manifests/{slug}.json with a .meta.json sidecar for cheap listing.
 */

import type {
  Env,
  ManifestSpec,
  Manifest,
  ManifestAtom,
  ManifestRelation,
  ManifestMeta,
  ManifestStats,
  GraphAtom,
  GraphCorrespondence,
  GraphSnapshot,
  GraphTag,
  ManifestBuildResult,
  ManifestBuildSummary,
  HarmonicsCompact,
} from './types'
import { safeParseJSON } from './arrangement-tagger'
import { createLogger } from '@shared/logger'

const log = createLogger('grimoire')

const BATCH_SIZE = 10_000
const DEFAULT_PROVENANCES = ['harmonic', 'semantic'] as const
const KV_LAST_BUILD_KEY = 'manifests:last_build'

type HarmonicsJson = Partial<{
  hardness: number
  temperature: number
  weight: number
  formality: number
  era_affinity: number
}>

function harmonicsFromRow(raw: string | null, register: number | null): {
  h: HarmonicsCompact
  parsed: boolean
} {
  const fallback: HarmonicsCompact = { h: 0.5, t: 0.5, w: 0.5, f: 0.5, e: 0.5, r: register ?? 0.5 }
  if (!raw) return { h: fallback, parsed: false }
  const j = safeParseJSON<HarmonicsJson | null>(raw, null)
  if (!j || typeof j !== 'object') return { h: fallback, parsed: false }
  return {
    h: {
      h: typeof j.hardness === 'number' ? j.hardness : 0.5,
      t: typeof j.temperature === 'number' ? j.temperature : 0.5,
      w: typeof j.weight === 'number' ? j.weight : 0.5,
      f: typeof j.formality === 'number' ? j.formality : 0.5,
      e: typeof j.era_affinity === 'number' ? j.era_affinity : 0.5,
      r: register ?? 0.5,
    },
    parsed: true,
  }
}

// --- Graph load ---

export async function loadFullGraph(
  db: D1Database,
  opts: { provenances: readonly string[] }
): Promise<GraphSnapshot> {
  const start = Date.now()
  const atoms = new Map<string, GraphAtom>()
  const atomTags = new Map<string, GraphTag[]>()
  const memberships = new Map<string, Record<string, string>>()
  const correspondences = new Map<string, GraphCorrespondence[]>()
  let harmonicsParseFailures = 0

  // Query 1: confirmed atoms, rowid cursor pagination
  {
    let afterRowid = 0
    while (true) {
      const { results } = await db.prepare(
        `SELECT rowid, id, text, category_slug, harmonics, register
         FROM atoms
         WHERE status = 'confirmed' AND rowid > ?
         ORDER BY rowid LIMIT ?`
      ).bind(afterRowid, BATCH_SIZE).all<{
        rowid: number
        id: string
        text: string
        category_slug: string | null
        harmonics: string | null
        register: number | null
      }>()
      if (results.length === 0) break
      for (const row of results) {
        if (!row.category_slug) continue
        const { h, parsed } = harmonicsFromRow(row.harmonics, row.register)
        if (!parsed) harmonicsParseFailures++
        atoms.set(row.id, {
          id: row.id,
          text: row.text,
          category_slug: row.category_slug,
          h,
        })
      }
      afterRowid = results[results.length - 1].rowid
      if (results.length < BATCH_SIZE) break
    }
  }

  // Query 2: atom_tags JOIN tags, rowid cursor pagination on atom_tags
  {
    let afterRowid = 0
    while (true) {
      const { results } = await db.prepare(
        `SELECT at.rowid, at.atom_id, t.slug, t.category
         FROM atom_tags at JOIN tags t ON at.tag_id = t.id
         WHERE at.rowid > ?
         ORDER BY at.rowid LIMIT ?`
      ).bind(afterRowid, BATCH_SIZE).all<{
        rowid: number
        atom_id: string
        slug: string
        category: string | null
      }>()
      if (results.length === 0) break
      for (const row of results) {
        if (!atoms.has(row.atom_id)) continue
        const list = atomTags.get(row.atom_id)
        const entry: GraphTag = { slug: row.slug, category: row.category ?? '' }
        if (list) list.push(entry)
        else atomTags.set(row.atom_id, [entry])
      }
      afterRowid = results[results.length - 1].rowid
      if (results.length < BATCH_SIZE) break
    }
  }

  // Query 3: dimension_memberships (small table, single query)
  {
    const { results } = await db.prepare(
      'SELECT atom_id, axis_slug, pole FROM dimension_memberships'
    ).all<{ atom_id: string; axis_slug: string; pole: string }>()
    for (const row of results) {
      if (!atoms.has(row.atom_id)) continue
      const existing = memberships.get(row.atom_id)
      if (existing) existing[row.axis_slug] = row.pole
      else memberships.set(row.atom_id, { [row.axis_slug]: row.pole })
    }
  }

  // Query 4: correspondences filtered by provenance, id cursor pagination
  {
    const provList = opts.provenances.length > 0 ? [...opts.provenances] : [...DEFAULT_PROVENANCES]
    const placeholders = provList.map(() => '?').join(',')
    let afterId = ''
    while (true) {
      const { results } = await db.prepare(
        `SELECT id, atom_a_id, atom_b_id, relationship_type, strength, provenance
         FROM correspondences
         WHERE provenance IN (${placeholders}) AND id > ?
         ORDER BY id LIMIT ?`
      ).bind(...provList, afterId, BATCH_SIZE).all<{
        id: string
        atom_a_id: string
        atom_b_id: string
        relationship_type: string
        strength: number
        provenance: string
      }>()
      if (results.length === 0) break
      for (const row of results) {
        const aExists = atoms.has(row.atom_a_id)
        const bExists = atoms.has(row.atom_b_id)
        if (!aExists && !bExists) continue
        if (aExists) {
          const list = correspondences.get(row.atom_a_id)
          const entry: GraphCorrespondence = {
            target: row.atom_b_id,
            type: row.relationship_type,
            s: row.strength,
            p: row.provenance,
            a_id: row.atom_a_id,
            b_id: row.atom_b_id,
          }
          if (list) list.push(entry)
          else correspondences.set(row.atom_a_id, [entry])
        }
        if (bExists) {
          const list = correspondences.get(row.atom_b_id)
          const entry: GraphCorrespondence = {
            target: row.atom_a_id,
            type: row.relationship_type,
            s: row.strength,
            p: row.provenance,
            a_id: row.atom_a_id,
            b_id: row.atom_b_id,
          }
          if (list) list.push(entry)
          else correspondences.set(row.atom_b_id, [entry])
        }
      }
      afterId = results[results.length - 1].id
      if (results.length < BATCH_SIZE) break
    }
  }

  const totalCorr = [...correspondences.values()].reduce((n, l) => n + l.length, 0) / 2

  return {
    atoms,
    atomTags,
    memberships,
    correspondences,
    loadDurationMs: Date.now() - start,
    stats: {
      atoms_loaded: atoms.size,
      atom_tags_loaded: [...atomTags.values()].reduce((n, l) => n + l.length, 0),
      memberships_loaded: memberships.size,
      correspondences_loaded: Math.round(totalCorr),
      harmonics_parse_failures: harmonicsParseFailures,
    },
  }
}

// --- Spec validation ---

export function validateSpec(raw: unknown): raw is ManifestSpec {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Record<string, unknown>
  if (s.v !== 1) return false
  if (typeof s.slug !== 'string' || !s.slug) return false
  if (typeof s.name !== 'string') return false
  if (typeof s.description !== 'string') return false
  if (!s.include || typeof s.include !== 'object') return false
  const inc = s.include as Record<string, unknown>
  if (!Array.isArray(inc.category_prefixes)) return false
  if (!inc.category_prefixes.every(x => typeof x === 'string')) return false
  return true
}

// --- Matching helpers ---

function matchesInclude(categorySlug: string, spec: ManifestSpec): boolean {
  if (spec.include.category_prefixes.some(p => categorySlug.startsWith(p))) return true
  if (spec.include.category_exact?.includes(categorySlug)) return true
  return false
}

function matchesExclude(
  categorySlug: string,
  tagSlugs: string[],
  exclude: ManifestSpec['exclude']
): boolean {
  if (!exclude) return false
  if (exclude.category_prefixes?.some(p => categorySlug.startsWith(p))) return true
  if (exclude.tags?.length) {
    const ex = new Set(exclude.tags)
    if (tagSlugs.some(t => ex.has(t))) return true
  }
  return false
}

// --- Build one manifest ---

export function buildManifest(spec: ManifestSpec, graph: GraphSnapshot): Manifest {
  const start = Date.now()
  const internalOnly = spec.correspondence_filter?.internal_only ?? true
  const includedIds = new Set<string>()

  // Pass 1: category-based include
  for (const atom of graph.atoms.values()) {
    if (matchesInclude(atom.category_slug, spec)) includedIds.add(atom.id)
  }

  // Pass 2: tag_categories include (additive)
  const tagCats = spec.include.tag_categories
  if (tagCats && tagCats.length > 0) {
    const set = new Set(tagCats)
    for (const [atomId, tags] of graph.atomTags) {
      if (tags.some(t => set.has(t.category))) includedIds.add(atomId)
    }
  }

  // Pass 3: explicit tags include (additive)
  const inclTags = spec.include.tags
  if (inclTags && inclTags.length > 0) {
    const set = new Set(inclTags)
    for (const [atomId, tags] of graph.atomTags) {
      if (tags.some(t => set.has(t.slug))) includedIds.add(atomId)
    }
  }

  // Pass 4: excludes
  if (spec.exclude) {
    for (const id of [...includedIds]) {
      const atom = graph.atoms.get(id)
      if (!atom) { includedIds.delete(id); continue }
      const tagSlugs = (graph.atomTags.get(id) ?? []).map(t => t.slug)
      if (matchesExclude(atom.category_slug, tagSlugs, spec.exclude)) includedIds.delete(id)
    }
  }

  // Pass 5: compact atom entries
  const outAtoms: ManifestAtom[] = []
  const tagSlugsUsed = new Set<string>()
  let membershipCount = 0
  const uniqueCorrKeys = new Set<string>()

  for (const id of includedIds) {
    const atom = graph.atoms.get(id)
    if (!atom) continue
    const entry: ManifestAtom = {
      id,
      text: atom.text,
      cat: atom.category_slug,
      h: atom.h,
    }

    const tagList = graph.atomTags.get(id)
    if (tagList && tagList.length > 0) {
      const slugs = tagList.map(t => t.slug)
      entry.tags = slugs
      for (const s of slugs) tagSlugsUsed.add(s)
    }

    const poles = graph.memberships.get(id)
    if (poles && Object.keys(poles).length > 0) {
      entry.poles = poles
      membershipCount++
    }

    const corrs = graph.correspondences.get(id)
    if (corrs && corrs.length > 0) {
      const rel: ManifestRelation[] = []
      for (const c of corrs) {
        if (internalOnly && !includedIds.has(c.target)) continue
        rel.push({ id: c.target, type: c.type, s: c.s, p: c.p })
        const keyA = c.a_id < c.b_id ? c.a_id : c.b_id
        const keyB = c.a_id < c.b_id ? c.b_id : c.a_id
        uniqueCorrKeys.add(`${keyA}|${keyB}|${c.type}`)
      }
      if (rel.length > 0) entry.rel = rel
    }

    outAtoms.push(entry)
  }

  const stats: ManifestStats = {
    atom_count: outAtoms.length,
    correspondence_count: uniqueCorrKeys.size,
    tag_count: tagSlugsUsed.size,
    membership_count: membershipCount,
    build_duration_ms: Date.now() - start,
  }

  return {
    v: 1,
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    built_at: new Date().toISOString(),
    stats,
    atoms: outAtoms,
  }
}

// --- R2 helpers ---

async function listSpecs(r2: R2Bucket): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  while (true) {
    const page = await r2.list({ prefix: 'specs/manifests/', cursor, limit: 1000 })
    for (const obj of page.objects) {
      if (obj.key.endsWith('.json')) out.push(obj.key)
    }
    if (!page.truncated) break
    cursor = page.cursor
    if (!cursor) break
  }
  return out
}

async function loadSpec(r2: R2Bucket, key: string): Promise<unknown | null> {
  const obj = await r2.get(key)
  if (!obj) return null
  try {
    return await obj.json()
  } catch {
    return null
  }
}

async function writeManifest(r2: R2Bucket, manifest: Manifest): Promise<number> {
  const body = JSON.stringify(manifest)
  const meta: ManifestMeta = {
    slug: manifest.slug,
    name: manifest.name,
    built_at: manifest.built_at,
    stats: manifest.stats,
    size_bytes: body.length,
  }
  await Promise.all([
    r2.put(`manifests/${manifest.slug}.json`, body, {
      httpMetadata: { contentType: 'application/json' },
    }),
    r2.put(`manifests/${manifest.slug}.meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json' },
    }),
  ])
  return body.length
}

// --- Build all / subset ---

export async function buildAllManifests(
  env: Env,
  specSlugs?: string[]
): Promise<ManifestBuildResult> {
  const totalStart = Date.now()
  if (!env.GRIMOIRE_R2) throw new Error('GRIMOIRE_R2 binding not configured')

  const specKeys = await listSpecs(env.GRIMOIRE_R2)
  if (specKeys.length === 0) {
    log.warn('No manifest specs found under specs/manifests/')
    return { graph_load_ms: 0, total_ms: Date.now() - totalStart, manifests: [], skipped: [] }
  }

  const wantedSlugs = specSlugs ? new Set(specSlugs) : null
  const specs: ManifestSpec[] = []
  const skipped: Array<{ slug: string; reason: string }> = []

  for (const key of specKeys) {
    const raw = await loadSpec(env.GRIMOIRE_R2, key)
    if (!validateSpec(raw)) {
      const slug = (raw && typeof raw === 'object' && 'slug' in raw && typeof (raw as { slug: unknown }).slug === 'string')
        ? (raw as { slug: string }).slug
        : key
      log.warn('Invalid manifest spec, skipping', { key })
      skipped.push({ slug, reason: 'invalid spec' })
      continue
    }
    if (wantedSlugs && !wantedSlugs.has(raw.slug)) continue
    specs.push(raw)
  }

  if (wantedSlugs) {
    for (const requested of wantedSlugs) {
      if (!specs.find(s => s.slug === requested)) {
        skipped.push({ slug: requested, reason: 'spec not found' })
      }
    }
  }

  if (specs.length === 0) {
    return {
      graph_load_ms: 0,
      total_ms: Date.now() - totalStart,
      manifests: [],
      skipped,
    }
  }

  // Union of all requested provenances across specs, so one graph load covers all
  const provSet = new Set<string>()
  for (const s of specs) {
    const list = s.correspondence_filter?.provenances ?? DEFAULT_PROVENANCES
    for (const p of list) provSet.add(p)
  }

  const graph = await loadFullGraph(env.DB, { provenances: [...provSet] })
  log.info('Manifest graph loaded', {
    duration_ms: graph.loadDurationMs,
    ...graph.stats,
    provenances: [...provSet],
  })

  const out: ManifestBuildSummary[] = []
  for (const spec of specs) {
    try {
      const manifest = buildManifest(spec, graph)
      const bytes = await writeManifest(env.GRIMOIRE_R2, manifest)
      out.push({
        slug: spec.slug,
        name: spec.name,
        stats: manifest.stats,
        bytes,
      })
      log.info('Manifest built', { slug: spec.slug, atom_count: manifest.stats.atom_count, bytes })
    } catch (err) {
      log.error('Manifest build failed', { slug: spec.slug, error: String(err) })
      skipped.push({ slug: spec.slug, reason: `build error: ${String(err)}` })
    }
  }

  // Update last-build timestamp for the sweep-trigger guard
  if (out.length > 0) {
    try {
      await env.CONNECTIVITY_KV.put(KV_LAST_BUILD_KEY, Date.now().toString())
    } catch (err) {
      log.warn('Failed to write manifests:last_build KV key', { error: String(err) })
    }
  }

  return {
    graph_load_ms: graph.loadDurationMs,
    total_ms: Date.now() - totalStart,
    manifests: out,
    skipped,
  }
}

// --- Listing (for GET /admin/manifests) ---

export async function listBuiltManifests(r2: R2Bucket): Promise<ManifestMeta[]> {
  const out: ManifestMeta[] = []
  let cursor: string | undefined
  while (true) {
    const page = await r2.list({ prefix: 'manifests/', cursor, limit: 1000 })
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.meta.json')) continue
      const got = await r2.get(obj.key)
      if (!got) continue
      try {
        const meta = await got.json<ManifestMeta>()
        out.push(meta)
      } catch {
        // skip malformed
      }
    }
    if (!page.truncated) break
    cursor = page.cursor
    if (!cursor) break
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}
