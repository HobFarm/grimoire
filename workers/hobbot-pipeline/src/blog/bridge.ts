// RSS→Queue Bridge: scans feed_entries for high-relevance items,
// validates Grimoire connections, and auto-inserts qualifying entries into blog_queue.

import type { Env } from '../index'
import type { BridgeResult, GrimoireMatch } from './types'

// Aesthetic arrangement slugs that map to HobFarm project areas
const STYLEFUSION_ARRANGEMENTS = [
  'atomic-noir', 'art-deco', 'art-nouveau', 'cyberpunk', 'synthwave',
  'vaporwave', 'noir', 'steampunk', 'solarpunk', 'brutalism',
  'psychedelic', 'editorial-fashion', 'pin-up-retro',
]
const GRIMOIRE_ARRANGEMENTS = [
  'dark-academia', 'gothic', 'ethereal-fantasy', 'fantasy',
  'mesoamerican', 'ukiyo-e', 'botanical-plate',
]

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'for', 'in', 'on', 'to',
  'and', 'or', 'but', 'with', 'by', 'at', 'from', 'this', 'that', 'it', 'its',
  'as', 'be', 'has', 'have', 'had', 'not', 'will', 'can', 'do', 'if', 'so',
  'no', 'up', 'out', 'how', 'what', 'why', 'when', 'who', 'new', 'more',
  'most', 'very', 'also', 'just', 'than', 'then',
])

// AI/ML and creative tools keywords for category heuristic
const TECHNICAL_KEYWORDS = [
  'ai', 'ml', 'model', 'neural', 'llm', 'gpt', 'diffusion', 'transformer',
  'api', 'sdk', 'framework', 'algorithm', 'training', 'inference', 'pipeline',
  'automation', 'tool', 'tools', 'platform', 'software', 'engineering',
  'flux', 'stable', 'gpu', 'nvidia', 'scaling', 'accelerat',
]

const CULTURAL_KEYWORDS = [
  'art', 'design', 'aesthetic', 'visual', 'culture', 'style', 'fashion',
  'architecture', 'typography', 'color', 'photography', 'illustration',
  'craft', 'museum', 'gallery', 'exhibition', 'creative', 'painting',
  'history', 'artist',
]

export function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[\s\-_,.;:!?()\[\]{}"'`\/\\|@#$%^&*+=<>~]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 8)
}

/**
 * Check Grimoire connection via document chunks if a grimoire_source_id exists.
 * Falls back to arrangement_slugs on chunks. If no enriched data exists,
 * returns a minimal match: the document exists (atom connection is implied).
 */
async function checkGrimoireDocument(
  grimoireSourceId: string,
  grimoireDb: D1Database
): Promise<GrimoireMatch> {
  // Verify document exists in Grimoire
  const doc = await grimoireDb
    .prepare('SELECT id, title, status FROM documents WHERE id = ?')
    .bind(grimoireSourceId)
    .first<{ id: string; title: string; status: string }>()

  if (!doc) {
    return { atomCount: 0, arrangements: [], topAtoms: [], score: 0 }
  }

  // Check chunks for arrangement data via join table (primary), JSON fallback
  const joinResult = await grimoireDb
    .prepare(
      `SELECT DISTINCT ac.arrangement_slug FROM arrangement_chunks ac
       JOIN document_chunks dc ON dc.id = ac.chunk_id
       WHERE dc.document_id = ?`
    )
    .bind(grimoireSourceId)
    .all<{ arrangement_slug: string }>()

  const arrangementSet = new Set<string>()
  if (joinResult.results && joinResult.results.length > 0) {
    for (const row of joinResult.results) arrangementSet.add(row.arrangement_slug)
  } else {
    // Fallback: read from JSON column
    const chunks = await grimoireDb
      .prepare('SELECT arrangement_slugs FROM document_chunks WHERE document_id = ?')
      .bind(grimoireSourceId)
      .all<{ arrangement_slugs: string }>()
    for (const chunk of chunks.results ?? []) {
      try {
        const slugs = JSON.parse(chunk.arrangement_slugs || '[]') as string[]
        slugs.forEach(s => arrangementSet.add(s))
      } catch { /* skip malformed JSON */ }
    }
  }

  const arrangements = [...arrangementSet]

  // Get chunk count for atomCount field
  const chunkCount = await grimoireDb
    .prepare('SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?')
    .bind(grimoireSourceId)
    .first<{ cnt: number }>()

  // Document exists in Grimoire: that's the connection.
  // Score reflects document presence + any arrangement enrichment.
  return {
    atomCount: chunkCount?.cnt ?? 0,
    arrangements,
    topAtoms: [{ slug: doc.id, label: doc.title, category: doc.status }],
    score: arrangements.length > 0 ? 1.0 : 0.6,
  }
}

export function mapCategory(match: GrimoireMatch, entryTitle: string): string {
  // Priority 1: arrangement-based mapping to HobFarm project areas
  for (const arr of match.arrangements) {
    if (STYLEFUSION_ARRANGEMENTS.includes(arr)) return 'stylefusion'
    if (GRIMOIRE_ARRANGEMENTS.includes(arr)) return 'grimoire'
  }

  // Priority 2: keyword heuristic on the entry title
  const lower = entryTitle.toLowerCase()

  if (TECHNICAL_KEYWORDS.some(kw => lower.includes(kw))) return 'technical'
  if (CULTURAL_KEYWORDS.some(kw => lower.includes(kw))) return 'cultural-thread'

  // Default fallback
  return 'business'
}

export async function runBridge(env: Env): Promise<BridgeResult> {
  const result: BridgeResult = { candidatesScanned: 0, qualified: 0, queued: 0, skipped: 0 }

  // Query candidates: high-relevance, ingested, not already in blog_queue
  const candidates = await env.HOBBOT_DB.prepare(`
    SELECT * FROM feed_entries
    WHERE relevance_score >= 0.5
      AND ingested = 1
      AND id NOT IN (
        SELECT CAST(source_ref AS INTEGER) FROM blog_queue
        WHERE content_type = 'rss_analysis'
      )
    ORDER BY relevance_score DESC
    LIMIT 10
  `).all<{
    id: number
    entry_title: string
    entry_url: string
    relevance_score: number
    grimoire_source_id: string | null
  }>()

  const rows = candidates.results ?? []
  result.candidatesScanned = rows.length

  if (rows.length === 0) {
    console.log('[bridge] no candidates found')
    return result
  }

  for (const entry of rows) {
    // Primary gate: grimoire_source_id must exist.
    // The RSS ingestion pipeline already validated the Grimoire connection
    // when it set this field and computed the relevance score.
    if (!entry.grimoire_source_id) {
      result.skipped++
      continue
    }

    // Check the Grimoire document for additional arrangement data
    const match = await checkGrimoireDocument(entry.grimoire_source_id, env.GRIMOIRE_DB)

    // Secondary gate: the document must still exist in Grimoire
    if (match.score === 0) {
      result.skipped++
      continue
    }

    result.qualified++

    // Determine category from arrangement data or keyword heuristics
    const category = mapCategory(match, entry.entry_title)

    try {
      await env.HOBBOT_DB.prepare(`
        INSERT INTO blog_queue (content_type, source_ref, category, channel, status)
        VALUES ('rss_analysis', ?, ?, 'blog', 'queued')
      `).bind(String(entry.id), category).run()

      result.queued++
      console.log(`[bridge] queued entry=${entry.id} title="${entry.entry_title}" category=${category} score=${match.score.toFixed(2)}`)
    } catch (e) {
      console.log(`[bridge] insert failed for entry=${entry.id}: ${e instanceof Error ? e.message : e}`)
      result.skipped++
      result.qualified--
    }
  }

  return result
}
