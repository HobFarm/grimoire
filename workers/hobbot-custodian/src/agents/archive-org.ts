// Archive.org Knowledge Agent
// Claims knowledge_requests, searches Internet Archive for relevant public domain PDFs,
// evaluates candidates for quality, queues best matches as feed_entries for pipeline ingest.

import { logAction } from '@shared/ledger'
import { callWithJsonParse, type GatewayConfig } from '@shared/providers/call-with-json-parse'
import { resolveApiKey, createTokenLogger } from '@shared/providers'
import { MODELS } from '@shared/models'
import {
  searchItems as iaSearchItems,
  getItemMetadata as iaGetItemMetadata,
  getItemViews as iaGetItemViews,
  pickBestPdf as iaPickBestPdf,
} from '@shared/clients/archive-org'

interface AgentEnv {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  AI: Ai
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  PROVIDER_HEALTH?: KVNamespace
  AI_GATEWAY_ACCOUNT_ID?: string
  AI_GATEWAY_NAME?: string
  AI_GATEWAY_TOKEN?: string | { get: () => Promise<string> }
}

export interface AgentResult {
  claimed: number
  searched: number
  queued: number
  errors: string[]
}

interface KnowledgeRequest {
  id: number
  request_type: string
  target_arrangements: string | null
  target_categories: string | null
  search_intent: string
  priority: number
  source_agent: string | null
}

interface IASearchResult {
  identifier: string
  title: string
  creator?: string
  date?: string
  description?: string
  downloads?: number
  mediatype?: string
}

const MAX_CLAIMS_PER_RUN = 3
const MAX_IA_SEARCHES = 5
const IA_DELAY_MS = 2000
const MAX_CANDIDATES = 10
const MAX_INGEST_PER_REQUEST = 5
const MAX_PDF_SIZE_MB = 100

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// SHA-256 content hash for dedup
async function contentHash(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Claim pending requests
async function claimRequests(db: D1Database): Promise<KnowledgeRequest[]> {
  const { results: pending } = await db.prepare(
    `SELECT id, request_type, target_arrangements, target_categories, search_intent, priority, source_agent
     FROM knowledge_requests
     WHERE (source_agent = 'archive_org' OR source_agent IS NULL)
       AND status = 'pending'
     ORDER BY priority DESC
     LIMIT ?`
  ).bind(MAX_CLAIMS_PER_RUN).all<KnowledgeRequest>()

  const claimed: KnowledgeRequest[] = []
  for (const req of pending ?? []) {
    const result = await db.prepare(
      `UPDATE knowledge_requests
       SET status = 'claimed', claimed_by = 'archive_org', claimed_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    ).bind(req.id).run()
    if ((result.meta.changes ?? 0) > 0) {
      claimed.push(req)
    }
  }
  return claimed
}

// Generate IA search queries via AI
const QUERIES_SYSTEM_PROMPT = `Generate 2-3 Internet Archive Advanced Search queries to find public domain books relevant to this knowledge need.

Rules for IA query syntax:
- Use subject:(...) for topic/category terms
- Use title:(...) when targeting a specific work
- Use text:(...) for full-text OCR search. The default q parameter ALSO indexes full text, so bare terms will match content. Use text:(...) when you want to require terms appear in the body, not just metadata.
- Use mediatype:texts for books
- Combine with AND/OR
- Prefer collection:opensource for public domain
- Focus on art technique manuals, workshop guides, material studies, and exhibition catalogs over general histories
- For vocabulary/material gaps, prefer text:(specific terms) so you find books that DISCUSS the material, not just books titled after it

Respond with JSON: { "queries": ["query1", "query2"] }`

async function generateSearchQueries(
  ai: Ai,
  geminiKey: string,
  request: KnowledgeRequest,
  health?: KVNamespace,
  gateway?: GatewayConfig,
): Promise<string[]> {
  let arrangements: string[] = []
  let categories: string[] = []
  try { arrangements = JSON.parse(request.target_arrangements ?? '[]') } catch {}
  try { categories = JSON.parse(request.target_categories ?? '[]') } catch {}

  const categoryDesc = categories.length > 0
    ? `We specifically need content about: ${categories.join(', ')}. These categories track specific materials, techniques, surfaces, and physical properties, NOT general historical narrative.`
    : ''

  const userContent = `Search intent: ${request.search_intent}
Target arrangements: ${arrangements.join(', ')}
${categoryDesc}`

  try {
    const { result, modelUsed } = await callWithJsonParse<{ queries?: string[] }>(
      'conductor.queries', QUERIES_SYSTEM_PROMPT, userContent, ai, geminiKey,
      MODELS['custodian.queries'],
      { health, gateway, onUsage: createTokenLogger(env.HOBBOT_DB, 'hobbot-custodian') },
    )
    console.log(`[archive-org] queries generated via ${modelUsed}`)
    return ((result.queries as unknown[]) ?? []).map(String).slice(0, 3)
  } catch {
    // All models failed: construct a basic query from the arrangement name
    const arrName = arrangements[0] ?? 'art'
    return [`subject:(${arrName}) AND mediatype:texts AND collection:opensource`]
  }
}

// Search Internet Archive (delegates to shared client)
async function searchIA(query: string): Promise<IASearchResult[]> {
  const { hits } = await iaSearchItems({ query, limit: 20 })
  return hits.map(h => ({
    identifier: h.identifier,
    title: h.title ?? h.identifier,
    creator: h.creator,
    date: h.date,
    description: h.description,
    downloads: h.downloads,
    mediatype: h.mediatype,
  }))
}

// Get item metadata, pick best PDF, return {url, sizeMB, hasOcr}
async function getItemPdf(identifier: string): Promise<{ url: string; sizeMB: number; hasOcr: boolean } | null> {
  let meta
  try {
    meta = await iaGetItemMetadata(identifier)
  } catch {
    return null
  }
  const pdf = iaPickBestPdf(meta.files)
  if (!pdf) return null
  return {
    url: pdf.downloadUrl(identifier),
    sizeMB: pdf.sizeMB,
    hasOcr: meta.ocrAvailable,
  }
}

// Tiered Views API bonus: >5000 → +0.2, >1000 → +0.1, else 0
async function viewsBonus(identifier: string): Promise<number> {
  const views = await iaGetItemViews(identifier)
  if (!views) return 0
  if (views.allTime > 5000) return 0.2
  if (views.allTime > 1000) return 0.1
  return 0
}

// Score candidate relevance via AI
const SCORE_SYSTEM_PROMPT = `Score this book's relevance (0.0 to 1.0) for filling a knowledge gap.

Respond with JSON: { "score": 0.7, "reason": "brief explanation" }`

async function scoreCandidate(
  ai: Ai,
  geminiKey: string,
  candidate: IASearchResult,
  request: KnowledgeRequest,
  health?: KVNamespace,
  gateway?: GatewayConfig,
  onUsage?: (usage: { taskType: string; model: string; provider: string; inputTokens: number; outputTokens: number; estimatedCost: number }) => void,
): Promise<number> {
  let categories: string[] = []
  try { categories = JSON.parse(request.target_categories ?? '[]') } catch {}

  const catDesc = categories.length > 0
    ? `We need terms for specific ${categories.join(', ')} vocabulary: materials, techniques, surface treatments, physical properties. NOT general historical narrative. A book titled "X: A History" likely contains narrative content, not material vocabulary. Score based on likelihood of containing specific material/technique terminology.`
    : ''

  const userContent = `Knowledge need: ${request.search_intent}
${catDesc}

Book title: ${candidate.title}
Creator: ${candidate.creator ?? 'unknown'}
Date: ${candidate.date ?? 'unknown'}
Description: ${(candidate.description ?? '').slice(0, 300)}`

  try {
    const { result } = await callWithJsonParse<{ score?: number; reason?: string }>(
      'conductor.score', SCORE_SYSTEM_PROMPT, userContent, ai, geminiKey,
      MODELS['custodian.score'],
      { health, gateway, onUsage },
    )
    return typeof result.score === 'number' ? Math.min(1, Math.max(0, result.score)) : 0.3
  } catch {
    return 0.3 // Default moderate score on all-models-fail
  }
}

// Check if a specific PDF URL has already been ingested or queued (exact match, no LIKE)
async function isAlreadyIngested(grimoireDb: D1Database, hobbotDb: D1Database, pdfUrl: string): Promise<boolean> {
  // Check ingest_log (GRIMOIRE_DB)
  const logResult = await grimoireDb.prepare(
    `SELECT id FROM ingest_log WHERE url = ? LIMIT 1`
  ).bind(pdfUrl).first()
  if (logResult) return true

  // Check feed_entries (HOBBOT_DB)
  const feedResult = await hobbotDb.prepare(
    `SELECT id FROM feed_entries WHERE entry_url = ? LIMIT 1`
  ).bind(pdfUrl).first()
  if (feedResult) return true

  return false
}

// Process a single knowledge request
async function processRequest(
  env: AgentEnv,
  ai: Ai,
  geminiKey: string,
  request: KnowledgeRequest,
  searchBudget: { remaining: number },
  health?: KVNamespace,
  gateway?: GatewayConfig,
): Promise<{ searched: number; queued: number; error?: string }> {
  let searched = 0
  let queued = 0
  const skipReasons: Record<string, number> = {}

  // Update status to searching
  await env.HOBBOT_DB.prepare(
    `UPDATE knowledge_requests SET status = 'searching' WHERE id = ?`
  ).bind(request.id).run()

  // Generate search queries
  const queries = await generateSearchQueries(ai, geminiKey, request, health, gateway)
  const searchQueriesJson = JSON.stringify(queries)

  // Collect candidates from all queries
  const allCandidates: IASearchResult[] = []
  for (const query of queries) {
    if (searchBudget.remaining <= 0) break
    try {
      const results = await searchIA(query)
      allCandidates.push(...results)
      searched++
      searchBudget.remaining--
      await sleep(IA_DELAY_MS)
    } catch (e) {
      console.warn(`[archive-org] search failed for query "${query}": ${e instanceof Error ? e.message : e}`)
    }
  }

  // Deduplicate candidates by identifier
  const seen = new Set<string>()
  const uniqueCandidates = allCandidates.filter(c => {
    if (seen.has(c.identifier)) return false
    seen.add(c.identifier)
    return true
  }).slice(0, MAX_CANDIDATES)

  let candidatesFound = uniqueCandidates.length
  let candidatesEvaluated = 0
  let itemsSkipped = 0

  // Evaluate each candidate
  const scored: { candidate: IASearchResult; score: number; pdfUrl: string; sizeMB: number }[] = []

  for (const candidate of uniqueCandidates) {
    candidatesEvaluated++

    // Quality heuristics
    if (candidate.mediatype && candidate.mediatype !== 'texts') {
      skipReasons['wrong_mediatype'] = (skipReasons['wrong_mediatype'] ?? 0) + 1
      itemsSkipped++
      continue
    }

    // Get PDF file info first (we need the exact URL for dedup)
    const pdfInfo = await getItemPdf(candidate.identifier)
    await sleep(IA_DELAY_MS)

    if (!pdfInfo) {
      skipReasons['no_pdf'] = (skipReasons['no_pdf'] ?? 0) + 1
      itemsSkipped++
      continue
    }

    if (pdfInfo.sizeMB > MAX_PDF_SIZE_MB) {
      skipReasons['too_large'] = (skipReasons['too_large'] ?? 0) + 1
      itemsSkipped++
      continue
    }

    // Check if already ingested (exact URL match, no LIKE)
    const alreadyIngested = await isAlreadyIngested(env.GRIMOIRE_DB, env.HOBBOT_DB, pdfInfo.url)
    if (alreadyIngested) {
      skipReasons['already_ingested'] = (skipReasons['already_ingested'] ?? 0) + 1
      itemsSkipped++
      continue
    }

    // Prefer items with OCR
    const ocrBonus = pdfInfo.hasOcr ? 0.1 : 0
    // Tiered Views API popularity bonus (replaces flat download bonus)
    const popularityBonus = await viewsBonus(candidate.identifier)

    // Score relevance via AI
    const baseScore = await scoreCandidate(ai, geminiKey, candidate, request, health, gateway, createTokenLogger(env.HOBBOT_DB, 'hobbot-custodian'))
    const finalScore = Math.min(1, baseScore + ocrBonus + popularityBonus)

    if (finalScore < 0.4) {
      skipReasons['low_relevance'] = (skipReasons['low_relevance'] ?? 0) + 1
      itemsSkipped++
      continue
    }

    scored.push({ candidate, score: finalScore, pdfUrl: pdfInfo.url, sizeMB: pdfInfo.sizeMB })
  }

  // Select top candidates
  scored.sort((a, b) => b.score - a.score)
  const selected = scored.slice(0, MAX_INGEST_PER_REQUEST)

  // Parse arrangement hints from request
  let arrangementHints: string[] = []
  try { arrangementHints = JSON.parse(request.target_arrangements ?? '[]') } catch {}

  // Queue as feed_entries
  for (const item of selected) {
    const hash = await contentHash(`${item.candidate.title}|${item.pdfUrl}`)
    const metadata = JSON.stringify({
      arrangement_hints: arrangementHints,
      ia_identifier: item.candidate.identifier,
    })

    try {
      await env.HOBBOT_DB.prepare(
        `INSERT OR IGNORE INTO feed_entries
           (source_id, entry_url, entry_title, published_at, extraction_status,
            relevance_score, content_hash, scored_at, ingested, mime_type, source_type, metadata, knowledge_request_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'), 0, 'application/pdf', 'archive_org', ?, ?)`
      ).bind(
        'archive-org-agent',
        item.pdfUrl,
        item.candidate.title ?? item.candidate.identifier,
        item.candidate.date ?? null,
        item.score,
        hash,
        metadata,
        request.id,
      ).run()
      queued++
    } catch (e) {
      // UNIQUE constraint violation = already queued (dedup)
      if ((e as Error).message?.includes('UNIQUE')) {
        skipReasons['duplicate_entry'] = (skipReasons['duplicate_entry'] ?? 0) + 1
        itemsSkipped++
      } else {
        throw e
      }
    }
  }

  // Update knowledge request
  await env.HOBBOT_DB.prepare(
    `UPDATE knowledge_requests
     SET status = 'ingesting',
         search_queries = ?,
         candidates_found = ?,
         candidates_evaluated = ?,
         items_ingested = ?,
         items_skipped = ?,
         skip_reasons = ?
     WHERE id = ?`
  ).bind(
    searchQueriesJson,
    candidatesFound,
    candidatesEvaluated,
    queued,
    itemsSkipped,
    JSON.stringify(skipReasons),
    request.id,
  ).run()

  console.log(`[archive-org] request=${request.id}: found=${candidatesFound} evaluated=${candidatesEvaluated} queued=${queued} skipped=${itemsSkipped}`)

  return { searched, queued }
}

export async function runArchiveOrgAgent(env: AgentEnv): Promise<AgentResult> {
  const errors: string[] = []
  let totalSearched = 0
  let totalQueued = 0

  // Claim requests
  const claimed = await claimRequests(env.HOBBOT_DB)
  if (claimed.length === 0) {
    return { claimed: 0, searched: 0, queued: 0, errors }
  }

  console.log(`[archive-org] claimed ${claimed.length} requests`)

  // Resolve Gemini API key (needed for fallback chain)
  let apiKey: string
  try {
    apiKey = await resolveApiKey(env.GEMINI_API_KEY)
  } catch (e) {
    errors.push(`Failed to resolve GEMINI_API_KEY: ${e instanceof Error ? e.message : e}`)
    // Release claims on failure
    for (const req of claimed) {
      await env.HOBBOT_DB.prepare(
        `UPDATE knowledge_requests SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ?`
      ).bind(req.id).run()
    }
    return { claimed: claimed.length, searched: 0, queued: 0, errors }
  }

  // Resolve gateway config for AI Gateway routing
  let gateway: GatewayConfig | undefined
  if (env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ACCOUNT_ID) {
    try {
      const token = typeof env.AI_GATEWAY_TOKEN === 'string'
        ? env.AI_GATEWAY_TOKEN
        : await env.AI_GATEWAY_TOKEN.get()
      gateway = { accountId: env.AI_GATEWAY_ACCOUNT_ID, name: env.AI_GATEWAY_NAME ?? 'hobfarm', token }
    } catch {}
  }

  const searchBudget = { remaining: MAX_IA_SEARCHES }

  // Process each claimed request
  for (const request of claimed) {
    try {
      const result = await processRequest(env, env.AI, apiKey, request, searchBudget, env.PROVIDER_HEALTH, gateway)
      totalSearched += result.searched
      totalQueued += result.queued
    } catch (e) {
      const msg = `Failed processing request ${request.id}: ${e instanceof Error ? e.message : e}`
      errors.push(msg)
      console.warn(`[archive-org] ${msg}`)

      // Mark request as failed
      await env.HOBBOT_DB.prepare(
        `UPDATE knowledge_requests SET status = 'failed', result_notes = ? WHERE id = ?`
      ).bind(msg, request.id).run()
    }
  }

  // Log to ledger
  await logAction(env.HOBBOT_DB, {
    action_type: 'agent_run',
    topic_key: 'archive-org-agent',
    payload: { claimed: claimed.length, searched: totalSearched, queued: totalQueued },
    status: errors.length > 0 ? 'partial' : 'complete',
    completed_at: new Date().toISOString(),
  }).catch(e => console.warn(`[archive-org] ledger: ${e}`))

  return { claimed: claimed.length, searched: totalSearched, queued: totalQueued, errors }
}
