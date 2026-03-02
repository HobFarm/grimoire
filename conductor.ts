/**
 * Grimoire Conductor
 * 
 * The band leader. Takes an Intermediate Representation from extraction
 * and an Arrangement (cymatics frequency pattern), then selects atoms
 * across all Grimoire collections that resonate with the composition target.
 * 
 * This is the MEDIATE phase of the FFE for StyleFusion prompt compilation.
 * 
 * Selection cascade:
 *   1. Exact match (IR term exists as atom text_lower)
 *   2. Substring match (IR phrase contains atom text)
 *   3. Category fallback (IR category hint matches atom category)
 *   4. Harmonic similarity (dot product across 5 dimensions)
 * 
 * No AI calls. Pure algorithmic selection. Fast enough for real-time.
 */

interface HarmonicProfile {
  hardness: 'hard' | 'soft' | 'neutral'
  temperature: 'warm' | 'cool' | 'neutral'
  weight: 'heavy' | 'light' | 'neutral'
  formality: 'structured' | 'organic' | 'neutral'
  era_affinity: 'archaic' | 'industrial' | 'modern' | 'timeless'
}

interface Arrangement {
  slug: string
  name: string
  harmonics: HarmonicProfile
  category_weights: Record<string, number>
  context_key: string
}

interface GrimoireAtom {
  id: string
  text_lower: string
  category_slug: string
  collection_slug: string
  harmonics: HarmonicProfile
  metadata: Record<string, any>
  harmonic_score?: number
}

interface CompositionSlot {
  category: string
  ir_terms: string[]          // what extraction produced
  selected_atoms: GrimoireAtom[]  // what the Grimoire contributed
  context_guidance?: string    // from category_contexts for this arrangement
  weight: number              // from arrangement category_weights
}

interface Composition {
  arrangement: string
  slots: CompositionSlot[]
  unmatched_terms: string[]   // IR terms that found no atoms
}

// Harmonic dimension values mapped to numeric vectors for dot product
const DIMENSION_VECTORS: Record<string, Record<string, number[]>> = {
  hardness:    { hard: [1, 0], soft: [0, 1], neutral: [0.5, 0.5] },
  temperature: { warm: [1, 0], cool: [0, 1], neutral: [0.5, 0.5] },
  weight:      { heavy: [1, 0], light: [0, 1], neutral: [0.5, 0.5] },
  formality:   { structured: [1, 0], organic: [0, 1], neutral: [0.5, 0.5] },
  era_affinity: { archaic: [1, 0, 0, 0], industrial: [0, 1, 0, 0], modern: [0, 0, 1, 0], timeless: [0, 0, 0, 1] },
}

/**
 * Compute harmonic similarity between two profiles.
 * Returns 0-1 where 1 = perfect resonance.
 */
function harmonicSimilarity(a: HarmonicProfile, b: HarmonicProfile): number {
  const dimensions: (keyof HarmonicProfile)[] = [
    'hardness', 'temperature', 'weight', 'formality', 'era_affinity'
  ]
  
  let totalSim = 0
  for (const dim of dimensions) {
    const vecA = DIMENSION_VECTORS[dim][a[dim]] || DIMENSION_VECTORS[dim]['neutral']
    const vecB = DIMENSION_VECTORS[dim][b[dim]] || DIMENSION_VECTORS[dim]['neutral']
    
    // Cosine similarity (vectors are already normalized-ish)
    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i]
      magA += vecA[i] * vecA[i]
      magB += vecB[i] * vecB[i]
    }
    const cos = (magA > 0 && magB > 0) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0
    totalSim += cos
  }
  
  return totalSim / dimensions.length
}

/**
 * Query atoms by category with harmonic scoring against an arrangement.
 * Returns atoms sorted by harmonic resonance.
 */
async function queryAtomsByCategory(
  db: D1Database,
  categorySlug: string,
  arrangement: Arrangement,
  limit: number = 20
): Promise<GrimoireAtom[]> {
  const { results } = await db.prepare(`
    SELECT id, text_lower, category_slug, collection_slug, harmonics, metadata
    FROM atoms
    WHERE category_slug = ?
    AND status != 'rejected'
    ORDER BY confidence DESC, encounter_count DESC
    LIMIT ?
  `).bind(categorySlug, limit * 2).all()

  if (!results || results.length === 0) return []

  return (results as any[])
    .map(row => {
      const harmonics = safeParseJSON(row.harmonics, {}) as HarmonicProfile
      const score = harmonicSimilarity(arrangement.harmonics, harmonics)
      return {
        id: row.id,
        text_lower: row.text_lower,
        category_slug: row.category_slug,
        collection_slug: row.collection_slug,
        harmonics,
        metadata: safeParseJSON(row.metadata, {}),
        harmonic_score: score,
      }
    })
    .sort((a, b) => (b.harmonic_score || 0) - (a.harmonic_score || 0))
    .slice(0, limit)
}

/**
 * Find atoms matching a specific IR term via the selection cascade.
 */
async function findAtomsForTerm(
  db: D1Database,
  term: string,
  categoryHint: string | null,
  arrangement: Arrangement,
  limit: number = 5
): Promise<GrimoireAtom[]> {
  const termLower = term.toLowerCase().trim()

  // Level 1: Exact match
  const exact = await db.prepare(`
    SELECT id, text_lower, category_slug, collection_slug, harmonics, metadata
    FROM atoms WHERE text_lower = ? AND status != 'rejected' LIMIT ?
  `).bind(termLower, limit).all()

  if (exact.results && exact.results.length > 0) {
    return (exact.results as any[]).map(row => ({
      id: row.id,
      text_lower: row.text_lower,
      category_slug: row.category_slug,
      collection_slug: row.collection_slug,
      harmonics: safeParseJSON(row.harmonics, {}),
      metadata: safeParseJSON(row.metadata, {}),
      harmonic_score: 1.0,
    }))
  }

  // Level 2: Substring match (term contains an atom)
  // Split the term into words and search for multi-word atom matches
  const words = termLower.split(/\s+/).filter(w => w.length > 2)
  if (words.length > 0) {
    // Search for atoms whose text appears in the term
    const likePatterns = words.slice(0, 3).map(() => 'text_lower LIKE ?').join(' OR ')
    const binds = words.slice(0, 3).map(w => `%${w}%`)
    
    const substr = await db.prepare(`
      SELECT id, text_lower, category_slug, collection_slug, harmonics, metadata
      FROM atoms 
      WHERE (${likePatterns}) AND status != 'rejected'
      LIMIT ?
    `).bind(...binds, limit * 3).all()

    if (substr.results && substr.results.length > 0) {
      // Score by how much of the atom text appears in the original term
      return (substr.results as any[])
        .filter(row => termLower.includes(row.text_lower) || row.text_lower.includes(termLower))
        .map(row => {
          const harmonics = safeParseJSON(row.harmonics, {}) as HarmonicProfile
          return {
            id: row.id,
            text_lower: row.text_lower,
            category_slug: row.category_slug,
            collection_slug: row.collection_slug,
            harmonics,
            metadata: safeParseJSON(row.metadata, {}),
            harmonic_score: harmonicSimilarity(arrangement.harmonics, harmonics) * 0.8,
          }
        })
        .sort((a, b) => (b.harmonic_score || 0) - (a.harmonic_score || 0))
        .slice(0, limit)
    }
  }

  // Level 3: Category fallback
  if (categoryHint) {
    return queryAtomsByCategory(db, categoryHint, arrangement, limit)
  }

  // Level 4: Harmonic similarity across all atoms (expensive, last resort)
  // In practice this rarely triggers; the conductor skips to unmatched
  return []
}

/**
 * Load an arrangement from D1.
 */
async function loadArrangement(
  db: D1Database,
  slug: string
): Promise<Arrangement | null> {
  const row = await db.prepare(
    'SELECT slug, name, harmonics, category_weights, context_key FROM arrangements WHERE slug = ?'
  ).bind(slug).first()

  if (!row) return null

  return {
    slug: row.slug as string,
    name: row.name as string,
    harmonics: safeParseJSON(row.harmonics as string, {}),
    category_weights: safeParseJSON(row.category_weights as string, {}),
    context_key: row.context_key as string,
  }
}

/**
 * Load category context guidance for an arrangement.
 */
async function loadContextGuidance(
  db: D1Database,
  contextKey: string
): Promise<Record<string, string>> {
  const { results } = await db.prepare(
    'SELECT category_slug, guidance FROM category_contexts WHERE context = ?'
  ).bind(contextKey).all()

  const guidance: Record<string, string> = {}
  for (const row of (results || []) as any[]) {
    guidance[row.category_slug] = row.guidance
  }
  return guidance
}

/**
 * Main composition function.
 * 
 * Takes a StyleFusion IR (the extraction output) and an arrangement slug,
 * and produces a Composition with selected atoms for each category slot.
 */
export async function compose(
  db: D1Database,
  ir: Record<string, any>,
  arrangementSlug: string
): Promise<Composition> {
  const arrangement = await loadArrangement(db, arrangementSlug)
  if (!arrangement) {
    throw new Error(`Arrangement "${arrangementSlug}" not found`)
  }

  const guidance = await loadContextGuidance(db, arrangement.context_key)

  // Map IR fields to category queries
  const irToCategoryMap: Record<string, string> = {
    'subject.form': 'subject.form',
    'subject.surface': 'covering.material',
    'subject.coloring': 'color.palette',
    'subject.features': 'subject.feature',
    'subject.covering': 'covering.clothing',
    'subject.position': 'pose.position',
    'subject.held_objects': 'object.held',
    'subject.expression_intent': 'subject.expression',
    'scene.setting': 'environment.setting',
    'scene.elements': 'environment.prop',
    'scene.atmosphere': 'environment.atmosphere',
    'camera.shot': 'camera.shot',
    'camera.lens': 'camera.lens',
    'lighting.key': 'lighting.source',
    'lighting.fill': 'lighting.source',
    'style.medium': 'style.medium',
    'style.textures': 'covering.material',
    'style.style_anchors': 'style.genre',
  }

  const slots: CompositionSlot[] = []
  const unmatched: string[] = []

  for (const [irPath, categorySlug] of Object.entries(irToCategoryMap)) {
    const value = getNestedValue(ir, irPath)
    if (!value) continue

    const terms = Array.isArray(value) ? value : [String(value)]
    const weight = arrangement.category_weights[categorySlug] || 1.0
    
    const allAtoms: GrimoireAtom[] = []
    const unmatchedTerms: string[] = []

    for (const term of terms) {
      if (typeof term !== 'string' || term.trim().length === 0) continue
      
      const atoms = await findAtomsForTerm(db, term, categorySlug, arrangement, 3)
      if (atoms.length > 0) {
        allAtoms.push(...atoms)
      } else {
        unmatchedTerms.push(term)
      }
    }

    // Deduplicate atoms by id
    const seen = new Set<string>()
    const unique = allAtoms.filter(a => {
      if (seen.has(a.id)) return false
      seen.add(a.id)
      return true
    })

    // Sort by harmonic score weighted by category importance
    unique.sort((a, b) => 
      ((b.harmonic_score || 0) * weight) - ((a.harmonic_score || 0) * weight)
    )

    slots.push({
      category: categorySlug,
      ir_terms: terms.filter(t => typeof t === 'string'),
      selected_atoms: unique.slice(0, 5),
      context_guidance: guidance[categorySlug],
      weight,
    })

    unmatched.push(...unmatchedTerms)
  }

  // Sort slots by weight (most important categories first)
  slots.sort((a, b) => b.weight - a.weight)

  return {
    arrangement: arrangement.slug,
    slots,
    unmatched_terms: unmatched,
  }
}

/**
 * Compile a Composition into the three output formats.
 */
export function compilePrompts(composition: Composition): {
  natural_language: string
  json: Record<string, any>
  midjourney: string
} {
  // Natural language: concatenate atom-enriched descriptions
  const nlParts: string[] = []
  const mjParts: string[] = []
  const jsonOutput: Record<string, any> = {}

  for (const slot of composition.slots) {
    const atomTexts = slot.selected_atoms
      .map(a => {
        // If atom has camera directive, use that; otherwise use the text
        if (a.metadata?.camera) return a.metadata.camera
        return a.text_lower
      })
    
    // Natural language: combine IR terms with atom enrichment
    const irText = slot.ir_terms.join(', ')
    const atomEnrichment = atomTexts.filter(t => !slot.ir_terms.includes(t)).join(', ')
    
    if (irText) {
      nlParts.push(irText)
      if (atomEnrichment) nlParts.push(atomEnrichment)
    }

    // JSON: structured by category
    if (slot.ir_terms.length > 0 || atomTexts.length > 0) {
      jsonOutput[slot.category] = {
        ir: slot.ir_terms,
        atoms: atomTexts,
        guidance: slot.context_guidance || null,
      }
    }

    // Midjourney: flatten to comma-separated terms
    mjParts.push(...slot.ir_terms)
    mjParts.push(...atomTexts.slice(0, 2)) // limit atom contribution for MJ
  }

  return {
    natural_language: nlParts.join('. '),
    json: jsonOutput,
    midjourney: mjParts.join(', ') + ' --ar 2:3 --style raw',
  }
}

// Utilities
function safeParseJSON(str: any, fallback: any): any {
  if (!str || str === '{}' || str === '[]') return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj)
}
