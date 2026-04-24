/**
 * Quality Gate
 *
 * Pre-write quality filter for all atom creation paths.
 * Three checks: specificity scoring, redundancy detection, provenance validation.
 *
 * Single atom: qualityGate() (~400ms, blocks write)
 * Batch: qualityGateBatch() (amortized, for bulk inserts)
 */

import type { ModelContext } from './models'
import { MODELS } from './models'
import { callWithFallback } from './provider'
import { isValidAtom } from './migration'

// --- Types ---

export interface QualityGateInput {
  text: string
  source: string
  source_app?: string | null
  metadata?: Record<string, unknown>
}

export interface QualityGateResult {
  pass: boolean
  specificity_score: number | null
  similar_atom_id: string | null
  similar_atom_text: string | null
  similarity_score: number | null
  rejection_reason: string | null
  flagged_for_review: boolean
  /** True when AI scoring was unavailable (circuit open, timeout, provider error). Gate passes with reduced confidence. */
  ai_skipped: boolean
}

// --- Constants ---

const SPECIFICITY_REJECT_THRESHOLD = 0.3
const SPECIFICITY_FLAG_THRESHOLD = 0.5
const REDUNDANCY_SIMILARITY_THRESHOLD = 0.92
const BATCH_SPECIFICITY_SIZE = 10
const BATCH_EMBED_SIZE = 100
const VECTORIZE_CONCURRENCY = 20
const SPECIFICITY_TIMEOUT_MS = 5000

const EMBEDDING_MODEL = MODELS.embed.primary.model as Parameters<Ai['run']>[0]

const SPECIFICITY_PROMPT_TEMPLATE = `Score the visual/creative specificity of this term for an AI image generation vocabulary.
0.0 = completely generic/abstract (e.g. "thing", "nice", "structure", "beautiful")
0.5 = moderately specific (e.g. "wooden", "blue dress", "stone wall")
1.0 = highly specific/evocative (e.g. "rain-slicked cobblestone", "cracked terracotta", "sfumato")
Term: "{TEXT}"
Respond ONLY with JSON: {"s":0.0}`

const BATCH_SPECIFICITY_PROMPT_TEMPLATE = `Score the visual/creative specificity of each term for an AI image generation vocabulary.
0.0 = completely generic/abstract (e.g. "thing", "nice", "beautiful")
0.5 = moderately specific (e.g. "wooden", "blue dress")
1.0 = highly specific/evocative (e.g. "rain-slicked cobblestone", "sfumato")
Terms:
{TERMS}
Respond ONLY with JSON: {"scores":[0.0,0.5,1.0]}`

// --- Provenance Check (pure logic, no AI) ---

function checkProvenance(input: QualityGateInput): string | null {
  if (!input.source) return 'missing_provenance'
  if (!input.metadata) return null // metadata is optional for backward compat
  const m = input.metadata
  if (m.source_url || m.pipeline_run_id || m.document_id || m.session_id) return null
  // source field alone is sufficient if it's from a known pipeline path
  if (input.source === 'ai' || input.source === 'seed') return null
  return null
}

// --- Specificity Scoring ---

function parseSpecificityScore(raw: string): number | null {
  try {
    const cleaned = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const score = typeof parsed.s === 'number' ? parsed.s : null
    if (score === null) return null
    return Math.round(Math.min(1.0, Math.max(0.0, score)) * 100) / 100
  } catch {
    return null
  }
}

function parseBatchSpecificityScores(raw: string, expectedCount: number): (number | null)[] {
  try {
    const cleaned = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const scores: unknown[] = Array.isArray(parsed.scores) ? parsed.scores : Array.isArray(parsed) ? parsed : []
    return scores.map(s => {
      if (typeof s !== 'number') return null
      return Math.round(Math.min(1.0, Math.max(0.0, s)) * 100) / 100
    }).concat(Array(Math.max(0, expectedCount - scores.length)).fill(null))
  } catch {
    return Array(expectedCount).fill(null)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  )
  return Promise.race([promise, timeout])
}

async function scoreSpecificity(
  text: string,
  ctx: ModelContext
): Promise<number | null> {
  const prompt = SPECIFICITY_PROMPT_TEMPLATE.replace('{TEXT}', text)
  try {
    const { result } = await withTimeout(
      callWithFallback(ctx, 'quality.specificity', prompt),
      SPECIFICITY_TIMEOUT_MS,
      'specificity'
    )
    return parseSpecificityScore(result)
  } catch (e) {
    console.error('[quality-gate] specificity scoring failed:', e instanceof Error ? e.message : String(e))
    return null
  }
}

async function scoreBatchSpecificity(
  texts: string[],
  ctx: ModelContext
): Promise<(number | null)[]> {
  if (texts.length === 0) return []
  const numbered = texts.map((t, i) => `${i + 1}. "${t}"`).join('\n')
  const prompt = BATCH_SPECIFICITY_PROMPT_TEMPLATE.replace('{TERMS}', numbered)
  try {
    const { result } = await callWithFallback(ctx, 'quality.specificity', prompt)
    return parseBatchSpecificityScores(result, texts.length)
  } catch (e) {
    console.error('[quality-gate] batch specificity scoring failed:', e instanceof Error ? e.message : String(e))
    return Array(texts.length).fill(null)
  }
}

// --- Redundancy Check ---

async function generateEmbedding(
  text: string,
  ai: Ai
): Promise<number[] | null> {
  try {
    const result = await ai.run(EMBEDDING_MODEL, { text: [text] }) as { data?: number[][] }
    return result.data?.[0] ?? null
  } catch (e) {
    console.error('[quality-gate] embedding generation failed:', e instanceof Error ? e.message : String(e))
    return null
  }
}

async function generateEmbeddingBatch(
  texts: string[],
  ai: Ai
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return []
  const results: (number[] | null)[] = Array(texts.length).fill(null)
  for (let i = 0; i < texts.length; i += BATCH_EMBED_SIZE) {
    const batch = texts.slice(i, i + BATCH_EMBED_SIZE)
    try {
      const result = await ai.run(EMBEDDING_MODEL, { text: batch }) as { data?: number[][] }
      if (result.data) {
        for (let j = 0; j < result.data.length; j++) {
          results[i + j] = result.data[j]
        }
      }
    } catch (e) {
      console.error(`[quality-gate] batch embed chunk ${i} failed:`, e instanceof Error ? e.message : String(e))
    }
  }
  return results
}

async function checkRedundancy(
  embedding: number[],
  vectorize: Vectorize
): Promise<{ similar_id: string | null; similar_text: string | null; score: number }> {
  try {
    const matches = await vectorize.query(embedding, {
      topK: 1,
      returnMetadata: 'indexed',
      returnValues: false,
    })
    if (matches.count > 0 && matches.matches[0].score > REDUNDANCY_SIMILARITY_THRESHOLD) {
      const match = matches.matches[0]
      const meta = match.metadata as Record<string, string> | undefined
      return {
        similar_id: match.id,
        similar_text: meta?.text ?? null,
        score: match.score,
      }
    }
  } catch (e) {
    console.error('[quality-gate] vectorize query failed:', e instanceof Error ? e.message : String(e))
  }
  return { similar_id: null, similar_text: null, score: 0 }
}

// --- Audit Logging ---

async function logGateResult(
  db: D1Database,
  text: string,
  result: QualityGateResult,
  source: string
): Promise<void> {
  const resultType = !result.pass
    ? (result.rejection_reason === 'redundant' ? 'redirect_merge' : 'reject')
    : result.flagged_for_review ? 'flag' : 'pass'
  try {
    await db.prepare(
      `INSERT INTO quality_gate_log (atom_text, specificity_score, similar_atom_id, similarity_score, result, rejection_reason, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      text.slice(0, 200),
      result.specificity_score,
      result.similar_atom_id,
      result.similarity_score,
      resultType,
      result.rejection_reason,
      source
    ).run()
  } catch (e) {
    console.error('[quality-gate] audit log failed:', e instanceof Error ? e.message : String(e))
  }
}

// --- Single Atom Gate ---

export async function qualityGate(
  input: QualityGateInput,
  ctx: ModelContext,
  ai: Ai,
  vectorize: Vectorize,
  db: D1Database
): Promise<QualityGateResult> {
  // 1. Provenance check (free)
  const provenanceError = checkProvenance(input)
  if (provenanceError) {
    const result: QualityGateResult = {
      pass: false,
      specificity_score: null,
      similar_atom_id: null,
      similar_atom_text: null,
      similarity_score: null,
      rejection_reason: 'missing_provenance',
      flagged_for_review: false,
      ai_skipped: false,
    }
    await logGateResult(db, input.text, result, input.source)
    return result
  }

  // 2. Specificity score (1 AI call, with timeout)
  const specificity = await scoreSpecificity(input.text.toLowerCase().trim(), ctx)
  const aiSkipped = specificity === null

  if (specificity !== null && specificity < SPECIFICITY_REJECT_THRESHOLD) {
    const result: QualityGateResult = {
      pass: false,
      specificity_score: specificity,
      similar_atom_id: null,
      similar_atom_text: null,
      similarity_score: null,
      rejection_reason: 'low_specificity',
      flagged_for_review: false,
      ai_skipped: false,
    }
    await logGateResult(db, input.text, result, input.source)
    return result
  }

  // 3. Redundancy check (1 embed call + 1 vectorize query)
  // Runs even when AI scoring was skipped: embedding + vectorize are independent
  const embedding = await generateEmbedding(input.text.toLowerCase().trim(), ai)
  let redundancy = { similar_id: null as string | null, similar_text: null as string | null, score: 0 }
  if (embedding) {
    redundancy = await checkRedundancy(embedding, vectorize)
  }

  if (redundancy.similar_id) {
    const result: QualityGateResult = {
      pass: false,
      specificity_score: specificity,
      similar_atom_id: redundancy.similar_id,
      similar_atom_text: redundancy.similar_text,
      similarity_score: redundancy.score,
      rejection_reason: 'redundant',
      flagged_for_review: false,
      ai_skipped: aiSkipped,
    }
    await logGateResult(db, input.text, result, input.source)
    return result
  }

  // 4. Pass (possibly flagged for review, possibly with AI skipped)
  const flagged = specificity !== null && specificity < SPECIFICITY_FLAG_THRESHOLD
  const result: QualityGateResult = {
    pass: true,
    specificity_score: specificity,
    similar_atom_id: null,
    similar_atom_text: null,
    similarity_score: null,
    rejection_reason: null,
    flagged_for_review: flagged,
    ai_skipped: aiSkipped,
  }
  await logGateResult(db, input.text, result, input.source)
  return result
}

// --- Batch Gate ---

export async function qualityGateBatch(
  inputs: QualityGateInput[],
  ctx: ModelContext,
  ai: Ai,
  vectorize: Vectorize,
  db: D1Database
): Promise<QualityGateResult[]> {
  const results: QualityGateResult[] = Array(inputs.length)

  // Phase 0: Text-level pre-filter (isValidAtom, no AI)
  const needsAI: number[] = []
  for (let i = 0; i < inputs.length; i++) {
    const validation = isValidAtom(inputs[i].text.trim())
    if (!validation.valid && ['emoticon', 'non_text', 'stock_caption', 'comment', 'too_short'].includes(validation.reason || '')) {
      results[i] = {
        pass: false, specificity_score: null, similar_atom_id: null,
        similar_atom_text: null, similarity_score: null,
        rejection_reason: validation.reason || 'invalid_text',
        flagged_for_review: false, ai_skipped: false,
      }
    } else {
      const provenanceError = checkProvenance(inputs[i])
      if (provenanceError) {
        results[i] = {
          pass: false, specificity_score: null, similar_atom_id: null,
          similar_atom_text: null, similarity_score: null,
          rejection_reason: 'missing_provenance',
          flagged_for_review: false, ai_skipped: false,
        }
      } else {
        needsAI.push(i)
      }
    }
  }

  if (needsAI.length === 0) return results

  // Phase 1: Batch specificity scoring (BATCH_SPECIFICITY_SIZE per AI call)
  const textsForScoring = needsAI.map(i => inputs[i].text.toLowerCase().trim())
  const allScores: (number | null)[] = []

  for (let i = 0; i < textsForScoring.length; i += BATCH_SPECIFICITY_SIZE) {
    const batch = textsForScoring.slice(i, i + BATCH_SPECIFICITY_SIZE)
    const scores = await scoreBatchSpecificity(batch, ctx)
    allScores.push(...scores)
  }

  // Filter out low-specificity before expensive embedding step
  const needsEmbed: number[] = []
  for (let j = 0; j < needsAI.length; j++) {
    const idx = needsAI[j]
    const score = allScores[j]
    if (score !== null && score < SPECIFICITY_REJECT_THRESHOLD) {
      results[idx] = {
        pass: false, specificity_score: score, similar_atom_id: null,
        similar_atom_text: null, similarity_score: null,
        rejection_reason: 'low_specificity',
        flagged_for_review: false, ai_skipped: false,
      }
    } else {
      needsEmbed.push(j) // index into needsAI
    }
  }

  if (needsEmbed.length === 0) {
    await logBatchResults(db, inputs, results)
    return results
  }

  // Phase 2: Batch embedding generation
  const textsForEmbed = needsEmbed.map(j => textsForScoring[j])
  const embeddings = await generateEmbeddingBatch(textsForEmbed, ai)

  // Phase 3: Parallel vectorize queries (capped concurrency)
  const redundancyResults = await parallelVectorizeQueries(
    embeddings,
    vectorize,
    VECTORIZE_CONCURRENCY
  )

  // Phase 4: Assemble results
  for (let k = 0; k < needsEmbed.length; k++) {
    const j = needsEmbed[k]
    const idx = needsAI[j]
    const score = allScores[j]
    const redundancy = redundancyResults[k]

    const aiWasSkipped = score === null
    if (redundancy.similar_id) {
      results[idx] = {
        pass: false, specificity_score: score,
        similar_atom_id: redundancy.similar_id,
        similar_atom_text: redundancy.similar_text,
        similarity_score: redundancy.score,
        rejection_reason: 'redundant',
        flagged_for_review: false, ai_skipped: aiWasSkipped,
      }
    } else {
      const flagged = score !== null && score < SPECIFICITY_FLAG_THRESHOLD
      results[idx] = {
        pass: true, specificity_score: score,
        similar_atom_id: null, similar_atom_text: null,
        similarity_score: null, rejection_reason: null,
        flagged_for_review: flagged, ai_skipped: aiWasSkipped,
      }
    }
  }

  await logBatchResults(db, inputs, results)
  return results
}

// --- Helpers ---

async function parallelVectorizeQueries(
  embeddings: (number[] | null)[],
  vectorize: Vectorize,
  concurrency: number
): Promise<Array<{ similar_id: string | null; similar_text: string | null; score: number }>> {
  const results: Array<{ similar_id: string | null; similar_text: string | null; score: number }> = []
  for (let i = 0; i < embeddings.length; i += concurrency) {
    const batch = embeddings.slice(i, i + concurrency)
    const promises = batch.map(emb =>
      emb ? checkRedundancy(emb, vectorize) : Promise.resolve({ similar_id: null, similar_text: null, score: 0 })
    )
    const settled = await Promise.allSettled(promises)
    for (const s of settled) {
      results.push(
        s.status === 'fulfilled'
          ? s.value
          : { similar_id: null, similar_text: null, score: 0 }
      )
    }
  }
  return results
}

async function logBatchResults(
  db: D1Database,
  inputs: QualityGateInput[],
  results: QualityGateResult[]
): Promise<void> {
  // Log rejections, flags, and redirects (skip logging passes to reduce volume)
  const toLog: Array<{ text: string; result: QualityGateResult; source: string }> = []
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) continue
    if (!results[i].pass || results[i].flagged_for_review) {
      toLog.push({ text: inputs[i].text, result: results[i], source: inputs[i].source })
    }
  }

  // Batch insert in chunks of 50 (D1 batch limit headroom)
  for (let i = 0; i < toLog.length; i += 50) {
    const chunk = toLog.slice(i, i + 50)
    try {
      const stmts = chunk.map(entry => {
        const resultType = !entry.result.pass
          ? (entry.result.rejection_reason === 'redundant' ? 'redirect_merge' : 'reject')
          : 'flag'
        return db.prepare(
          `INSERT INTO quality_gate_log (atom_text, specificity_score, similar_atom_id, similarity_score, result, rejection_reason, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          entry.text.slice(0, 200),
          entry.result.specificity_score,
          entry.result.similar_atom_id,
          entry.result.similarity_score,
          resultType,
          entry.result.rejection_reason,
          entry.source
        )
      })
      await db.batch(stmts)
    } catch (e) {
      console.error('[quality-gate] batch audit log failed:', e instanceof Error ? e.message : String(e))
    }
  }
}
