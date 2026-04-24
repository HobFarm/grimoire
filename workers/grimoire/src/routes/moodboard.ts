// Moodboard admin routes: register, aggregate, status.
// Mounted at /admin/moodboard in index.ts (admin Bearer auth middleware applies).

import { Hono } from 'hono'
import type { Env } from '../types'
import {
  getMoodboardByBusinessId,
  createMoodboard,
  updateMoodboardStatus,
  countCandidatesForMoodboard,
  listCandidateSourceUrlsForMoodboard,
  type Moodboard,
  type MoodboardStatus,
} from '../state/moodboards'
import { buildModelContext } from '../models'
import { callWithFallback } from '../provider'
import { tryParseJson } from '../gemini'
import { deriveAnalysisKey, type AnalysisDocument } from '../r2-analysis'
import {
  buildMoodboardAggregatePrompt,
  MOODBOARD_AGGREGATE_PROMPT_VERSION,
  type AggregateSourceIR,
} from '../prompts/moodboard-aggregate'

// --- Aggregation thresholds (brief §Step 3 constants) ---

export const INVARIANT_THRESHOLD = 0.66
export const VECTOR_LOWER = 0.33
export const LOW_FREQ_UPPER = 0.22

const ANALYSIS_FETCH_CONCURRENCY = 5

// --- App ---

export const moodboardApp = new Hono<{ Bindings: Env }>()

// --- POST /register: idempotent create ---

moodboardApp.post('/register', async (c) => {
  const body = await c.req.json<{
    moodboard_id?: string
    source?: string
    slug?: string
    title?: string | null
    source_url?: string | null
    source_description?: string | null
    license?: string | null
    source_count?: number
    composite_r2_key?: string | null
    manifest_r2_key?: string | null
    metadata?: string | null
  }>()

  if (!body.moodboard_id || !body.source || !body.slug) {
    return c.json({ error: 'moodboard_id, source, and slug are required' }, 400)
  }

  const row = await createMoodboard(c.env.DB, {
    moodboard_id: body.moodboard_id,
    source: body.source,
    slug: body.slug,
    title: body.title ?? null,
    source_url: body.source_url ?? null,
    source_description: body.source_description ?? null,
    license: body.license ?? null,
    source_count: body.source_count ?? 0,
    composite_r2_key: body.composite_r2_key ?? null,
    manifest_r2_key: body.manifest_r2_key ?? null,
    metadata: body.metadata ?? null,
  })

  return c.json({ moodboard: row })
})

// --- POST /status: return current row ---

moodboardApp.post('/status', async (c) => {
  const body = await c.req.json<{ moodboard_id?: string }>()
  if (!body.moodboard_id) {
    return c.json({ error: 'moodboard_id is required' }, 400)
  }
  const row = await getMoodboardByBusinessId(c.env.DB, body.moodboard_id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json({ moodboard: row })
})

// --- POST /aggregate: synthesize per-image IRs into aggregate ---

moodboardApp.post('/aggregate', async (c) => {
  if (!c.env.GRIMOIRE_R2) {
    return c.json({ error: 'GRIMOIRE_R2 binding not available' }, 500)
  }

  const body = await c.req.json<{ moodboard_id?: string }>()
  if (!body.moodboard_id) {
    return c.json({ error: 'moodboard_id is required' }, 400)
  }

  const moodboard = await getMoodboardByBusinessId(c.env.DB, body.moodboard_id)
  if (!moodboard) return c.json({ error: 'not_found' }, 404)

  // Preconditions: candidate count >= source_count AND every source URL has an analysis JSON in R2.
  const candidateCount = await countCandidatesForMoodboard(c.env.DB, moodboard.moodboard_id)
  const sourceUrls = await listCandidateSourceUrlsForMoodboard(c.env.DB, moodboard.moodboard_id)

  if (moodboard.source_count > 0 && sourceUrls.length < moodboard.source_count) {
    return c.json({
      error: 'preconditions_failed',
      message: `expected >= ${moodboard.source_count} distinct source_urls in candidates, got ${sourceUrls.length}`,
      status: moodboard.status,
    }, 409)
  }

  // Resolve analysis R2 keys and fetch all analysis JSONs.
  const analysisKeys = await Promise.all(sourceUrls.map((u) => deriveAnalysisKey(u)))
  const analyses = await fetchAnalysesConcurrent(c.env.GRIMOIRE_R2, analysisKeys)

  const missingKeys = analysisKeys.filter((_, i) => !analyses[i])
  if (missingKeys.length > 0) {
    return c.json({
      error: 'analyses_missing',
      message: `${missingKeys.length} analysis JSON(s) not found in R2`,
      missing_keys: missingKeys.slice(0, 10),
      status: moodboard.status,
    }, 409)
  }

  // Auto-flip pending -> extracted if preconditions now hold.
  if (moodboard.status === 'pending') {
    await updateMoodboardStatus(c.env.DB, moodboard.moodboard_id, 'extracted')
    moodboard.status = 'extracted'
  } else if (moodboard.status !== 'extracted') {
    return c.json({
      error: 'invalid_status',
      message: `expected status 'pending' or 'extracted', got '${moodboard.status}'`,
    }, 409)
  }

  // Load live category list (anti-hardcode).
  const catResult = await c.env.DB
    .prepare('SELECT slug, label FROM categories ORDER BY slug')
    .all<{ slug: string; label: string }>()
  const categories = catResult.results ?? []
  const validSlugs = new Set(categories.map((c) => c.slug))

  // Cast to non-null since we checked missingKeys above.
  const loadedAnalyses = analyses as AnalysisDocument[]
  const sourceIRs: AggregateSourceIR[] = loadedAnalyses.map((a) => ({
    source_url: a.source_url,
    source_attribution: a.source_attribution,
    artist_attribution: a.artist_attribution,
    candidate_atoms: a.candidate_atoms.map((atom) => ({
      name: atom.name,
      description: atom.description,
      suggested_category: atom.suggested_category,
      utility: atom.utility,
      modality: atom.modality,
      confidence: atom.confidence,
    })),
    candidate_correspondences: a.candidate_correspondences.map((corr) => ({
      source_name: corr.source_name,
      target_name: corr.target_name,
      relationship: corr.relationship,
      suggested_strength: corr.suggested_strength,
    })),
  }))

  const prompt = buildMoodboardAggregatePrompt({
    moodboard_id: moodboard.moodboard_id,
    source: moodboard.source,
    slug: moodboard.slug,
    title: moodboard.title,
    source_description: moodboard.source_description,
    analyses: sourceIRs,
    categories,
    thresholds: {
      invariant: INVARIANT_THRESHOLD,
      vectorLower: VECTOR_LOWER,
      lowFreqUpper: LOW_FREQ_UPPER,
    },
  })

  const ctx = await buildModelContext(c.env)

  const estInputTokens = Math.ceil(prompt.length / 4)

  let callResult
  try {
    callResult = await callWithFallback(ctx, 'moodboard.aggregate', prompt)
  } catch (err) {
    console.log(`[moodboard/aggregate] ${moodboard.moodboard_id}: all providers failed: ${(err as Error).message}`)
    return c.json({
      error: 'aggregation_failed',
      message: (err as Error).message,
      status: moodboard.status,
    }, 502)
  }

  // Workers AI occasionally returns empty completions with no exception (documented Qwen3 flake).
  // Retrying the same model does not help. Force fallback model directly via skipPrimary.
  if (!callResult.result || callResult.result.trim() === '') {
    console.log(`[moodboard/aggregate] ${moodboard.moodboard_id}: empty completion from ${callResult.model} (prompt ~${estInputTokens} tokens), forcing fallback`)
    try {
      callResult = await callWithFallback(ctx, 'moodboard.aggregate', prompt, { skipPrimary: true })
    } catch (err) {
      console.log(`[moodboard/aggregate] ${moodboard.moodboard_id}: fallback failed after empty primary: ${(err as Error).message}`)
      return c.json({
        error: 'aggregation_failed',
        message: `primary returned empty, fallback failed: ${(err as Error).message}`,
        status: moodboard.status,
      }, 502)
    }
    if (!callResult.result || callResult.result.trim() === '') {
      console.log(`[moodboard/aggregate] ${moodboard.moodboard_id}: both primary and fallback returned empty (prompt ~${estInputTokens} tokens) -- likely prompt-malformed`)
      return c.json({
        error: 'empty_completion',
        message: 'both primary and fallback returned empty output',
        prompt_estimated_tokens: estInputTokens,
        status: moodboard.status,
      }, 502)
    }
  }

  let aggregate = tryParseJson<Record<string, unknown>>(callResult.result)
  if (!aggregate) {
    console.log(`[moodboard/aggregate] ${moodboard.moodboard_id}: JSON parse failed, retrying with stricter prompt`)
    try {
      const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY valid JSON. No markdown fences, no commentary. Start with { and end with }.'
      const retryResult = await callWithFallback(ctx, 'moodboard.aggregate', retryPrompt)
      if (retryResult.result && retryResult.result.trim() !== '') {
        aggregate = tryParseJson<Record<string, unknown>>(retryResult.result)
        if (aggregate) {
          callResult = retryResult
        }
      }
    } catch {
      // fall through to error below
    }
  }

  if (!aggregate) {
    return c.json({
      error: 'parse_failed',
      raw_analysis: callResult.result.slice(0, 2000),
      status: moodboard.status,
    }, 422)
  }

  // Validate aggregate shape.
  const validation = validateAggregate(aggregate, validSlugs, loadedAnalyses.length)
  if (!validation.ok) {
    return c.json({
      error: 'validation_failed',
      message: validation.message,
      status: moodboard.status,
    }, 422)
  }

  // Persist dropped atoms for "which categories do we keep missing" signal.
  // Observability only: failures here must not block aggregation.
  if (validation.rejects.length > 0) {
    try {
      const DROP_CHUNK = 80
      for (let i = 0; i < validation.rejects.length; i += DROP_CHUNK) {
        const chunk = validation.rejects.slice(i, i + DROP_CHUNK)
        const stmts = chunk.map(r =>
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO moodboard_dropped_atoms
               (moodboard_id, atom_name, suggested_category, bucket,
                frequency, mean_confidence, utility, modality)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            moodboard.moodboard_id,
            r.atom_name,
            r.suggested_category,
            r.bucket,
            r.frequency,
            r.mean_confidence,
            r.utility,
            r.modality,
          )
        )
        await c.env.DB.batch(stmts)
      }
    } catch (err) {
      console.warn(
        `[moodboard/aggregate] dropped-atoms capture failed: ${(err as Error).message}`,
      )
    }
  }

  // Enrich with server-side metadata.
  aggregate.source_ir_keys = analysisKeys
  aggregate.raw_analysis = callResult.result
  aggregate.schema_version = 'v0'
  aggregate.aggregation_metadata = {
    model: callResult.model,
    provider: callResult.provider,
    timestamp: new Date().toISOString(),
    prompt_version: MOODBOARD_AGGREGATE_PROMPT_VERSION,
    duration_ms: callResult.durationMs,
    estimated_input_tokens: Math.ceil(prompt.length / 4),
    estimated_output_tokens: Math.ceil(callResult.result.length / 4),
    fallback_used: callResult.model !== '@cf/qwen/qwen3-30b-a3b-fp8',
  }

  // Write aggregate IR to R2.
  const irKey = `moodboards/${moodboard.source}/${moodboard.slug}/ir.json`
  await c.env.GRIMOIRE_R2.put(irKey, JSON.stringify(aggregate, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  })

  // Update DB row.
  await updateMoodboardStatus(c.env.DB, moodboard.moodboard_id, 'aggregated', { ir_r2_key: irKey })

  return c.json({
    moodboard_id: moodboard.moodboard_id,
    slug: moodboard.slug,
    ir_r2_key: irKey,
    model: callResult.model,
    provider: callResult.provider,
    duration_ms: callResult.durationMs,
    prompt_version: MOODBOARD_AGGREGATE_PROMPT_VERSION,
    fallback_used: callResult.model !== '@cf/qwen/qwen3-30b-a3b-fp8',
    aggregate,
  })
})

// --- Helpers ---

async function fetchAnalysesConcurrent(
  r2: R2Bucket,
  keys: string[],
): Promise<Array<AnalysisDocument | null>> {
  const results: Array<AnalysisDocument | null> = new Array(keys.length).fill(null)
  let cursor = 0

  async function worker() {
    while (cursor < keys.length) {
      const idx = cursor++
      const key = keys[idx]
      try {
        const obj = await r2.get(key)
        if (!obj) continue
        results[idx] = JSON.parse(await obj.text()) as AnalysisDocument
      } catch (err) {
        console.log(`[moodboard/aggregate] fetch failed for ${key}: ${(err as Error).message}`)
      }
    }
  }

  await Promise.all(Array.from({ length: ANALYSIS_FETCH_CONCURRENCY }, () => worker()))
  return results
}

export interface DroppedAtomReject {
  atom_name: string
  suggested_category: string
  bucket: 'invariant' | 'vector' | 'low_frequency'
  frequency: number | null
  mean_confidence: number | null
  utility: string | null
  modality: string | null
}

interface ValidationResult {
  ok: boolean
  message?: string
  rejects: DroppedAtomReject[]
}

const BUCKET_LABELS: Record<'invariants' | 'vectors' | 'low_frequency_elements', DroppedAtomReject['bucket']> = {
  invariants: 'invariant',
  vectors: 'vector',
  low_frequency_elements: 'low_frequency',
}

function toStrOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function toNumOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function validateAggregate(
  agg: Record<string, unknown>,
  validSlugs: Set<string>,
  expectedSourceCount: number,
): ValidationResult {
  const rejects: DroppedAtomReject[] = []
  const required = ['gestalt', 'invariants', 'vectors', 'low_frequency_elements', 'compilation_hints']
  for (const field of required) {
    if (!(field in agg)) {
      return { ok: false, message: `missing required field: ${field}`, rejects }
    }
  }

  if (typeof agg.source_count === 'number' && agg.source_count !== expectedSourceCount) {
    console.log(`[moodboard/aggregate] source_count mismatch: model=${agg.source_count} actual=${expectedSourceCount} (correcting)`)
    agg.source_count = expectedSourceCount
  } else if (typeof agg.source_count !== 'number') {
    agg.source_count = expectedSourceCount
  }

  // Validate each atom bucket: drop atoms with invalid category, clamp frequency.
  const buckets = Object.keys(BUCKET_LABELS) as Array<keyof typeof BUCKET_LABELS>
  for (const bucket of buckets) {
    const arr = agg[bucket]
    if (!Array.isArray(arr)) {
      return { ok: false, message: `${bucket} must be an array`, rejects }
    }
    const bucketLabel = BUCKET_LABELS[bucket]
    agg[bucket] = arr.filter((atom: unknown) => {
      if (typeof atom !== 'object' || atom === null) return false
      const a = atom as Record<string, unknown>
      if (typeof a.suggested_category === 'string' && !validSlugs.has(a.suggested_category)) {
        const name = toStrOrNull(a.name)
        if (name) {
          rejects.push({
            atom_name: name,
            suggested_category: a.suggested_category,
            bucket: bucketLabel,
            frequency: toNumOrNull(a.frequency),
            mean_confidence: toNumOrNull(a.mean_confidence),
            utility: toStrOrNull(a.utility),
            modality: toStrOrNull(a.modality),
          })
        }
        return false
      }
      if (typeof a.frequency === 'number') {
        if (a.frequency < 0 || a.frequency > 1) {
          a.frequency = Math.max(0, Math.min(1, a.frequency))
        }
      }
      return true
    })
  }

  return { ok: true, rejects }
}
