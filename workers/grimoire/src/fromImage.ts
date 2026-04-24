// fromImage adapter: vision model extraction of atoms/correspondences from images.
// Hono sub-app mounted at /image in index.ts.
// Extraction endpoints here; review endpoints in fromImage-review.ts.

import { Hono } from 'hono'
import type { Env, CandidateAtom, CandidateCorrespondence } from './types'
import { buildModelContext } from './models'
import { callVisionWithFallback } from './vision-provider'
import { buildImageExtractionPrompt, IMAGE_EXTRACTION_PROMPT_VERSION } from './prompts/image-extraction'
import { tryParseJson } from './gemini'
import {
  deriveAnalysisKey,
  deriveAnalysisKeyFromR2Key,
  storeAnalysisJson,
  arrayBufferToBase64,
  isImageKey,
  mimeTypeFromKey,
  type AnalysisDocument,
} from './r2-analysis'
import { reviewApp } from './fromImage-review'

// --- Constants ---

const IMAGE_FETCH_TIMEOUT_MS = 10_000
const IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 10MB
const VALID_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const ATOM_SAMPLE_SIZE = 50
const BATCH_MAX_LIMIT = 25
const BATCH_DEFAULT_LIMIT = 10

// --- Image resolution ---

async function fetchAndValidateImage(url: string): Promise<{ base64: string; mimeType: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Grimoire-ImageExtractor/1.0' },
    })

    if (!response.ok) {
      throw new Error(`Image fetch failed: HTTP ${response.status} ${response.statusText}`)
    }

    const contentType = (response.headers.get('Content-Type') ?? '').split(';')[0].trim()
    if (!VALID_IMAGE_TYPES.includes(contentType)) {
      throw new Error(`Expected image Content-Type (${VALID_IMAGE_TYPES.join(', ')}), got "${contentType}"`)
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > IMAGE_MAX_BYTES) {
      throw new Error(`Image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024}MB limit (got ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`)
    }

    return { base64: arrayBufferToBase64(buffer), mimeType: contentType }
  } finally {
    clearTimeout(timeoutId)
  }
}

// --- JSON extraction helpers ---

interface ExtractionPayload {
  source_attribution: string
  artist_attribution: string | null
  candidate_atoms: CandidateAtom[]
  candidate_correspondences: CandidateCorrespondence[]
}

function validateExtractionPayload(parsed: unknown): ExtractionPayload | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  if (!Array.isArray(obj.candidate_atoms)) return null

  return {
    source_attribution: typeof obj.source_attribution === 'string' ? obj.source_attribution : '',
    artist_attribution: typeof obj.artist_attribution === 'string' ? obj.artist_attribution : null,
    candidate_atoms: (obj.candidate_atoms as unknown[]).filter(isValidCandidateAtom),
    candidate_correspondences: Array.isArray(obj.candidate_correspondences)
      ? (obj.candidate_correspondences as unknown[]).filter(isValidCandidateCorrespondence)
      : [],
  }
}

function isValidCandidateAtom(item: unknown): item is CandidateAtom {
  if (typeof item !== 'object' || item === null) return false
  const a = item as Record<string, unknown>
  return typeof a.name === 'string' && a.name.length > 0
    && typeof a.description === 'string'
    && typeof a.suggested_category === 'string'
    && typeof a.confidence === 'number'
}

function isValidCandidateCorrespondence(item: unknown): item is CandidateCorrespondence {
  if (typeof item !== 'object' || item === null) return false
  const c = item as Record<string, unknown>
  return typeof c.source_name === 'string'
    && typeof c.target_name === 'string'
    && typeof c.relationship === 'string'
    && typeof c.suggested_strength === 'number'
}

// --- Core extraction logic ---

interface ExtractionInput {
  imageData: { base64: string; mimeType: string }
  sourceUrl: string
  attribution?: string
  moodboardId?: string
  env: Env
}

interface ExtractionOutput {
  payload: ExtractionPayload
  rawResult: string
  callMeta: { model: string; provider: string; durationMs: number }
  candidateIds: number[]
  analysisKey?: string
}

async function runExtraction(input: ExtractionInput): Promise<ExtractionOutput> {
  const { imageData, sourceUrl, attribution, moodboardId, env } = input

  // Load categories and sample atom names from D1
  const [categoriesResult, atomsResult] = await Promise.all([
    env.DB.prepare('SELECT slug, label FROM categories ORDER BY slug').all<{ slug: string; label: string }>(),
    env.DB.prepare(
      `SELECT text FROM atoms WHERE status = 'confirmed' ORDER BY RANDOM() LIMIT ?`
    ).bind(ATOM_SAMPLE_SIZE).all<{ text: string }>(),
  ])

  const categories = categoriesResult.results ?? []
  const sampleAtomNames = (atomsResult.results ?? []).map(r => r.text)

  // Build prompt and call vision model
  const prompt = buildImageExtractionPrompt(categories, sampleAtomNames)
  const ctx = await buildModelContext(env)

  let callResult = await callVisionWithFallback(ctx, 'image.extract', prompt, imageData)
  let rawResult = callResult.result
  console.log(`[fromImage] vision call success: provider=${callResult.provider} model=${callResult.model} (${callResult.durationMs}ms)`)

  // Parse response (with retry on failure)
  let payload = tryParseJson<ExtractionPayload>(rawResult, validateExtractionPayload)

  if (!payload) {
    console.log('[fromImage] JSON parse failed, retrying with stricter prompt')
    try {
      const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY valid JSON. No markdown fences, no explanatory text. Start with { and end with }.'
      const retryResult = await callVisionWithFallback(ctx, 'image.extract', retryPrompt, imageData)
      rawResult = retryResult.result
      callResult = retryResult
      payload = tryParseJson<ExtractionPayload>(rawResult, validateExtractionPayload)
    } catch {
      // Use raw result from first attempt for debugging
    }
  }

  if (!payload) {
    throw new ExtractionParseError(rawResult)
  }

  // Validate category slugs
  const validSlugs = new Set(categories.map(c => c.slug))
  for (const atom of payload.candidate_atoms) {
    if (!validSlugs.has(atom.suggested_category)) {
      atom.suggested_category = 'uncategorized'
    }
    if (!['directive', 'modifier', 'descriptor'].includes(atom.utility)) {
      atom.utility = 'descriptor'
    }
    if (!['visual', 'narrative', 'both'].includes(atom.modality)) {
      atom.modality = 'visual'
    }
    atom.confidence = Math.max(0, Math.min(1, atom.confidence))
  }
  for (const corr of payload.candidate_correspondences) {
    corr.suggested_strength = Math.max(0, Math.min(1, corr.suggested_strength))
  }

  // Store candidates in D1
  const candidateIds: number[] = []
  const stmts: D1PreparedStatement[] = []

  for (const atom of payload.candidate_atoms) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO image_extraction_candidates (source_url, source_attribution, candidate_type, candidate_data, moodboard_id)
         VALUES (?, ?, 'atom', ?, ?)`
      ).bind(sourceUrl, payload.source_attribution || attribution || null, JSON.stringify(atom), moodboardId ?? null)
    )
  }
  for (const corr of payload.candidate_correspondences) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO image_extraction_candidates (source_url, source_attribution, candidate_type, candidate_data, moodboard_id)
         VALUES (?, ?, 'correspondence', ?, ?)`
      ).bind(sourceUrl, payload.source_attribution || attribution || null, JSON.stringify(corr), moodboardId ?? null)
    )
  }

  if (stmts.length > 0) {
    const results = await env.DB.batch(stmts)
    for (const r of results) {
      if (r.meta.last_row_id) candidateIds.push(r.meta.last_row_id)
    }
  }

  // Store analysis JSON in R2 (best-effort)
  const callMeta = { model: callResult.model, provider: callResult.provider, durationMs: callResult.durationMs }
  let analysisKey: string | undefined

  if (env.GRIMOIRE_R2) {
    try {
      analysisKey = await deriveAnalysisKey(sourceUrl)
      const doc: AnalysisDocument = {
        source_url: sourceUrl,
        source_attribution: payload.source_attribution,
        artist_attribution: payload.artist_attribution,
        candidate_atoms: payload.candidate_atoms,
        candidate_correspondences: payload.candidate_correspondences,
        raw_analysis: rawResult,
        extraction_metadata: {
          model: callMeta.model,
          provider: callMeta.provider,
          timestamp: new Date().toISOString(),
          prompt_version: IMAGE_EXTRACTION_PROMPT_VERSION,
          duration_ms: callMeta.durationMs,
          estimated_input_tokens: Math.ceil(prompt.length / 4) + 1000,
          estimated_output_tokens: Math.ceil(rawResult.length / 4),
        },
      }
      await storeAnalysisJson(env.GRIMOIRE_R2, analysisKey, doc)
      console.log(`[fromImage] analysis stored: ${analysisKey}`)
    } catch (err) {
      console.log(`[fromImage] R2 analysis write failed (non-fatal): ${(err as Error).message}`)
      analysisKey = undefined
    }
  }

  return { payload, rawResult, callMeta, candidateIds, analysisKey }
}

class ExtractionParseError extends Error {
  rawAnalysis: string
  constructor(rawAnalysis: string) {
    super('Vision model returned invalid JSON')
    this.rawAnalysis = rawAnalysis
  }
}

// --- Hono sub-app ---

export const imageApp = new Hono<{ Bindings: Env }>()

// POST /extract - Run vision extraction on an image URL
imageApp.post('/extract', async (c) => {
  const body = await c.req.json<{ image_url?: string; attribution?: string }>()
  if (!body.image_url) {
    return c.json({ error: 'image_url is required' }, 400)
  }

  let imageData: { base64: string; mimeType: string }
  try {
    imageData = await fetchAndValidateImage(body.image_url)
  } catch (err) {
    return c.json({ error: 'image_fetch_failed', message: (err as Error).message }, 400)
  }

  console.log(`[fromImage] image resolved: ${imageData.mimeType}, ${Math.round(imageData.base64.length * 0.75 / 1024)}KB`)

  let result: ExtractionOutput
  try {
    result = await runExtraction({ imageData, sourceUrl: body.image_url, attribution: body.attribution, env: c.env })
  } catch (err) {
    if (err instanceof ExtractionParseError) {
      return c.json({ error: 'parse_failed', message: err.message, raw_analysis: err.rawAnalysis.slice(0, 2000) }, 422)
    }
    return c.json({ error: 'vision_model_failed', message: (err as Error).message }, 502)
  }

  return c.json({
    source_url: body.image_url,
    source_attribution: result.payload.source_attribution,
    artist_attribution: result.payload.artist_attribution,
    candidate_atoms: result.payload.candidate_atoms.length,
    candidate_correspondences: result.payload.candidate_correspondences.length,
    candidate_ids: result.candidateIds,
    analysis_key: result.analysisKey ?? null,
    candidates: {
      atoms: result.payload.candidate_atoms,
      correspondences: result.payload.candidate_correspondences,
    },
    raw_analysis: result.rawResult,
  })
})

// POST /extract/batch - Batch extraction from R2 prefix
imageApp.post('/extract/batch', async (c) => {
  if (!c.env.GRIMOIRE_R2) {
    return c.json({ error: 'GRIMOIRE_R2 binding not available' }, 500)
  }

  const body = await c.req.json<{ prefix?: string; limit?: number; moodboard_id?: string }>()
  if (!body.prefix) {
    return c.json({ error: 'prefix is required' }, 400)
  }

  const limit = Math.min(Math.max(1, body.limit ?? BATCH_DEFAULT_LIMIT), BATCH_MAX_LIMIT)

  // List all objects under the prefix
  const listed = await c.env.GRIMOIRE_R2.list({ prefix: body.prefix, limit: 1000 })
  const imageKeys = listed.objects.filter(obj => isImageKey(obj.key)).map(obj => obj.key)

  // Check which already have analysis (batch HEAD checks)
  const analysisChecks = await Promise.all(
    imageKeys.map(async (key) => {
      const analysisKey = deriveAnalysisKeyFromR2Key(key)
      const exists = await c.env.GRIMOIRE_R2!.head(analysisKey)
      return { key, analysisKey, exists: !!exists }
    })
  )

  const toProcess = analysisChecks.filter(c => !c.exists)
  const skipped = analysisChecks.filter(c => c.exists).length
  const batch = toProcess.slice(0, limit)

  // When moodboard_id is present, rehydrate D1 candidate rows for images that have an R2
  // analysis JSON but no matching candidates for this moodboard_id. Makes the batch truly
  // idempotent across partial-failure retries and D1-cleanup re-runs.
  let rehydrated = 0
  if (body.moodboard_id) {
    const skippedKeys = analysisChecks.filter(c => c.exists)
    for (const item of skippedKeys) {
      const sourceUrl = `https://ref.hob.farm/${item.key}`
      const existing = await c.env.DB
        .prepare('SELECT 1 FROM image_extraction_candidates WHERE source_url = ? AND moodboard_id = ? LIMIT 1')
        .bind(sourceUrl, body.moodboard_id)
        .first()
      if (existing) continue
      try {
        const analysisObj = await c.env.GRIMOIRE_R2!.get(item.analysisKey)
        if (!analysisObj) continue
        const doc = JSON.parse(await analysisObj.text()) as AnalysisDocument
        const stmts: D1PreparedStatement[] = []
        for (const atom of doc.candidate_atoms ?? []) {
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO image_extraction_candidates (source_url, source_attribution, candidate_type, candidate_data, moodboard_id)
               VALUES (?, ?, 'atom', ?, ?)`
            ).bind(sourceUrl, doc.source_attribution ?? null, JSON.stringify(atom), body.moodboard_id)
          )
        }
        for (const corr of doc.candidate_correspondences ?? []) {
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO image_extraction_candidates (source_url, source_attribution, candidate_type, candidate_data, moodboard_id)
               VALUES (?, ?, 'correspondence', ?, ?)`
            ).bind(sourceUrl, doc.source_attribution ?? null, JSON.stringify(corr), body.moodboard_id)
          )
        }
        if (stmts.length > 0) {
          await c.env.DB.batch(stmts)
          rehydrated++
          console.log(`[batch] rehydrated ${stmts.length} candidates for ${item.key} (moodboard_id=${body.moodboard_id})`)
        }
      } catch (err) {
        console.log(`[batch] rehydrate failed for ${item.key}: ${(err as Error).message}`)
      }
    }
  }

  const results: Array<{ key: string; status: 'processed' | 'failed'; candidate_count?: number; error?: string }> = []
  const errors: string[] = []

  for (const item of batch) {
    try {
      // Read image bytes directly from R2
      const obj = await c.env.GRIMOIRE_R2!.get(item.key)
      if (!obj) {
        const msg = `${item.key}: object not found in R2`
        errors.push(msg)
        results.push({ key: item.key, status: 'failed', error: msg })
        continue
      }

      const buffer = await obj.arrayBuffer()
      const base64 = arrayBufferToBase64(buffer)
      const mimeType = obj.httpMetadata?.contentType ?? mimeTypeFromKey(item.key)

      const sourceUrl = `https://ref.hob.farm/${item.key}`

      console.log(`[batch] processing ${item.key} (${Math.round(buffer.byteLength / 1024)}KB)`)

      const extraction = await runExtraction({
        imageData: { base64, mimeType },
        sourceUrl,
        moodboardId: body.moodboard_id,
        env: c.env,
      })

      results.push({
        key: item.key,
        status: 'processed',
        candidate_count: extraction.payload.candidate_atoms.length + extraction.payload.candidate_correspondences.length,
      })

      console.log(`[batch] ${item.key}: ${extraction.payload.candidate_atoms.length} atoms, ${extraction.payload.candidate_correspondences.length} correspondences`)
    } catch (err) {
      const msg = `${item.key}: ${(err as Error).message}`
      errors.push(msg)
      results.push({ key: item.key, status: 'failed', error: (err as Error).message })
      console.log(`[batch] failed: ${msg}`)
    }
  }

  const processed = results.filter(r => r.status === 'processed').length
  const failed = results.filter(r => r.status === 'failed').length
  const remaining = toProcess.length - batch.length

  return c.json({ processed, skipped, failed, rehydrated, remaining, total_images: imageKeys.length, results, errors })
})

// Review endpoints (candidates listing, single/batch review, approve-source)
imageApp.route('/', reviewApp)
