// Phase 2: AI Search knowledge retrieval from R2-backed RAG.

import type { HobBotAgent } from '../agent'

export interface KnowledgeResult {
  answer: string
  sources?: string[]
}

/**
 * Retrieve knowledge from AI Search (hobbot-knowledge R2 bucket).
 * Caches results in knowledge_cache table (1 hour TTL).
 * Falls back to cached results if AI Search is unavailable.
 */
export async function retrieveKnowledge(
  agent: HobBotAgent,
  theme: string,
  signalContext?: string
): Promise<KnowledgeResult | null> {
  const query = signalContext
    ? `${theme}. Context: ${signalContext}`
    : theme

  // Check cache first
  const cached = agent.sql<{ result: string }>`SELECT result FROM knowledge_cache
    WHERE query = ${query} AND expires_at > datetime('now')`
  if (cached.length > 0) {
    return JSON.parse(cached[0].result) as KnowledgeResult
  }

  try {
    // AI Search query via autorag binding
    const searchResult = await (agent.bindings.AI as unknown as {
      autorag: (name: string) => { aiSearch: (opts: { query: string }) => Promise<{ response: string }> }
    }).autorag('hobbot-knowledge').aiSearch({ query })

    const result: KnowledgeResult = {
      answer: searchResult.response,
    }

    // Cache with 1 hour TTL
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    agent.sql`INSERT OR REPLACE INTO knowledge_cache (query, result, expires_at)
      VALUES (${query}, ${JSON.stringify(result)}, ${expiresAt})`

    return result
  } catch (e) {
    console.log(`[knowledge] AI Search failed: ${e instanceof Error ? e.message : String(e)}`)

    // Fall back to any cached result for similar query
    const fallback = agent.sql<{ result: string }>`SELECT result FROM knowledge_cache
      WHERE query LIKE ${'%' + theme.split(' ')[0] + '%'}
      ORDER BY created_at DESC LIMIT 1`
    if (fallback.length > 0) {
      return JSON.parse(fallback[0].result) as KnowledgeResult
    }

    return null
  }
}
