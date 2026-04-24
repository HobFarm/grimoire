// Phase 1: Grok X Search signal gathering.

import type { HobBotAgent } from '../agent'
import { callWithFallback, buildModelContext } from '../providers'
import type { CallWithFallbackOptions } from '../providers/types'
import { SIGNAL_QUERIES, buildSignalPrompt } from '../prompts/signal'
import { tryParseJson } from '../utils/json'

export interface Signal {
  id: string
  source: string
  signal_type: string
  data: string
  relevance_score: number
  expires_at: string
}

/**
 * Gather audience signals from X Search via Grok.
 * Returns cached signals if Grok is unavailable (onAllFail: skip).
 */
export async function gatherSignals(agent: HobBotAgent, options?: CallWithFallbackOptions): Promise<Signal[]> {
  const ctx = buildModelContext(agent.bindings, agent.secrets)
  const signals: Signal[] = []

  // Pick 2-3 random queries per run to avoid repetition
  const shuffled = [...SIGNAL_QUERIES].sort(() => Math.random() - 0.5)
  const queries = shuffled.slice(0, 3)

  for (const query of queries) {
    const prompt = buildSignalPrompt(query)
    const result = await callWithFallback(ctx, 'signal', prompt, options)

    if (!result) {
      console.log(`[signals] Grok unavailable for query: ${query}`)
      continue
    }

    const parsed = tryParseJson<{
      trending_topics?: string[]
      high_engagement_themes?: string[]
      visual_trends?: string[]
      relevance_to_atomic_noir?: number
      summary?: string
    }>(result.result)

    if (parsed) {
      const signal: Signal = {
        id: crypto.randomUUID(),
        source: 'x_search',
        signal_type: 'trending_topic',
        data: JSON.stringify(parsed),
        relevance_score: parsed.relevance_to_atomic_noir ?? 0.5,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }
      signals.push(signal)

      agent.sql`INSERT OR REPLACE INTO signals (id, source, signal_type, data, relevance_score, expires_at)
        VALUES (${signal.id}, ${signal.source}, ${signal.signal_type}, ${signal.data}, ${signal.relevance_score}, ${signal.expires_at})`
    }
  }

  // If no fresh signals, return cached from last 24 hours
  if (signals.length === 0) {
    const cached = agent.sql<Signal>`SELECT * FROM signals
      WHERE expires_at > datetime('now')
      ORDER BY relevance_score DESC
      LIMIT 10`
    return cached
  }

  return signals
}
