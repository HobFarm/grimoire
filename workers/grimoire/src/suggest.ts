import type { Env, AtomRow, AtomObservation, DiscoverResponse, DiscoverRejection, DecomposeResponse } from './types'
import { VALID_CATEGORIES, VALID_HARMONICS, HARMONIC_DEFAULTS, VALID_MODALITIES, CATEGORY_MODALITY } from './constants'
import { fetchGeminiText, tryParseJson } from './gemini'
import { findAtomByText, encounterAtom, createAtom } from './atoms'
import { CLASSIFICATION_PROMPT } from './atom-classify'
import { collectionFromCategory, isGenericTerm } from './taxonomy'

// --- Discover ---

interface GeminiDiscoverSuccess {
  cat: string
  mod: string
  obs: string
  confidence: number
  reasoning: string
  h: Record<string, string>
}

interface GeminiDiscoverRejection {
  rejected: true
}

type GeminiDiscoverResult = GeminiDiscoverSuccess | GeminiDiscoverRejection

function isRejection(r: GeminiDiscoverResult): r is GeminiDiscoverRejection {
  return 'rejected' in r && (r as GeminiDiscoverRejection).rejected === true
}

function validateDiscoverShape(parsed: unknown): GeminiDiscoverResult | null {
  const obj = parsed as Record<string, unknown>
  // Check for rejection response
  if (obj.rejected === true) {
    return { rejected: true }
  }
  // Validate success shape
  if (typeof obj.cat !== 'string') return null
  if (typeof obj.confidence !== 'number') return null
  const mod = typeof obj.mod === 'string' ? obj.mod : 'visual'
  const obs = obj.obs === 'interpretation' ? 'interpretation' : 'observation'
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : ''
  const h = (obj.h && typeof obj.h === 'object') ? obj.h as Record<string, string> : {}
  return { cat: obj.cat, mod, obs, confidence: obj.confidence, reasoning, h }
}

function buildDiscoverPrompt(text: string): string {
  return CLASSIFICATION_PROMPT + `

If the term is a single generic adjective with no specific visual meaning
(e.g. "prominent", "beautiful", "large", "nice"), respond with {"rejected":true}.

Classify this new term:
- text: "${text}"

Respond with ONLY a JSON object:
{"cat":"category_slug","mod":"visual|narrative|both","obs":"observation|interpretation","confidence":0.0,"reasoning":"brief explanation","h":{"hardness":"...","temperature":"...","weight":"...","formality":"...","era_affinity":"..."}}`
}

export async function discoverAtom(
  env: Env,
  text: string,
  sourceApp?: string
): Promise<DiscoverResponse | DiscoverRejection> {
  // Pre-filter: reject bare generic adjectives without burning a Gemini call
  if (isGenericTerm(text)) {
    return { rejected: true, term: text, reason: 'generic_term' }
  }

  // Check for existing atom
  const existing = await findAtomByText(env.DB, text)
  if (existing) {
    const updated = await encounterAtom(env.DB, existing.id)
    const atom = updated ?? existing
    return {
      atom,
      classification: {
        collection_slug: atom.collection_slug,
        observation: atom.observation,
        confidence: atom.confidence,
        reasoning: 'Existing atom, encounter count incremented.',
        is_new: false,
      },
    }
  }

  // New term: classify with Gemini (category + harmonics + modality in one call)
  const prompt = buildDiscoverPrompt(text)
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash'

  const rawText = await fetchGeminiText(env, model, prompt, 0.3)
  let result = tryParseJson<GeminiDiscoverResult>(rawText, validateDiscoverShape)

  // Retry once on parse failure
  if (!result) {
    const stricterPrompt =
      prompt +
      '\n\nIMPORTANT: Respond with a JSON object only. No markdown, no explanation, no code fences. The response must be parseable by JSON.parse().'
    const retryText = await fetchGeminiText(env, model, stricterPrompt, 0.3)
    result = tryParseJson<GeminiDiscoverResult>(retryText, validateDiscoverShape)
  }

  if (!result) {
    throw new Error('Gemini returned unparseable classification after retry')
  }

  // Handle Gemini rejection
  if (isRejection(result)) {
    return { rejected: true, term: text, reason: 'gemini_rejected' }
  }

  // Validate category_slug
  if (!(VALID_CATEGORIES as readonly string[]).includes(result.cat)) {
    console.log(`[discover] Unknown category_slug from Gemini: "${result.cat}" for term "${text}"`)
  }

  // Derive collection_slug from canonical lookup
  const collection_slug = collectionFromCategory(result.cat)

  // Validate modality
  let modality = 'visual'
  if ((VALID_MODALITIES as readonly string[]).includes(result.mod)) {
    modality = result.mod
  } else if (result.cat in CATEGORY_MODALITY) {
    modality = CATEGORY_MODALITY[result.cat]
  }

  // Validate and normalize harmonics
  const harmonics: Record<string, string> = {}
  for (const [dim, validValues] of Object.entries(VALID_HARMONICS)) {
    const val = result.h[dim]
    if (typeof val === 'string' && (validValues as readonly string[]).includes(val)) {
      harmonics[dim] = val
    } else {
      harmonics[dim] = HARMONIC_DEFAULTS[dim]
    }
  }

  const observation: AtomObservation = result.obs === 'interpretation' ? 'interpretation' : 'observation'

  // Write new atom with full enrichment (category, harmonics, modality)
  const atom = await createAtom(env.DB, {
    text,
    collection_slug,
    observation,
    confidence: result.confidence,
    source: 'ai',
    source_app: sourceApp,
    status: sourceApp === 'seed' ? 'confirmed' : undefined,
    category_slug: result.cat,
    harmonics: JSON.stringify(harmonics),
    modality,
  })

  return {
    atom,
    classification: {
      collection_slug,
      observation,
      confidence: result.confidence,
      reasoning: result.reasoning,
      is_new: true,
    },
  }
}

// --- Decompose ---

interface GeminiDecomposeResult {
  description: string
  atoms: Array<{
    text: string
    category_slug: string
    observation: AtomObservation
  }>
  missing_categories: string[]
}

function validateDecomposeShape(parsed: unknown): GeminiDecomposeResult | null {
  const obj = parsed as Record<string, unknown>
  if (typeof obj.description !== 'string') return null
  if (!Array.isArray(obj.atoms)) return null
  return {
    description: obj.description,
    atoms: (obj.atoms as Array<Record<string, unknown>>).map(a => ({
      text: String(a.text ?? ''),
      category_slug: String(a.category_slug ?? ''),
      observation: a.observation === 'interpretation' ? 'interpretation' as const : 'observation' as const,
    })),
    missing_categories: Array.isArray(obj.missing_categories)
      ? (obj.missing_categories as string[])
      : [],
  }
}

function buildDecomposePrompt(concept: string): string {
  const categoryList = (VALID_CATEGORIES as readonly string[]).join(', ')

  return `You are a visual vocabulary decomposer for an AI image generation system.

Given a concept (which may be a character archetype, object, setting, or any creative reference), do the following:

1. Identify what this concept is using your training knowledge
2. Decompose it into discrete visual description atoms: specific things a viewer would SEE in an image of this concept
3. Classify each atom into the most specific available category

Rules for atoms:
- Each atom is 1-4 words describing a single visual element
- Observation only: describe what is SEEN, not what it means
- Must be reusable in other contexts (not specific to this concept)
- No proper nouns, no character names, no franchise references
- No interpretation words: young, old, happy, sad, mysterious, beautiful, etc.

Available categories:
${categoryList}

Concept: "${concept}"

Return ONLY valid JSON, no markdown fences:
{
  "description": "1-2 sentence explanation of what this concept is",
  "atoms": [
    { "text": "visual term", "category_slug": "subject.form", "observation": "observation" }
  ],
  "missing_categories": ["any category slugs you would need that do not exist in the list above"]
}

Generate 5-15 atoms. Prefer specific visual terms over generic ones. If the concept has clothing, features, lighting, environment, and pose elements, cover all of them.`
}

export async function decomposeAtom(
  env: Env,
  concept: string,
  sourceApp?: string
): Promise<DecomposeResponse> {
  const prompt = buildDecomposePrompt(concept)
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash'

  const rawText = await fetchGeminiText(env, model, prompt, 0.4)
  let result = tryParseJson<GeminiDecomposeResult>(rawText, validateDecomposeShape)

  if (!result) {
    const stricterPrompt =
      prompt +
      '\n\nIMPORTANT: Respond with a JSON object only. No markdown, no explanation, no code fences. The response must be parseable by JSON.parse().'
    const retryText = await fetchGeminiText(env, model, stricterPrompt, 0.4)
    result = tryParseJson<GeminiDecomposeResult>(retryText, validateDecomposeShape)
  }

  if (!result) {
    throw new Error('Gemini returned unparseable decomposition after retry')
  }

  const validCats = new Set(VALID_CATEGORIES as readonly string[])
  const unknownCategories = new Set(result.missing_categories)
  const atomsCreated: AtomRow[] = []
  const atomsExisting: AtomRow[] = []

  for (const rawAtom of result.atoms) {
    if (!rawAtom.text.trim()) continue

    // Validate category_slug and derive collection_slug
    if (!validCats.has(rawAtom.category_slug)) {
      unknownCategories.add(rawAtom.category_slug)
      continue
    }
    const collection_slug = collectionFromCategory(rawAtom.category_slug)

    // Check for existing atom
    const existing = await findAtomByText(env.DB, rawAtom.text)
    if (existing) {
      const updated = await encounterAtom(env.DB, existing.id)
      atomsExisting.push(updated ?? existing)
      continue
    }

    // Create new atom
    try {
      const atom = await createAtom(env.DB, {
        text: rawAtom.text.trim(),
        collection_slug,
        observation: rawAtom.observation,
        source: 'ai',
        source_app: sourceApp,
        status: sourceApp === 'seed' ? 'confirmed' : undefined,
      })
      atomsCreated.push(atom)
    } catch {
      // Duplicate race or FK violation, skip
    }
  }

  return {
    concept,
    description: result.description,
    atoms_created: atomsCreated,
    atoms_existing: atomsExisting,
    collections_needed: Array.from(unknownCategories),
  }
}
