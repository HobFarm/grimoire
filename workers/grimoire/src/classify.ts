import type {
  Env,
  ClassifyRequest,
  ClassifyResponse,
  ResolvedCategory,
  ResolvedContext,
  RelationRow,
  GeminiClassificationResult,
  ClassificationItem,
} from './types'
import { resolveCategories, getContextGuidance, getRelevantRelations, getAllSlugs } from './db'
import { getCachedResults, writeCacheResults } from './cache'
import { fetchGeminiText, tryParseJson } from './gemini'

// --- Prompt Construction ---

export function buildPrompt(
  categories: ResolvedCategory[],
  contexts: ResolvedContext[],
  relations: RelationRow[],
  text: string
): string {
  const categoryBlock = categories
    .map(
      c =>
        `- ${c.slug}: ${c.description}\n  Return shape: ${JSON.stringify(c.output_schema)}`
    )
    .join('\n')

  const contextBlock =
    contexts.length > 0
      ? contexts.map(ctx => `[${ctx.context} / ${ctx.category_slug}]: ${ctx.guidance}`).join('\n')
      : 'No specific aesthetic context. Use default visual classification.'

  const relationsBlock =
    relations.length > 0
      ? '\n\nCATEGORY RELATIONS:\n' +
        relations
          .map(r => `- ${r.source_slug} ${r.relation.toUpperCase()} ${r.target_slug}: ${r.note}`)
          .join('\n')
      : ''

  return `You are a visual classification agent. Given the following text, identify and classify visual elements into the provided categories.

CATEGORIES AVAILABLE:
${categoryBlock}

AESTHETIC CONTEXT:
${contextBlock}${relationsBlock}

RULES:
- Observe, never interpret. Describe what is physically visible.
- Return valid JSON matching the output_schema for each category.
- If a term does not fit any category, include it in "unclassified".
- Each classified item needs a confidence score (0.0 to 1.0).
- Do not invent elements not present in the input text.
- Confidence scoring: 0.9-1.0 when the term unambiguously matches the category and all required fields are populated. 0.7-0.89 when classification is correct but some fields are inferred rather than explicit in the text. Below 0.7 when the match is uncertain or the term only loosely fits the category. Never default to 0.5.
- Always populate array fields (string[]) even if empty. Return [] not undefined.

TEXT TO CLASSIFY:
${text}

Respond with JSON only, no markdown fences, no explanation. Use this exact shape:
{"classifications":[{"category":"slug","result":{...},"confidence":0.0}],"unclassified":[]}`
}

// --- Gemini API ---

function validateClassificationShape(parsed: unknown): GeminiClassificationResult | null {
  const obj = parsed as Record<string, unknown>
  if (!obj.classifications || !Array.isArray(obj.classifications)) return null
  return {
    classifications: obj.classifications as GeminiClassificationResult['classifications'],
    unclassified: Array.isArray(obj.unclassified) ? (obj.unclassified as string[]) : [],
  }
}

/**
 * Call Gemini via AI Gateway. Owns retry logic: if first response is unparseable JSON,
 * retries once with stricter suffix. If retry also fails, throws.
 */
export async function callGemini(env: Env, prompt: string): Promise<GeminiClassificationResult> {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash'

  const rawText = await fetchGeminiText(env, model, prompt)

  // First parse attempt
  const firstTry = tryParseJson<GeminiClassificationResult>(rawText, validateClassificationShape)
  if (firstTry) return firstTry

  // Retry with stricter prompt
  const stricterPrompt = prompt + '\n\nIMPORTANT: Respond with a JSON object only. No markdown, no explanation, no code fences. The response must be parseable by JSON.parse().'
  const retryText = await fetchGeminiText(env, model, stricterPrompt)
  const secondTry = tryParseJson<GeminiClassificationResult>(retryText, validateClassificationShape)
  if (secondTry) return secondTry

  throw new Error(`Gemini returned unparseable JSON after retry. Raw: ${retryText.slice(0, 200)}`)
}

// --- Schema Validation ---

/**
 * Validate a single field value against the mini-DSL schema type.
 * Returns null if valid, error string if invalid.
 */
export function validateField(
  key: string,
  value: unknown,
  schemaType: string
): string | null {
  const isOptional = schemaType.endsWith('?')
  const cleanType = isOptional ? schemaType.slice(0, -1) : schemaType

  // Optional and absent/null: valid
  if (value === undefined || value === null) {
    return isOptional ? null : `Missing required field: ${key}`
  }

  if (cleanType === 'string') {
    if (typeof value !== 'string' || value.length === 0) {
      return `${key}: expected non-empty string, got ${typeof value}`
    }
    return null
  }

  if (cleanType === 'string[]') {
    if (!Array.isArray(value)) {
      return `${key}: expected string array, got ${typeof value}`
    }
    return null
  }

  // Enum: "value1|value2|value3"
  if (cleanType.includes('|')) {
    if (typeof value !== 'string') {
      return `${key}: expected string (enum), got ${typeof value}`
    }
    // Soft-fail: warn but don't reject if value is a string not in the enum
    // The AI might use valid synonyms or novel values
    return null
  }

  return null
}

/**
 * Validate a classification result against a category's output_schema.
 * Returns list of errors (empty = valid).
 */
export function validateResult(
  result: Record<string, unknown>,
  schema: Record<string, string>
): string[] {
  const errors: string[] = []

  for (const [key, schemaType] of Object.entries(schema)) {
    // Normalize missing string[] fields to empty arrays
    const baseType = schemaType.endsWith('?') ? schemaType.slice(0, -1) : schemaType
    if (baseType === 'string[]' && (result[key] === undefined || result[key] === null)) {
      result[key] = []
    }

    const error = validateField(key, result[key], schemaType)
    if (error) errors.push(error)
  }

  return errors
}

/**
 * Parse Gemini response and validate each classification against its category schema.
 * Returns validated classifications and unclassified terms.
 */
export function parseAndValidate(
  geminiResult: GeminiClassificationResult,
  categories: ResolvedCategory[]
): {
  valid: Array<{ category: string; result: Record<string, unknown>; confidence: number }>
  invalid: Array<{ category: string; errors: string[] }>
  unclassified: string[]
} {
  const categoryMap = new Map(categories.map(c => [c.slug, c]))
  const valid: Array<{ category: string; result: Record<string, unknown>; confidence: number }> = []
  const invalid: Array<{ category: string; errors: string[] }> = []
  const unclassified = [...geminiResult.unclassified]

  for (const item of geminiResult.classifications) {
    const cat = categoryMap.get(item.category)

    // Entry doesn't match a known category: goes to unclassified
    if (!cat) {
      if (item.result?.term && typeof item.result.term === 'string') {
        unclassified.push(item.result.term)
      }
      continue
    }

    const errors = validateResult(item.result, cat.output_schema)
    if (errors.length > 0) {
      console.warn(`Validation errors for ${item.category}:`, errors)
      invalid.push({ category: item.category, errors })
      // Still include partially valid results with the data we got
      valid.push({
        category: item.category,
        result: item.result,
        confidence: Math.min(item.confidence, 0.5), // Penalize confidence for validation issues
      })
    } else {
      valid.push({
        category: item.category,
        result: item.result,
        confidence: item.confidence,
      })
    }
  }

  return { valid, invalid, unclassified }
}

// --- Main Classification Orchestrator ---

export class ClassifyError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown
  ) {
    super(message)
  }
}

/**
 * Full classification flow (micro-FFE pattern).
 * INGEST -> MEDIATE -> EXECUTE -> VALIDATE -> DELIVER
 */
export async function classifyText(
  env: Env,
  request: ClassifyRequest
): Promise<ClassifyResponse> {
  // --- INGEST ---
  if (!request.text || request.text.trim().length === 0) {
    throw new ClassifyError('text is required', 400)
  }
  if (!request.categories || request.categories.length === 0) {
    throw new ClassifyError('categories array is required', 400)
  }

  const categories = await resolveCategories(env.DB, request.categories)
  if (categories.length === 0) {
    const validSlugs = await getAllSlugs(env.DB)
    throw new ClassifyError('No categories matched the provided patterns', 400, {
      valid_slugs: validSlugs,
    })
  }

  const contexts = request.contexts ?? []
  const maxResults = request.max_results ?? 10

  // --- MEDIATE ---
  const categorySlugs = categories.map(c => c.slug)
  const contextGuidance = await getContextGuidance(env.DB, categorySlugs, contexts)
  const relations = await getRelevantRelations(env.DB, categorySlugs)
  const contextUsed = [...new Set(contextGuidance.map(c => c.context))]

  // --- EXECUTE ---
  const cached = await getCachedResults(env.DB, request.text, categorySlugs, contexts)
  const uncachedCategories = categories.filter(c => !cached.has(c.slug))

  // All categories cached with acceptable confidence: return immediately
  if (uncachedCategories.length === 0) {
    const classifications: ClassificationItem[] = []
    for (const [slug, hit] of cached) {
      classifications.push({
        category: slug,
        result: hit.result,
        confidence: hit.confidence,
        cached: true,
      })
    }
    return {
      classifications: classifications.slice(0, maxResults),
      unclassified: [],
      context_used: contextUsed,
    }
  }

  // Build prompt for uncached categories only
  const prompt = buildPrompt(uncachedCategories, contextGuidance, relations, request.text)

  let geminiResult: GeminiClassificationResult
  try {
    geminiResult = await callGemini(env, prompt)
  } catch (error) {
    // Gemini failed: serve whatever cache we have
    if (cached.size > 0) {
      const classifications: ClassificationItem[] = []
      for (const [slug, hit] of cached) {
        classifications.push({
          category: slug,
          result: hit.result,
          confidence: hit.confidence,
          cached: true,
        })
      }
      return {
        classifications: classifications.slice(0, maxResults),
        unclassified: [],
        context_used: contextUsed,
      }
    }

    // No cache at all: propagate error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ClassifyError('Classification timed out', 503)
    }
    throw new ClassifyError(
      `Gemini API error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      502
    )
  }

  // --- VALIDATE ---
  const { valid, unclassified } = parseAndValidate(geminiResult, uncachedCategories)

  // --- DELIVER ---
  // Write valid results to cache (only entries matching known categories)
  await writeCacheResults(env.DB, request.text, contexts, valid)

  // Merge cached + fresh results
  const classifications: ClassificationItem[] = []

  for (const [slug, hit] of cached) {
    classifications.push({
      category: slug,
      result: hit.result,
      confidence: hit.confidence,
      cached: true,
    })
  }

  for (const entry of valid) {
    classifications.push({
      category: entry.category,
      result: entry.result,
      confidence: entry.confidence,
      cached: false,
    })
  }

  // Sort by confidence descending, then cap at max_results
  classifications.sort((a, b) => b.confidence - a.confidence)

  return {
    classifications: classifications.slice(0, maxResults),
    unclassified,
    context_used: contextUsed,
  }
}
