import type { Env, AtomRow, ArrangementRow, IncantationRow, IncantationSlotRow } from './types'
import {
  getCompositionalBoost,
  isOppositionalInContext,
  getProviderWarnings,
} from './state/relations'

// --- Types ---

export interface InvokeRequest {
  incantation: string
  arrangement?: string
  seeds?: Record<string, string>
  intent?: string
  modality?: 'visual' | 'narrative' | 'both'
  render_mode?: string       // 'photographic' | 'cgi' | 'illustration' | 'painterly'
  target_provider?: string   // provider slug for behavior warnings
}

interface SlotResult {
  slot_name: string
  selected: { text: string; atom_id: string; score: number }
  alternatives: Array<{ text: string; atom_id: string; score: number }>
  opposition_warnings: string[]
}

interface InvokeResponse {
  incantation: string
  arrangement: string | null
  slots: SlotResult[]
  assembled_prompt: string
  provider_warnings?: string[]
  metadata: {
    total_score: number
    modality: string
    correspondences_used: number
    relation_effects: {
      compositional_boosts: number
      oppositional_filters: number
      provider_warnings: number
    }
  }
}

interface HarmonicProfile {
  hardness: string
  temperature: string
  weight: string
  formality: string
  era_affinity: string
  register?: number  // 0.0-1.0, null/undefined coalesces to 0.5
}

interface ScoringWeights {
  exemplar: number
  correspondence: number
  harmonic: number
  tier: number
  semantic: number
}

interface CandidateAtom {
  id: string
  text: string
  text_lower: string
  harmonics: HarmonicProfile
  tier: number
}

export class InvokeError extends Error {
  status: number
  constructor(message: string, status: number = 400) {
    super(message)
    this.status = status
  }
}

// --- Constants ---

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5' as const

const DIMENSION_VECTORS: Record<string, Record<string, number[]>> = {
  hardness:     { hard: [1, 0], soft: [0, 1], neutral: [0.5, 0.5] },
  temperature:  { warm: [1, 0], cool: [0, 1], neutral: [0.5, 0.5] },
  weight:       { heavy: [1, 0], light: [0, 1], neutral: [0.5, 0.5] },
  formality:    { structured: [1, 0], organic: [0, 1], neutral: [0.5, 0.5] },
  era_affinity: { archaic: [1, 0, 0, 0], industrial: [0, 1, 0, 0], modern: [0, 0, 1, 0], timeless: [0, 0, 0, 1] },
}

const TIER_WEIGHT: Record<number, number> = { 1: 1.0, 2: 0.6, 3: 0.2 }
const RANDOM_FLOOR = 0.05
const CANDIDATE_LIMIT = 200

const WEIGHTS_WITH_ARRANGEMENT: ScoringWeights = {
  exemplar: 0.30, correspondence: 0.25, harmonic: 0.25, tier: 0.15, semantic: 0.05,
}
const WEIGHTS_NO_ARRANGEMENT: ScoringWeights = {
  exemplar: 0.40, correspondence: 0.30, harmonic: 0.00, tier: 0.20, semantic: 0.10,
}

// --- Harmonic Similarity (ported from conductor.ts) ---

function harmonicSimilarity(a: HarmonicProfile, b: HarmonicProfile): number {
  const categoricalDims: (keyof HarmonicProfile)[] = [
    'hardness', 'temperature', 'weight', 'formality', 'era_affinity',
  ]
  let totalSim = 0
  for (const dim of categoricalDims) {
    const vecA = DIMENSION_VECTORS[dim][a[dim] as string] || DIMENSION_VECTORS[dim]['neutral']
    const vecB = DIMENSION_VECTORS[dim][b[dim] as string] || DIMENSION_VECTORS[dim]['neutral']
    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i]
      magA += vecA[i] * vecA[i]
      magB += vecB[i] * vecB[i]
    }
    totalSim += (magA > 0 && magB > 0) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0
  }

  // Register dimension: continuous 0.0-1.0, coalesce null/undefined to 0.5
  const regA = a.register ?? 0.5
  const regB = b.register ?? 0.5
  const rVecA = [regA, 1 - regA]
  const rVecB = [regB, 1 - regB]
  const rDot = rVecA[0] * rVecB[0] + rVecA[1] * rVecB[1]
  const rMagA = Math.sqrt(rVecA[0] * rVecA[0] + rVecA[1] * rVecA[1])
  const rMagB = Math.sqrt(rVecB[0] * rVecB[0] + rVecB[1] * rVecB[1])
  const regSim = (rMagA > 0 && rMagB > 0) ? rDot / (rMagA * rMagB) : 0
  totalSim += regSim

  return totalSim / 6  // 5 categorical + 1 register
}

function safeParseHarmonics(json: string, register?: number | null): HarmonicProfile {
  try {
    const h = JSON.parse(json)
    return {
      hardness: h.hardness || 'neutral',
      temperature: h.temperature || 'neutral',
      weight: h.weight || 'neutral',
      formality: h.formality || 'neutral',
      era_affinity: h.era_affinity || 'timeless',
      register: register ?? 0.5,
    }
  } catch {
    return { hardness: 'neutral', temperature: 'neutral', weight: 'neutral', formality: 'neutral', era_affinity: 'timeless', register: register ?? 0.5 }
  }
}

// --- Weighted Random Selection ---

function weightedRandomPick<T extends { total_score: number }>(candidates: T[], topN: number = 5): T {
  const top = candidates.slice(0, topN)
  if (top.length === 0) throw new InvokeError('No candidates available', 500)
  if (top.length === 1) return top[0]

  const weights = top.map(c => c.total_score * c.total_score + RANDOM_FLOOR)
  const sum = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * sum
  for (let i = 0; i < top.length; i++) {
    r -= weights[i]
    if (r <= 0) return top[i]
  }
  return top[0]
}

// --- Data Loading ---

async function loadMetadata(
  db: D1Database,
  incantationSlug: string,
  arrangementSlug: string | undefined,
) {
  const stmts: D1PreparedStatement[] = [
    db.prepare('SELECT * FROM incantations WHERE slug = ?').bind(incantationSlug),
    db.prepare(
      'SELECT * FROM incantation_slots WHERE incantation_id = (SELECT id FROM incantations WHERE slug = ?) ORDER BY sort_order'
    ).bind(incantationSlug),
    db.prepare(
      'SELECT e.slot_name, e.atom_id, e.frequency, a.text FROM exemplars e JOIN atoms a ON e.atom_id = a.id WHERE e.incantation_id = (SELECT id FROM incantations WHERE slug = ?)'
    ).bind(incantationSlug),
  ]
  if (arrangementSlug) {
    stmts.push(db.prepare('SELECT * FROM arrangements WHERE slug = ?').bind(arrangementSlug))
  }

  const results = await db.batch(stmts)

  const incantation = (results[0].results as unknown as IncantationRow[])[0] || null
  if (!incantation) throw new InvokeError(`Incantation "${incantationSlug}" not found`, 404)

  const slots = results[1].results as unknown as IncantationSlotRow[]
  if (slots.length === 0) throw new InvokeError(`Incantation "${incantationSlug}" has no slots`, 500)

  // Build exemplar maps
  const exemplarRows = results[2].results as unknown as Array<{ slot_name: string; atom_id: string; frequency: number; text: string }>
  const exemplarMap = new Map<string, Map<string, number>>()
  const maxFreqPerSlot = new Map<string, number>()
  for (const row of exemplarRows) {
    if (!exemplarMap.has(row.slot_name)) exemplarMap.set(row.slot_name, new Map())
    exemplarMap.get(row.slot_name)!.set(row.atom_id, row.frequency)
    const current = maxFreqPerSlot.get(row.slot_name) || 0
    if (row.frequency > current) maxFreqPerSlot.set(row.slot_name, row.frequency)
  }

  let arrangement: ArrangementRow | null = null
  if (arrangementSlug) {
    arrangement = (results[3].results as unknown as ArrangementRow[])[0] || null
    if (!arrangement) throw new InvokeError(`Arrangement "${arrangementSlug}" not found`, 404)
  }

  return { incantation, slots, exemplarMap, maxFreqPerSlot, arrangement }
}

async function resolveSeeds(
  db: D1Database,
  seeds: Record<string, string>,
  validSlotNames: Set<string>,
): Promise<Map<string, CandidateAtom>> {
  const entries = Object.entries(seeds)
  if (entries.length === 0) return new Map()

  // Validate slot names
  for (const [slotName] of entries) {
    if (!validSlotNames.has(slotName)) {
      throw new InvokeError(`Seed slot "${slotName}" does not exist in this incantation`, 400)
    }
  }

  const stmts = entries.map(([, text]) =>
    db.prepare(
      'SELECT id, text, text_lower, category_slug, harmonics, tier, modality, register FROM atoms WHERE text_lower = ? LIMIT 1'
    ).bind(text.toLowerCase().trim())
  )
  const results = await db.batch(stmts)

  const resolved = new Map<string, CandidateAtom>()
  for (let i = 0; i < entries.length; i++) {
    const [slotName, text] = entries[i]
    const rows = results[i].results as unknown as AtomRow[]
    if (!rows || rows.length === 0) {
      throw new InvokeError(`Seed atom "${text}" not found for slot "${slotName}"`, 400)
    }
    const atom = rows[0]
    resolved.set(slotName, {
      id: atom.id,
      text: atom.text,
      text_lower: atom.text_lower,
      harmonics: safeParseHarmonics(atom.harmonics, (atom as any).register),
      tier: atom.tier ?? 3,
    })
  }
  return resolved
}

async function loadCandidatePools(
  db: D1Database,
  uniqueCategories: string[],
  modality: string,
): Promise<Map<string, CandidateAtom[]>> {
  if (uniqueCategories.length === 0) return new Map()

  const stmts = uniqueCategories.map(cat =>
    db.prepare(
      "SELECT id, text, text_lower, harmonics, tier, register FROM atoms WHERE category_slug = ? AND modality IN (?, 'both') AND status != 'rejected' ORDER BY tier ASC LIMIT ?"
    ).bind(cat, modality, CANDIDATE_LIMIT)
  )
  const results = await db.batch(stmts)

  const pools = new Map<string, CandidateAtom[]>()
  for (let i = 0; i < uniqueCategories.length; i++) {
    const rows = results[i].results as unknown as Array<{ id: string; text: string; text_lower: string; harmonics: string; tier: number; register: number | null }>
    pools.set(uniqueCategories[i], rows.map(r => ({
      id: r.id,
      text: r.text,
      text_lower: r.text_lower,
      harmonics: safeParseHarmonics(r.harmonics, r.register),
      tier: r.tier ?? 3,
    })))
  }
  return pools
}

async function embedIntent(
  ai: Ai,
  intent: string,
): Promise<number[] | null> {
  try {
    const result = await ai.run(EMBEDDING_MODEL, { text: [intent] })
    if ('data' in result && result.data?.[0]) return result.data[0]
    return null
  } catch (e) {
    console.error('Intent embedding failed:', e)
    return null
  }
}

// --- Correspondence Functions ---

async function accumulateCorrespondences(
  db: D1Database,
  atomId: string,
  resonanceMap: Map<string, number>,
): Promise<number> {
  const { results } = await db.prepare(
    `SELECT atom_a_id, atom_b_id, strength FROM correspondences
     WHERE (atom_a_id = ? OR atom_b_id = ?)
       AND relationship_type IN ('resonates', 'evokes')`
  ).bind(atomId, atomId).all<{ atom_a_id: string; atom_b_id: string; strength: number }>()

  for (const row of results) {
    const neighborId = row.atom_a_id === atomId ? row.atom_b_id : row.atom_a_id
    resonanceMap.set(neighborId, (resonanceMap.get(neighborId) || 0) + row.strength)
  }
  return results.length
}

async function checkAllOppositions(
  db: D1Database,
  selectedAtomIds: string[],
): Promise<Map<string, string[]>> {
  const warnings = new Map<string, string[]>()
  if (selectedAtomIds.length < 2) return warnings

  const placeholders = selectedAtomIds.map(() => '?').join(',')
  const { results } = await db.prepare(
    `SELECT c.atom_a_id, c.atom_b_id, a1.text AS text_a, a2.text AS text_b
     FROM correspondences c
     JOIN atoms a1 ON a1.id = c.atom_a_id
     JOIN atoms a2 ON a2.id = c.atom_b_id
     WHERE c.relationship_type = 'opposes'
       AND c.atom_a_id IN (${placeholders})
       AND c.atom_b_id IN (${placeholders})`
  ).bind(...selectedAtomIds, ...selectedAtomIds)
    .all<{ atom_a_id: string; atom_b_id: string; text_a: string; text_b: string }>()

  for (const row of results) {
    const msg = `"${row.text_a}" opposes "${row.text_b}"`
    // Attach warning to both atoms
    if (!warnings.has(row.atom_a_id)) warnings.set(row.atom_a_id, [])
    warnings.get(row.atom_a_id)!.push(msg)
    if (!warnings.has(row.atom_b_id)) warnings.set(row.atom_b_id, [])
    warnings.get(row.atom_b_id)!.push(msg)
  }
  return warnings
}

// --- Template Assembly ---

function assemblePrompt(
  templateText: string | null,
  slotResults: SlotResult[],
  slots: IncantationSlotRow[],
): string {
  if (templateText) {
    let assembled = templateText
    for (const result of slotResults) {
      if (result.selected.text) {
        assembled = assembled.replace(`{${result.slot_name}}`, result.selected.text)
      }
    }
    // Remove unfilled optional placeholders, collapse commas
    assembled = assembled
      .replace(/\{[a-z_]+\}/g, '')
      .replace(/,\s*,/g, ',')
      .replace(/\(\s*,/g, '(')
      .replace(/,\s*\)/g, ')')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .trim()
    return assembled
  }

  // No template: join by sort_order
  const sortMap = new Map(slots.map(s => [s.slot_name, s.sort_order]))
  return [...slotResults]
    .filter(r => r.selected.text)
    .sort((a, b) => (sortMap.get(a.slot_name) ?? 999) - (sortMap.get(b.slot_name) ?? 999))
    .map(r => r.selected.text)
    .join(', ')
}

// --- Main Entry Point ---

export async function invoke(env: Env, request: InvokeRequest): Promise<InvokeResponse> {
  const db = env.DB
  const modality = request.modality || 'visual'
  const renderMode = request.render_mode || null
  const targetProvider = request.target_provider || null
  const renderModeContext = renderMode ? `render_mode=${renderMode}` : null

  // Relation effect counters
  let compositionalBoosts = 0
  let oppositionalFilters = 0

  // 1. Load metadata
  const { incantation, slots, exemplarMap, maxFreqPerSlot, arrangement } = await loadMetadata(
    db, request.incantation, request.arrangement,
  )

  // 2. Determine scoring weights
  const hasArrangement = !!arrangement
  const hasIntent = !!request.intent
  let weights: ScoringWeights
  if (hasArrangement) {
    weights = { ...WEIGHTS_WITH_ARRANGEMENT }
    if (!hasIntent) {
      // Redistribute semantic weight to exemplar
      weights.exemplar += weights.semantic
      weights.semantic = 0
    }
  } else {
    weights = { ...WEIGHTS_NO_ARRANGEMENT }
    if (!hasIntent) {
      weights.exemplar += weights.semantic
      weights.semantic = 0
    }
  }

  // Parse arrangement harmonics/weights
  const arrangementHarmonics = arrangement ? safeParseHarmonics(arrangement.harmonics, (arrangement as any).register) : null
  const categoryWeights: Record<string, number> = arrangement
    ? (() => { try { return JSON.parse(arrangement.category_weights) } catch { return {} } })()
    : {}

  // 3. Resolve seeds
  const validSlotNames = new Set(slots.map(s => s.slot_name))
  const seedMap = request.seeds
    ? await resolveSeeds(db, request.seeds, validSlotNames)
    : new Map<string, CandidateAtom>()

  // 4. Determine unique categories needed (non-seeded slots only)
  const seededSlotNames = new Set(seedMap.keys())
  const uniqueCategories = [...new Set(
    slots
      .filter(s => !seededSlotNames.has(s.slot_name) && s.category_filter)
      .map(s => s.category_filter!)
  )]

  // 5. Load candidates + embed intent in parallel
  const [candidatePools, intentVector] = await Promise.all([
    loadCandidatePools(db, uniqueCategories, modality),
    hasIntent ? embedIntent(env.AI, request.intent!) : Promise.resolve(null),
  ])

  // 6. If intent vector exists, query Vectorize for semantic scores
  let intentScores: Map<string, number> | null = null
  if (intentVector) {
    try {
      const matches = await env.VECTORIZE.query(intentVector, {
        topK: 200,
        returnMetadata: 'none',
        returnValues: false,
      })
      intentScores = new Map()
      for (const match of matches.matches) {
        intentScores.set(match.id, match.score)
      }
    } catch (e) {
      console.error('Vectorize intent query failed:', e)
    }
  }

  // 7. Determine fill order: seeded first, then by category weight desc, sort_order asc
  const orderedSlots = [...slots].sort((a, b) => {
    const aSeeded = seededSlotNames.has(a.slot_name) ? 0 : 1
    const bSeeded = seededSlotNames.has(b.slot_name) ? 0 : 1
    if (aSeeded !== bSeeded) return aSeeded - bSeeded
    const aWeight = categoryWeights[a.category_filter || ''] ?? 1.0
    const bWeight = categoryWeights[b.category_filter || ''] ?? 1.0
    if (aWeight !== bWeight) return bWeight - aWeight
    return a.sort_order - b.sort_order
  })

  // 8. Fill slots
  const resonanceMap = new Map<string, number>()
  const selectedAtomIds = new Set<string>()
  const slotResults: SlotResult[] = []
  let correspondencesUsed = 0

  for (const slot of orderedSlots) {
    // Seeded slot: direct placement
    if (seededSlotNames.has(slot.slot_name)) {
      const seed = seedMap.get(slot.slot_name)!
      selectedAtomIds.add(seed.id)
      slotResults.push({
        slot_name: slot.slot_name,
        selected: { text: seed.text, atom_id: seed.id, score: 1.0 },
        alternatives: [],
        opposition_warnings: [],
      })
      const count = await accumulateCorrespondences(db, seed.id, resonanceMap)
      correspondencesUsed += count
      continue
    }

    // Non-seeded: score candidates
    const pool = candidatePools.get(slot.category_filter || '') || []
    const available = pool.filter(a => !selectedAtomIds.has(a.id))

    if (available.length === 0) {
      if (slot.required) {
        slotResults.push({
          slot_name: slot.slot_name,
          selected: { text: '', atom_id: '', score: 0 },
          alternatives: [],
          opposition_warnings: [],
        })
      }
      continue
    }

    // Score all candidates
    const slotExemplars = exemplarMap.get(slot.slot_name) || new Map<string, number>()
    const maxFreq = maxFreqPerSlot.get(slot.slot_name) || 1

    const scored = available.map(atom => {
      const exemplarScore = (slotExemplars.get(atom.id) || 0) / maxFreq
      const corrScore = resonanceMap.get(atom.id) || 0
      const harmonicScore = arrangementHarmonics
        ? harmonicSimilarity(atom.harmonics, arrangementHarmonics)
        : 0
      const tierScore = TIER_WEIGHT[atom.tier] ?? 0.2
      const semanticScore = intentScores?.get(atom.id) || 0

      return {
        ...atom,
        exemplar_score: exemplarScore,
        correspondence_score: corrScore,
        harmonic_score: harmonicScore,
        tier_score: tierScore,
        semantic_score: semanticScore,
        total_score: 0, // computed after normalization
      }
    })

    // Normalize correspondence scores within this slot
    const maxCorr = Math.max(...scored.map(s => s.correspondence_score), 0.001)
    for (const s of scored) {
      const normCorr = s.correspondence_score / maxCorr
      s.total_score =
        weights.exemplar * s.exemplar_score +
        weights.correspondence * normCorr +
        weights.harmonic * s.harmonic_score +
        weights.tier * s.tier_score +
        weights.semantic * s.semantic_score
    }

    // Compositional boost: candidates with partners in already-selected atoms get score increase
    const selectedIds = [...selectedAtomIds]
    if (selectedIds.length > 0) {
      for (const s of scored) {
        const boost = await getCompositionalBoost(db, s.id, selectedIds, arrangement?.slug ?? null)
        if (boost > 0) {
          s.total_score += boost
          compositionalBoosts++
        }
      }
    }

    // Oppositional filter: remove candidates with strong context-specific opposition
    let finalCandidates = scored
    if (renderModeContext || arrangement?.slug) {
      const filtered: typeof scored = []
      for (const s of scored) {
        const opposed = await isOppositionalInContext(db, s.id, renderModeContext, arrangement?.slug ?? null)
        if (opposed) {
          oppositionalFilters++
        } else {
          filtered.push(s)
        }
      }
      // Only use filtered list if it's non-empty (don't filter ALL candidates)
      if (filtered.length > 0) {
        finalCandidates = filtered
      }
    }

    finalCandidates.sort((a, b) => b.total_score - a.total_score)

    // Pick winner via weighted random from top 5
    const winner = weightedRandomPick(finalCandidates, 5)
    selectedAtomIds.add(winner.id)

    // Alternatives: top 3 excluding winner
    const alts = finalCandidates
      .filter(s => s.id !== winner.id)
      .slice(0, 3)
      .map(a => ({ text: a.text, atom_id: a.id, score: Math.round(a.total_score * 1000) / 1000 }))

    slotResults.push({
      slot_name: slot.slot_name,
      selected: {
        text: winner.text,
        atom_id: winner.id,
        score: Math.round(winner.total_score * 1000) / 1000,
      },
      alternatives: alts,
      opposition_warnings: [], // filled post-loop
    })

    // Accumulate correspondences from winner
    const count = await accumulateCorrespondences(db, winner.id, resonanceMap)
    correspondencesUsed += count
  }

  // 9. Post-loop: check oppositions across all selected atoms
  const allSelectedIds = [...selectedAtomIds]
  const oppositionMap = await checkAllOppositions(db, allSelectedIds)

  // Inject warnings into slot results
  for (const result of slotResults) {
    const warnings = oppositionMap.get(result.selected.atom_id)
    if (warnings) result.opposition_warnings = warnings
  }

  // 10. Provider behavior warnings (surfaced, not auto-removed)
  let providerWarnings: string[] | undefined
  if (targetProvider) {
    const warnings: string[] = []
    for (const result of slotResults) {
      if (!result.selected.atom_id) continue
      const behaviors = await getProviderWarnings(
        db,
        targetProvider,
        renderMode,
        result.selected.atom_id,
        null, // category not tracked on SlotResult, query by atom_id only
      )
      for (const b of behaviors) {
        if (b.severity === 'breaking' || b.severity === 'warning') {
          warnings.push(`[${b.severity}] Atom "${result.selected.text}": ${b.behavior}`)
        }
      }
    }
    if (warnings.length > 0) {
      providerWarnings = warnings
    }
  }

  // 11. Assemble prompt
  const assembledPrompt = assemblePrompt(incantation.template_text, slotResults, slots)

  // 12. Re-sort results by slot sort_order for display
  const sortOrderMap = new Map(slots.map(s => [s.slot_name, s.sort_order]))
  slotResults.sort((a, b) =>
    (sortOrderMap.get(a.slot_name) ?? 999) - (sortOrderMap.get(b.slot_name) ?? 999)
  )

  // 13. Compute total score
  const scoredSlots = slotResults.filter(r => r.selected.score > 0)
  const totalScore = scoredSlots.length > 0
    ? Math.round((scoredSlots.reduce((sum, r) => sum + r.selected.score, 0) / scoredSlots.length) * 1000) / 1000
    : 0

  // 14. Diagnostic logging
  const providerWarningCount = providerWarnings?.length ?? 0
  console.log('[grimoire:invoke] Relation effects:', JSON.stringify({
    compositional_boosts: compositionalBoosts,
    oppositional_filters: oppositionalFilters,
    provider_warnings: providerWarningCount,
    render_mode: renderMode,
    arrangement: arrangement?.slug ?? null,
    target_provider: targetProvider,
  }))

  const response: InvokeResponse = {
    incantation: request.incantation,
    arrangement: arrangement?.slug || null,
    slots: slotResults,
    assembled_prompt: assembledPrompt,
    metadata: {
      total_score: totalScore,
      modality,
      correspondences_used: correspondencesUsed,
      relation_effects: {
        compositional_boosts: compositionalBoosts,
        oppositional_filters: oppositionalFilters,
        provider_warnings: providerWarningCount,
      },
    },
  }

  if (providerWarnings) {
    response.provider_warnings = providerWarnings
  }

  return response
}
