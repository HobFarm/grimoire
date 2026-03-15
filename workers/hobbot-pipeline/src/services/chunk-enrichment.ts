// Chunk enrichment safety net with batched continuation
// Runs on cron (0 */6 * * *). Catches chunks missed by inline pipeline enrichment.
// Processes BATCH_SIZE chunks per invocation, then self-invokes for the next batch.
// Each invocation gets a fresh D1 CPU budget, avoiding the per-invocation limit.

import { GeminiProvider } from '@shared/providers/gemini'
import { MODELS } from '@shared/models'
import { getUnenrichedChunks, updateChunk, areAllChunksEnriched, updateDocumentStatus } from '@shared/state/documents'
import { getCategories, getArrangements } from '@shared/state/grimoire'
import { buildChunkEnrichmentPrompt } from '../prompts/chunk-enrichment'

interface ChunkEnrichEnv {
  GRIMOIRE_DB: D1Database
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  SELF_URL?: string
  INTERNAL_SECRET?: string
}

interface EnrichmentResult {
  enriched: number
  failed: number
  documents_completed: string[]
}

function sanitizeGeminiJson(raw: string): string {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  return cleaned
}

async function resolveApiKey(key: string | { get: () => Promise<string> }): Promise<string> {
  if (typeof key === 'string') return key
  if (key && typeof key === 'object' && 'get' in key) return await key.get()
  return String(key)
}

const DELAY_MS = 6_000
const BATCH_SIZE = 10
const MAX_DEPTH = 20

export async function enrichChunksBatched(
  env: ChunkEnrichEnv,
  ctx: { waitUntil: (p: Promise<any>) => void },
  depth: number = 0,
  totalSoFar: number = 0,
): Promise<EnrichmentResult> {
  const db = env.GRIMOIRE_DB
  const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)
  const { model } = MODELS['chunk.enrich'].primary

  const [categories, arrangements] = await Promise.all([
    getCategories(db),
    getArrangements(db),
  ])

  const categorySlugs = categories.map(c => c.slug)
  const arrangementSlugs = arrangements.map(a => a.slug)
  const systemPrompt = buildChunkEnrichmentPrompt(categorySlugs, arrangementSlugs)

  const chunks = await getUnenrichedChunks(db, BATCH_SIZE)
  if (chunks.length === 0) {
    if (depth > 0) {
      console.log(`[chunk-enrich] complete: total=${totalSoFar} across ${depth} invocations`)
    }
    return { enriched: 0, failed: 0, documents_completed: [] }
  }

  console.log(`[chunk-enrich] depth=${depth} processing ${chunks.length} chunks`)

  const provider = new GeminiProvider(model, geminiKey)
  const categorySet = new Set(categorySlugs)
  const arrangementSet = new Set(arrangementSlugs)

  let enriched = 0
  let failed = 0
  const documentsToCheck = new Set<string>()

  for (const chunk of chunks) {
    try {
      const userContent = `Document: "${chunk.document_title}"\n\nChunk content:\n${chunk.content.slice(0, 3000)}`

      const response = await provider.generateResponse({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        maxTokens: 1024,
        responseFormat: 'json',
      })

      const parsed = JSON.parse(sanitizeGeminiJson(response.content))

      const validCategory = parsed.category_slug && categorySet.has(parsed.category_slug)
        ? parsed.category_slug
        : chunk.category_slug

      const validArrangements = Array.isArray(parsed.arrangement_slugs)
        ? parsed.arrangement_slugs.filter((s: string) => arrangementSet.has(s))
        : []

      await updateChunk(db, chunk.chunk_id, {
        summary: parsed.summary || null,
        category_slug: validCategory,
        arrangement_slugs: validArrangements,
      })

      documentsToCheck.add(chunk.document_id)
      enriched++
    } catch (err) {
      console.warn(`[chunk-enrich] failed chunk=${chunk.chunk_id}: ${(err as Error).message}`)
      failed++
    }

    if (chunks.indexOf(chunk) < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS))
    }
  }

  const documentsCompleted: string[] = []
  for (const docId of documentsToCheck) {
    try {
      const allDone = await areAllChunksEnriched(db, docId)
      if (allDone) {
        await updateDocumentStatus(db, docId, 'enriched')
        documentsCompleted.push(docId)
      }
    } catch (err) {
      console.warn(`[chunk-enrich] failed to check/update document=${docId}: ${(err as Error).message}`)
    }
  }

  // Check if more unenriched chunks remain
  const batchTotal = totalSoFar + enriched
  const remaining = await getUnenrichedChunks(db, 1)
  if (remaining.length > 0 && depth < MAX_DEPTH && env.SELF_URL) {
    console.log(`[chunk-enrich] continuing: depth=${depth + 1}, cumulative=${batchTotal}`)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.INTERNAL_SECRET) headers['x-internal-secret'] = env.INTERNAL_SECRET
    ctx.waitUntil(
      fetch(`${env.SELF_URL}/internal/enrich-continue?depth=${depth + 1}&total=${batchTotal}`, {
        method: 'POST',
        headers,
      }).catch(e => console.error(`[chunk-enrich] continuation fetch failed: ${e}`))
    )
  } else if (remaining.length === 0 && depth > 0) {
    console.log(`[chunk-enrich] complete: total=${batchTotal} across ${depth + 1} invocations`)
  }

  return { enriched, failed, documents_completed: documentsCompleted }
}
