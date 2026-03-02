/**
 * Atom relation queries for the invoke engine.
 * Operates on atom_relations and provider_behaviors tables in grimoire-db.
 */

// --- Types ---

export interface AtomRelation {
  id: string
  source_atom_id: string
  target_atom_id: string
  relation_type: string
  strength: number
  context: string | null
  source: string
  confidence: number
  partner_text?: string
  partner_id?: string
}

export interface ProviderBehavior {
  id: string
  provider: string
  atom_id: string | null
  atom_category: string | null
  behavior: string
  render_mode: string | null
  severity: string
}

// --- Compositional Partners ---

/**
 * Get compositional partners for a given atom.
 * Returns atoms that build well together with the source atom.
 * Bidirectional: checks both source and target sides.
 */
export async function getCompositionalPartners(
  db: D1Database,
  atomId: string,
  context?: string | null,
  limit = 10,
): Promise<AtomRelation[]> {
  const sql = `
    SELECT ar.*,
      CASE WHEN ar.source_atom_id = ?1 THEN ta.text ELSE sa.text END as partner_text,
      CASE WHEN ar.source_atom_id = ?1 THEN ar.target_atom_id ELSE ar.source_atom_id END as partner_id
    FROM atom_relations ar
    JOIN atoms sa ON ar.source_atom_id = sa.id
    JOIN atoms ta ON ar.target_atom_id = ta.id
    WHERE (ar.source_atom_id = ?1 OR ar.target_atom_id = ?1)
      AND ar.relation_type = 'compositional'
      AND (ar.context IS NULL OR ar.context = ?2)
    ORDER BY ar.strength DESC, ar.confidence DESC
    LIMIT ?3
  `
  const result = await db.prepare(sql).bind(atomId, context ?? null, limit).all<AtomRelation>()
  return result.results ?? []
}

// --- Oppositional Atoms ---

/**
 * Get oppositional relations for a given atom.
 * Returns atoms that conflict with the source atom in a given context.
 */
export async function getOppositionalAtoms(
  db: D1Database,
  atomId: string,
  context?: string | null,
): Promise<AtomRelation[]> {
  const sql = `
    SELECT ar.*,
      CASE WHEN ar.source_atom_id = ?1 THEN ta.text ELSE sa.text END as partner_text,
      CASE WHEN ar.source_atom_id = ?1 THEN ta.id ELSE sa.id END as partner_id
    FROM atom_relations ar
    JOIN atoms sa ON ar.source_atom_id = sa.id
    JOIN atoms ta ON ar.target_atom_id = ta.id
    WHERE (ar.source_atom_id = ?1 OR ar.target_atom_id = ?1)
      AND ar.relation_type = 'oppositional'
      AND (ar.context IS NULL OR ar.context = ?2)
    ORDER BY ar.strength DESC
  `
  const result = await db.prepare(sql).bind(atomId, context ?? null).all<AtomRelation>()
  return result.results ?? []
}

// --- Provider Behavior Warnings ---

/**
 * Get provider behaviors relevant to current generation context.
 * Used to check if an atom has known issues with a specific provider.
 */
export async function getProviderWarnings(
  db: D1Database,
  provider: string,
  renderMode?: string | null,
  atomId?: string | null,
  category?: string | null,
): Promise<ProviderBehavior[]> {
  const conditions: string[] = ['provider = ?1']
  const params: (string | null)[] = [provider]
  let paramIndex = 2

  if (renderMode) {
    conditions.push(`(render_mode IS NULL OR render_mode = ?${paramIndex})`)
    params.push(renderMode)
    paramIndex++
  }
  if (atomId) {
    conditions.push(`(atom_id IS NULL OR atom_id = ?${paramIndex})`)
    params.push(atomId)
    paramIndex++
  }
  if (category) {
    conditions.push(`(atom_category IS NULL OR atom_category = ?${paramIndex})`)
    params.push(category)
    paramIndex++
  }

  const sql = `
    SELECT * FROM provider_behaviors
    WHERE ${conditions.join(' AND ')}
    ORDER BY CASE severity WHEN 'breaking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
  `

  const result = await db.prepare(sql).bind(...params).all<ProviderBehavior>()
  return result.results ?? []
}

// --- Batch Compositional Check ---

/**
 * Check if a candidate atom has compositional relations with any already-selected atoms.
 * Returns a score boost (0 to COMPOSITIONAL_BOOST_CAP) based on strongest link.
 */
export const COMPOSITIONAL_BOOST_CAP = 0.3

export async function getCompositionalBoost(
  db: D1Database,
  candidateId: string,
  alreadySelected: string[],
  arrangement: string | null,
): Promise<number> {
  if (alreadySelected.length === 0) return 0

  // Build positional params: ?1 = candidateId, ?2 = arrangement context
  // ?3..?N = alreadySelected (used twice for bidirectional check)
  const placeholders = alreadySelected.map((_, i) => `?${i + 3}`).join(',')
  const sql = `
    SELECT MAX(strength * confidence) as max_affinity
    FROM atom_relations
    WHERE relation_type = 'compositional'
      AND (
        (source_atom_id = ?1 AND target_atom_id IN (${placeholders}))
        OR (target_atom_id = ?1 AND source_atom_id IN (${placeholders}))
      )
      AND (context IS NULL OR context = ?2)
  `

  const result = await db.prepare(sql)
    .bind(candidateId, arrangement, ...alreadySelected, ...alreadySelected)
    .first<{ max_affinity: number | null }>()

  return (result?.max_affinity ?? 0) * COMPOSITIONAL_BOOST_CAP
}

// --- Oppositional Context Check ---

/**
 * Check if an atom is on the wrong side of a strong oppositional relation
 * in the current render mode or arrangement context.
 * Only triggers on strong (>= 0.7), confident (>= 0.6) oppositions.
 */
export async function isOppositionalInContext(
  db: D1Database,
  atomId: string,
  renderModeContext: string | null,
  arrangement: string | null,
): Promise<boolean> {
  const contexts: string[] = []
  if (renderModeContext) contexts.push(renderModeContext)
  if (arrangement) contexts.push(arrangement)

  if (contexts.length === 0) return false

  const placeholders = contexts.map((_, i) => `?${i + 2}`).join(',')
  const sql = `
    SELECT COUNT(*) as cnt
    FROM atom_relations
    WHERE (source_atom_id = ?1 OR target_atom_id = ?1)
      AND relation_type = 'oppositional'
      AND context IN (${placeholders})
      AND strength >= 0.7
      AND confidence >= 0.6
  `

  const result = await db.prepare(sql)
    .bind(atomId, ...contexts)
    .first<{ cnt: number }>()

  return (result?.cnt ?? 0) > 0
}
