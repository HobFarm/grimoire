import { HARMONIC_DIMENSIONS, HARMONIC_DEFAULTS, VALID_MODALITIES, VALID_UTILITIES } from './constants'
import { type ModelContext } from './models'
import { callWithFallback } from './provider'
import { getCategoryMetadata, buildCategoryValidation } from './db'
import type { CategoryMetadata, CategoryValidation } from './types'

// --- Dynamic Prompt Builder ---

/**
 * Build classification prompt from DB-sourced category metadata.
 * Groups categories by default_modality to preserve the VISUAL/NARRATIVE/DUAL-MODE
 * structure the model expects, then appends static classification rules.
 */
export function buildClassificationPrompt(categories: CategoryMetadata[]): string {
  const visual = categories.filter(c => c.default_modality === 'visual')
  const narrative = categories.filter(c => c.default_modality === 'narrative')
  const both = categories.filter(c => c.default_modality === 'both')

  const formatCategory = (c: CategoryMetadata) => `- ${c.slug}: ${c.description}`

  return `You are classifying atoms for an AI creative system called the Grimoire. Atoms serve two purposes: visual image generation and narrative world-building. Your job is to assign each atom:

1. A category_slug from the valid list below
2. A modality: "visual", "narrative", or "both"
3. A harmonic profile with exactly 5 dimensions

VALID CATEGORIES:

VISUAL CATEGORIES (modality = "visual"):
${visual.map(formatCategory).join('\n')}

NARRATIVE CATEGORIES (modality = "narrative"):
${narrative.map(formatCategory).join('\n')}

DUAL-MODE CATEGORIES (modality = "both"):
${both.map(formatCategory).join('\n')}

MODALITY RULES:
- "visual": The term contributes to generating an image. It describes something you can see, render, or photograph.
- "narrative": The term contributes to storytelling, world-building, or domain-specific vocabulary. It has no direct visual rendering.
- "both": The term works in both contexts. It has visual presence AND narrative/world-building value.
- The category groupings above indicate the default modality, but override if the specific atom clearly belongs to a different modality.

CRITICAL CLASSIFICATION RULES:
1. ALL architectural styles -> style.genre. This includes: baroque, gothic, renaissance, rococo, tudor, colonial, victorian, art deco, brutalist, neoclassical, moorish, prairie, mission, queen-anne, edwardian, georgian, palladian, and ALL regional architecture.
2. General beauty/quality adjectives -> narrative.mood. Words like: adorable, alluring, attractive, beautiful, charming, cute, elegant, glamorous, gorgeous, stunning, etc.
3. subject.expression is ONLY for physical facial configurations: smiling, frowning, grimacing, squinting, winking, sneering, pouting. If you cannot act it out with your face muscles, it is NOT an expression.
4. Single abstract words that don't describe anything visually specific AND have no narrative value (structure, transition, resemble, effusive, diminutive) -> negative.filter.
5. Japanese architectural elements (engawa, fusuma, genkan, shoji, tatami) -> environment.prop.
6. Historical periods used as style context (Meiji period, Showa period, Renaissance, Baroque era) -> style.era.
7. Domain vocabulary: if a term belongs to a specialized field (medicine, law, military, etc.), classify it under the matching domain.* category even if it has loose visual associations.
8. Specific camera models, lenses, and photography equipment (Canon EOS, Fujifilm FinePix, Nikon D-series, Leica M, Hasselblad, Vivitar, Casio Exilim, etc.) -> reference.technique. Modality: visual. These inform rendering style via sensor characteristics and lens rendering.

HARMONIC DIMENSIONS (assign a numeric value 0.0-1.0 for each):
- hardness: 0.0 = ethereal/gaseous, 0.2 = soft (flowing, draped, rounded, gentle), 0.5 = balanced, 0.8 = rigid (angular, sharp, geometric), 1.0 = immovable
- temperature: 0.0 = arctic (deep blues, ice), 0.2 = cool (blues, greens, silver, steel, moonlight), 0.5 = neutral, 0.8 = warm (reds, oranges, golden, amber, earth tones), 1.0 = scorching
- weight: 0.0 = weightless, 0.2 = light (thin, sheer, delicate, ethereal, transparent), 0.5 = balanced, 0.8 = heavy (dense, thick, substantial, layered, opaque), 1.0 = crushing
- formality: 0.0 = chaotic, 0.2 = organic (natural, irregular, weathered, handmade), 0.5 = balanced, 0.8 = structured (geometric, precise, manufactured, engineered), 1.0 = rigid grid
- era_affinity: 0.0 = primordial, 0.25 = ancient, 0.4 = pre-industrial, 0.5 = timeless (era-independent), 0.65 = industrial (1880s-1960s, machine age), 0.85 = modern (contemporary, digital), 1.0 = futuristic

CRITICAL: 0.5 is NOT a default. It means genuinely balanced or era-independent. Most terms lean toward one pole. Use the full range. Commit to their tendency.

UTILITY (assign one):
- "visual": describes something renderable (color, shape, texture, lighting, composition, material, style, clothing, feature)
- "literary": abstract concept, technical jargon, or narrative device with no direct visual form
- "dual": has both visual and conceptual applications (mood, era, archetype, named reference, location)

EXAMPLES:
- "gothic architecture" -> style.genre, mod: both
- "renaissance architecture" -> style.genre, mod: both
- "elegant" -> narrative.mood, mod: both
- "smiling" -> subject.expression, mod: visual
- "engawa" -> environment.prop, mod: both
- "tatami" -> environment.prop, mod: both
- "Meiji period" -> style.era, mod: both
- "structure" -> negative.filter, mod: visual
- "rain-slicked highway reflecting sodium vapor lights" -> narrative.scene, mod: both
- "great crested grebe" -> subject.animal, mod: both
- "Roger Deakins" -> reference.person, mod: both
- "reagent" -> domain.chemistry, mod: narrative
- "triage" -> domain.medicine, mod: narrative
- "starboard" -> domain.maritime, mod: narrative
- "betrayal" -> narrative.concept, mod: narrative
- "pursue" -> narrative.action, mod: narrative
- "the detective" -> narrative.archetype, mod: narrative
- "fog creeping through broken stained glass" -> narrative.phrase, mod: narrative
- "sigil" -> domain.occult, mod: narrative
- "julienne" -> domain.cuisine, mod: narrative

Think about what creative domain this term lives in. Commit to its tendency even if weak.`
}

// --- Types ---

export interface AtomClassification {
  category_slug: string
  modality: string
  utility: string
  harmonics: Record<string, number>
}

/**
 * Sanitize Gemini JSON responses that contain control characters
 * inside string literals. Gemini sporadically inserts literal
 * newlines/tabs inside JSON string values, breaking JSON.parse.
 * Also strips markdown fences and repairs truncated objects.
 */
export function sanitizeGeminiJson(raw: string): string {
  let cleaned = raw.trim()

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  // Extract JSON object if Gemini wrapped it in text explanation
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    }
  }

  // Repair truncation: if response doesn't end with }, find last complete object
  if (!cleaned.trimEnd().endsWith('}')) {
    const lastBrace = cleaned.lastIndexOf('}')
    if (lastBrace > 0) {
      console.log(`[classify] Truncated response detected, repairing at position ${lastBrace}`)
      cleaned = cleaned.slice(0, lastBrace + 1)
    }
  }

  // Remove control characters inside string literals
  let inString = false
  let escaped = false
  let result = ''

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]
    const code = cleaned.charCodeAt(i)

    if (escaped) {
      result += char
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      result += char
      continue
    }

    if (char === '"') {
      inString = !inString
      result += char
      continue
    }

    if (inString && code < 0x20) {
      result += ' '
      continue
    }

    result += char
  }

  return result
}

/**
 * Parse and validate a classification response from any provider.
 * Validates against DB-sourced category set instead of hardcoded constants.
 */
function parseClassification(raw: string, validation: CategoryValidation): AtomClassification | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(sanitizeGeminiJson(raw))
  } catch {
    return null
  }

  // Accept both short keys (cat/mod/h/util) and long keys (category_slug/modality/harmonic_profile/utility)
  const cat = (parsed.cat ?? parsed.category_slug ?? parsed.category) as string | undefined
  const mod = (parsed.mod ?? parsed.modality) as string | undefined
  const util = (parsed.util ?? parsed.utility) as string | undefined
  const h = (parsed.h ?? parsed.harmonic_profile ?? parsed.harmonics) as Record<string, unknown> | undefined

  // Validate category against DB set
  if (!cat || !validation.slugs.has(cat)) return null

  // Validate modality: explicit from model, then fallback to DB default
  let modality = 'visual'
  if (mod && (VALID_MODALITIES as readonly string[]).includes(mod)) {
    modality = mod
  } else {
    modality = validation.modalityMap.get(cat) ?? 'both'
  }

  // Validate and normalize harmonics
  if (!h || typeof h !== 'object') return null

  const harmonics: Record<string, number> = {}
  for (const dim of HARMONIC_DIMENSIONS) {
    const val = Number(h[dim])
    if (!isNaN(val)) {
      harmonics[dim] = Math.round(Math.min(1.0, Math.max(0.0, val)) * 100) / 100
    } else {
      harmonics[dim] = HARMONIC_DEFAULTS[dim]
    }
  }

  const utility = (VALID_UTILITIES as readonly string[]).includes(util as string)
    ? util as string : 'visual'

  return {
    category_slug: cat,
    modality,
    utility,
    harmonics,
  }
}

/**
 * Extract the curator's semantic context hint from an atom's metadata JSON.
 * Returns undefined if metadata is absent, unparseable, or lacks a context string.
 * Callers that fetch atom rows for classification should read `metadata`
 * and pass the result here to feed classifyAtom's context param.
 */
export function extractMetadataContext(
  metadataJson: string | null | undefined,
): string | undefined {
  if (!metadataJson) return undefined
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>
    return typeof parsed?.context === 'string' ? parsed.context : undefined
  } catch {
    return undefined
  }
}

/**
 * Classify a single atom. Uses callWithFallback to iterate through the
 * provider chain. Parse failure throws to trigger the next provider.
 * Categories are fetched from DB by the caller and passed in.
 *
 * `context` is an optional curator-asserted disambiguation hint (from
 * atoms.metadata.context). When present, the classifier sees both the atom
 * text and the hint, which resolves polysemy that bare text cannot.
 * Body-mass pilot observed 12.5% success without context, projected ~90% with.
 */
export async function classifyAtom(
  text_lower: string,
  ctx: ModelContext,
  categories: CategoryMetadata[],
  context?: string,
): Promise<AtomClassification | null> {
  const validation = buildCategoryValidation(categories)
  const classificationPrompt = buildClassificationPrompt(categories)

  const contextLine = context ? `\n- context: "${context.replace(/"/g, '\\"')}"` : ''
  const prompt = classificationPrompt + `

Classify this single atom:
- text: "${text_lower}"${contextLine}

Respond with ONLY a JSON object (not array):
{"cat":"category_slug","mod":"visual|narrative|both","util":"visual","h":{"hardness":0.0,"temperature":0.0,"weight":0.0,"formality":0.0,"era_affinity":0.0}}`

  try {
    const { result: raw } = await callWithFallback(ctx, 'classify', prompt)
    const classification = parseClassification(raw, validation)
    if (classification) return classification

    // Parse failed on primary; retry once (Gemini is non-deterministic)
    console.log(`[classify] Parse failed for "${text_lower.slice(0, 40)}", retrying`)
    const { result: retryRaw } = await callWithFallback(ctx, 'classify', prompt)
    return parseClassification(retryRaw, validation)
  } catch {
    return null
  }
}

// -- Register Dimension Classification --

const REGISTER_PROMPT = `You are scoring a creative vocabulary atom on the "register" dimension: a continuous scale from ethereal (0.0) to visceral (1.0).

SCALE ANCHORS:
- 0.0-0.2 ETHEREAL: angelic wings, celestial glow, ethereal mist, gossamer, divine light, spectral shimmer
- 0.2-0.4 DELICATE: soft focus, dreamy, pastel haze, morning dew, whisper, translucent
- 0.4-0.6 NEUTRAL: most technical/equipment atoms, generic poses, standard lighting setups, compositional rules
- 0.6-0.8 GROUNDED: weathered leather, rust, concrete, gritty, industrial steel, calloused hands, worn denim
- 0.8-1.0 VISCERAL: human skull, viscera, raw meat, decay, exposed bone, blood, putrefaction, carrion

RULES:
1. Score based on the sensory/physical intensity the term evokes, not its literal meaning.
2. Abstract or technical terms with no ethereal/visceral lean score 0.5.
3. Camera gear, lens names, composition rules: score 0.5.
4. Natural elements score based on their feel: "morning mist" ~0.2, "mudslide" ~0.7.
5. Clothing/materials: "silk chiffon" ~0.25, "cracked leather" ~0.7.
6. Domain vocabulary: score based on the visceral weight of the domain (medicine ~0.65, folklore ~0.35, military ~0.7).

Return ONLY a JSON object: {"register": <float 0.0-1.0>}`

export type RegisterResult = { register: number } | { error: string }

/**
 * Classify a single atom's register dimension.
 * Returns { register: float } on success, { error: string } on failure.
 */
export async function classifyRegister(
  text_lower: string,
  category_slug: string,
  ctx: ModelContext
): Promise<RegisterResult> {
  const prompt = REGISTER_PROMPT + `

Atom: "${text_lower}"
Category: ${category_slug}`

  try {
    const { result: raw } = await callWithFallback(ctx, 'classify.register', prompt)
    const parsed = JSON.parse(sanitizeGeminiJson(raw))
    const val = Number(parsed.register)
    if (isNaN(val)) return { error: 'nan_value' }
    return { register: Math.max(0.0, Math.min(1.0, Math.round(val * 100) / 100)) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'all_providers_failed' }
  }
}

// -- Batch Classification --

/**
 * Classify a batch of unclassified atoms. Fetches atoms with NULL or empty
 * category_slug, classifies in concurrent pairs with 1s delay between chunks.
 * Used by both the cron handler and the /admin/classify-batch REST endpoint.
 */
export async function classifyBatchProcess(
  db: D1Database,
  ctx: ModelContext,
  opts: { limit: number }
): Promise<{ classified: number; failed: number; geminiCalls: number }> {
  const categories = await getCategoryMetadata(db)

  const { results } = await db.prepare(
    "SELECT id, text_lower, collection_slug, metadata FROM atoms WHERE (category_slug IS NULL OR category_slug = '') LIMIT ?"
  ).bind(opts.limit).all()

  if (results.length === 0) return { classified: 0, failed: 0, geminiCalls: 0 }

  let classified = 0
  let failed = 0
  let geminiCalls = 0

  for (let i = 0; i < results.length; i += 2) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000))
    const chunk = results.slice(i, i + 2)
    geminiCalls += chunk.length * 2

    const settled = await Promise.allSettled(
      chunk.map(async (atom) => {
        const context = extractMetadataContext(atom.metadata as string | null)
        const classification = await classifyAtom(atom.text_lower as string, ctx, categories, context)
        if (!classification) return false
        await db.prepare(
          'UPDATE atoms SET category_slug = ?, harmonics = ?, modality = ?, utility = ? WHERE id = ?'
        ).bind(classification.category_slug, JSON.stringify(classification.harmonics), classification.modality, classification.utility, atom.id).run()
        return true
      })
    )

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) classified++
      else failed++
    }
  }

  return { classified, failed, geminiCalls }
}
