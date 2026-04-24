// Conductor: gap analysis + knowledge request generation
// Runs on custodian's 6h cron. Queries Grimoire for thin arrangement/category pairs,
// uses AI to translate gaps into search intents, writes prioritized knowledge_requests.

import { logAction } from '@shared/ledger'
import { callWithJsonParse, type GatewayConfig, type CallOptions } from '@shared/providers/call-with-json-parse'
import { resolveApiKey, createTokenLogger } from '@shared/providers'
import { MODELS } from '@shared/models'
import { createLogger } from '@shared/logger'

const log = createLogger('hobbot-custodian')

interface ConductorEnv {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  AI: Ai
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  PROVIDER_HEALTH?: KVNamespace
  AI_GATEWAY_ACCOUNT_ID?: string
  AI_GATEWAY_NAME?: string
  AI_GATEWAY_TOKEN?: string | { get: () => Promise<string> }
}

export interface ConductorResult {
  gaps: number
  created: number
  stale_released: number
  completed: number
  errors: string[]
}

interface ArrangementGap {
  slug: string
  name: string
  description: string | null
  harmonic_ranges: Record<string, number[]> | null
  total_atoms: number
  thin_categories: { slug: string; name: string; count: number }[]
  request_type: 'baseline' | 'gap_fill' | 'deepen'
  priority: number
}

const MAX_REQUESTS_PER_RUN = 5
const MAX_PENDING_PER_AGENT = 10

// Step 1: Release stale claims (>2h uncompleted)
async function releaseStale(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `UPDATE knowledge_requests
     SET status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE status = 'claimed'
       AND claimed_at < datetime('now', '-2 hours')`
  ).run()
  return result.meta.changes ?? 0
}

// Step 2: Complete requests where all feed_entries are done
async function completeFinished(grimoireDb: D1Database, hobbotDb: D1Database): Promise<number> {
  const { results: ingesting } = await hobbotDb.prepare(
    `SELECT kr.id
     FROM knowledge_requests kr
     WHERE kr.status = 'ingesting'
       AND NOT EXISTS (
         SELECT 1 FROM feed_entries fe
         WHERE fe.knowledge_request_id = kr.id
           AND fe.extraction_status NOT IN ('complete', 'failed')
       )`
  ).all<{ id: number }>()

  if (!ingesting || ingesting.length === 0) return 0

  let completed = 0
  for (const kr of ingesting) {
    // Count results from feed_entries linked to this request
    const counts = await hobbotDb.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN extraction_status = 'complete' THEN 1 ELSE 0 END) as succeeded,
         SUM(CASE WHEN extraction_status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM feed_entries WHERE knowledge_request_id = ?`
    ).bind(kr.id).first<{ total: number; succeeded: number; failed: number }>()

    await hobbotDb.prepare(
      `UPDATE knowledge_requests
       SET status = 'complete',
           completed_at = datetime('now'),
           result_notes = ?
       WHERE id = ?`
    ).bind(
      `Completed: ${counts?.succeeded ?? 0} succeeded, ${counts?.failed ?? 0} failed of ${counts?.total ?? 0} items`,
      kr.id
    ).run()
    completed++
  }
  return completed
}

// Step 3: Check queue depth per source_agent
async function getQueueDepth(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare(
    `SELECT
       COALESCE(source_agent, '_any') as agent,
       COUNT(*) as cnt
     FROM knowledge_requests
     WHERE status IN ('pending', 'claimed', 'searching')
     GROUP BY source_agent`
  ).all<{ agent: string; cnt: number }>()

  const depth: Record<string, number> = { archive_org: 0, getty: 0, _any: 0 }
  for (const row of results ?? []) {
    depth[row.agent] = row.cnt
  }
  // Null-routed requests count against all agents
  depth.archive_org += depth._any
  depth.getty += depth._any
  return depth
}

// Step 4: Gap analysis
async function analyzeGaps(grimoireDb: D1Database): Promise<ArrangementGap[]> {
  const gaps: ArrangementGap[] = []

  // 4a: Arrangements with no document_chunks (baseline candidates)
  const { results: noDocArrangements } = await grimoireDb.prepare(
    `SELECT a.slug, a.name, a.description
     FROM arrangements a
     WHERE NOT EXISTS (
       SELECT 1 FROM document_chunks dc
       WHERE dc.arrangement_slugs LIKE '%' || a.slug || '%'
     )
     ORDER BY a.name
     LIMIT 10`
  ).all<{ slug: string; name: string; description: string | null }>()

  for (const arr of noDocArrangements ?? []) {
    gaps.push({
      slug: arr.slug,
      name: arr.name,
      description: arr.description,
      harmonic_ranges: null,
      total_atoms: 0,
      thin_categories: [],
      request_type: 'baseline',
      priority: 0.9,
    })
  }

  // 4b: Category coverage per arrangement (gap_fill candidates)
  const { results: coverage } = await grimoireDb.prepare(
    `SELECT
       aa.arrangement_slug,
       a.category_slug,
       COUNT(*) as atom_count
     FROM arrangement_atoms aa
     JOIN atoms a ON aa.atom_id = a.id
     WHERE a.status = 'confirmed'
     GROUP BY aa.arrangement_slug, a.category_slug`
  ).all<{ arrangement_slug: string; category_slug: string; atom_count: number }>()

  // Build coverage map: arrangement -> category -> count
  const coverageMap = new Map<string, Map<string, number>>()
  for (const row of coverage ?? []) {
    if (!coverageMap.has(row.arrangement_slug)) coverageMap.set(row.arrangement_slug, new Map())
    coverageMap.get(row.arrangement_slug)!.set(row.category_slug, row.atom_count)
  }

  // Find arrangements with thin categories (< 20 atoms in important categories)
  const importantCategories = [
    'covering.material', 'style.medium', 'style.genre', 'color.palette',
    'covering.clothing', 'environment.setting', 'narrative.concept',
  ]

  // Get arrangement metadata for enriching prompts
  const { results: arrangements } = await grimoireDb.prepare(
    `SELECT slug, name, description FROM arrangements ORDER BY slug`
  ).all<{ slug: string; name: string; description: string | null }>()

  for (const arr of arrangements ?? []) {
    const catMap = coverageMap.get(arr.slug)
    if (!catMap) continue // Already handled as baseline if no docs

    const thinCats: { slug: string; name: string; count: number }[] = []
    for (const cat of importantCategories) {
      const count = catMap.get(cat) ?? 0
      if (count < 20) {
        thinCats.push({ slug: cat, name: cat, count })
      }
    }

    if (thinCats.length >= 2) {
      const totalAtoms = Array.from(catMap.values()).reduce((sum, n) => sum + n, 0)
      gaps.push({
        slug: arr.slug,
        name: arr.name,
        description: arr.description,
        harmonic_ranges: null,
        total_atoms: totalAtoms,
        thin_categories: thinCats,
        request_type: totalAtoms < 50 ? 'baseline' : 'gap_fill',
        priority: totalAtoms < 50 ? 0.8 : 0.7,
      })
    }
  }

  return gaps
}

// Step 5: Dedup against existing requests
async function filterDuplicates(db: D1Database, gaps: ArrangementGap[]): Promise<ArrangementGap[]> {
  const { results: existing } = await db.prepare(
    `SELECT target_arrangements, target_categories
     FROM knowledge_requests
     WHERE status IN ('pending', 'claimed', 'searching', 'ingesting')`
  ).all<{ target_arrangements: string | null; target_categories: string | null }>()

  const existingSlugs = new Set<string>()
  for (const row of existing ?? []) {
    try {
      const arrs = JSON.parse(row.target_arrangements ?? '[]') as string[]
      for (const a of arrs) existingSlugs.add(a)
    } catch {}
  }

  return gaps.filter(g => !existingSlugs.has(g.slug))
}

// Step 6: AI intent translation
const INTENT_SYSTEM_PROMPT = `You translate knowledge gap data into targeted search intents for finding public domain texts.

Respond with JSON: { "search_intent": "...", "source_agent": "archive_org" | "getty" | null }
- source_agent "archive_org" for books and catalogs (depth content)
- source_agent "getty" for vocabulary and terminology (AAT cross-reference)
- source_agent null if either source could help`

async function generateSearchIntent(
  ai: Ai,
  geminiKey: string,
  gap: ArrangementGap,
  exemplars: string[],
  health?: KVNamespace,
  gateway?: GatewayConfig,
  onUsage?: CallOptions['onUsage'],
): Promise<{ search_intent: string; source_agent: string | null }> {
  const thinCatDesc = gap.thin_categories.length > 0
    ? `Thin categories: ${gap.thin_categories.map(c => `${c.slug} (${c.count} atoms)`).join(', ')}`
    : 'No category-level data available (baseline needed)'

  const exemplarBlock = exemplars.length > 0
    ? `\nExamples of good atoms in these categories from other arrangements: ${exemplars.join('; ')}`
    : ''

  const userContent = `Arrangement: "${gap.name}" ${gap.description ? `- ${gap.description}` : ''}
Total atoms: ${gap.total_atoms}
${thinCatDesc}${exemplarBlock}

Request type: ${gap.request_type}
${gap.request_type === 'baseline'
    ? 'Generate a broad search intent to establish foundational knowledge: key practitioners, materials, techniques, regional variations, relationship to adjacent movements.'
    : 'Generate a focused search intent for finding specific vocabulary about materials, techniques, practitioners, and physical properties. NOT general historical narrative. We need terms that describe how things look, feel, and are made.'}`

  try {
    const { result, modelUsed } = await callWithJsonParse<{ search_intent?: string; source_agent?: string | null }>(
      'conductor.intent', INTENT_SYSTEM_PROMPT, userContent, ai, geminiKey,
      MODELS['custodian.intent'],
      { health, gateway, onUsage },
    )
    log.info('intent generated', { model: modelUsed })
    return {
      search_intent: result.search_intent ?? `Find content about ${gap.name}`,
      source_agent: result.source_agent ?? null,
    }
  } catch {
    // All models failed: construct a meaningful fallback
    const desc = gap.description ? ` (${gap.description})` : ''
    const catList = gap.thin_categories.length > 0
      ? `: ${gap.thin_categories.map(c => c.slug).join(', ')}`
      : `: key practitioners, materials, techniques, regional variations`
    return {
      search_intent: `Establish foundational knowledge of ${gap.name}${desc}${catList}`,
      source_agent: null,
    }
  }
}

// Get exemplar atoms for thin categories (from well-covered arrangements)
async function getExemplars(grimoireDb: D1Database, categories: string[]): Promise<string[]> {
  if (categories.length === 0) return []

  const exemplars: string[] = []
  for (const cat of categories.slice(0, 3)) {
    const { results } = await grimoireDb.prepare(
      `SELECT a.text
       FROM atoms a
       WHERE a.category_slug = ? AND a.status = 'confirmed'
       ORDER BY RANDOM()
       LIMIT 2`
    ).bind(cat).all<{ text: string }>()

    for (const row of results ?? []) {
      exemplars.push(`${cat}: "${row.text}"`)
    }
  }
  return exemplars
}

export async function runConductor(env: ConductorEnv): Promise<ConductorResult> {
  const errors: string[] = []
  let created = 0

  // Step 1: Release stale claims
  const staleReleased = await releaseStale(env.HOBBOT_DB)
  if (staleReleased > 0) {
    log.info('released stale claims', { count: staleReleased })
  }

  // Step 2: Complete finished requests
  const completed = await completeFinished(env.GRIMOIRE_DB, env.HOBBOT_DB)
  if (completed > 0) {
    log.info('completed requests', { count: completed })
  }

  // Step 3: Check queue depth per agent
  const depth = await getQueueDepth(env.HOBBOT_DB)
  const allFull = depth.archive_org >= MAX_PENDING_PER_AGENT && depth.getty >= MAX_PENDING_PER_AGENT
  if (allFull) {
    console.log(`[conductor] all agent queues full (archive_org=${depth.archive_org} getty=${depth.getty}), skipping gap analysis`)
    return { gaps: 0, created: 0, stale_released: staleReleased, completed, errors }
  }

  // Step 4: Gap analysis
  const allGaps = await analyzeGaps(env.GRIMOIRE_DB)
  log.info('gap analysis complete', { raw_gaps: allGaps.length })

  // Step 5: Dedup
  const gaps = await filterDuplicates(env.HOBBOT_DB, allGaps)
  log.info('gaps after dedup', { count: gaps.length })

  if (gaps.length === 0) {
    return { gaps: 0, created: 0, stale_released: staleReleased, completed, errors }
  }

  // Sort by priority and take top N
  gaps.sort((a, b) => b.priority - a.priority)
  const toProcess = gaps.slice(0, MAX_REQUESTS_PER_RUN)

  // Resolve Gemini API key (needed for fallback chain)
  let apiKey: string
  try {
    apiKey = await resolveApiKey(env.GEMINI_API_KEY)
  } catch (e) {
    errors.push(`Failed to resolve GEMINI_API_KEY: ${e instanceof Error ? e.message : e}`)
    return { gaps: gaps.length, created: 0, stale_released: staleReleased, completed, errors }
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

  // Step 6: Generate intents and create requests
  for (const gap of toProcess) {
    try {
      // Get exemplar atoms for the thin categories
      const exemplars = await getExemplars(
        env.GRIMOIRE_DB,
        gap.thin_categories.map(c => c.slug),
      )

      const { search_intent, source_agent } = await generateSearchIntent(env.AI, apiKey, gap, exemplars, env.PROVIDER_HEALTH, gateway, createTokenLogger(env.HOBBOT_DB, 'hobbot-custodian'))

      // Check agent-specific queue depth
      const agentKey = source_agent ?? '_any'
      if (source_agent === 'archive_org' && depth.archive_org >= MAX_PENDING_PER_AGENT) continue
      if (source_agent === 'getty' && depth.getty >= MAX_PENDING_PER_AGENT) continue

      await env.HOBBOT_DB.prepare(
        `INSERT INTO knowledge_requests
           (request_type, target_arrangements, target_categories, search_intent, priority, source_agent)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        gap.request_type,
        JSON.stringify([gap.slug]),
        JSON.stringify(gap.thin_categories.map(c => c.slug)),
        search_intent,
        gap.priority,
        source_agent,
      ).run()

      created++
      // Track depth for subsequent iterations
      if (source_agent) {
        depth[source_agent] = (depth[source_agent] ?? 0) + 1
      } else {
        depth.archive_org++
        depth.getty++
      }

      console.log(`[conductor] created request: ${gap.request_type} for ${gap.slug} -> ${source_agent ?? 'any'}: "${search_intent.slice(0, 80)}..."`)
    } catch (e) {
      const msg = `Failed to process gap ${gap.slug}: ${e instanceof Error ? e.message : e}`
      errors.push(msg)
      console.warn(`[conductor] ${msg}`)
    }
  }

  // Log to ledger
  await logAction(env.HOBBOT_DB, {
    action_type: 'conductor_run',
    topic_key: 'knowledge-agent-swarm',
    payload: { gaps: gaps.length, created, stale_released: staleReleased, completed },
    status: errors.length > 0 ? 'partial' : 'complete',
    completed_at: new Date().toISOString(),
  }).catch(e => console.warn(`[conductor] ledger: ${e}`))

  return { gaps: gaps.length, created, stale_released: staleReleased, completed, errors }
}
