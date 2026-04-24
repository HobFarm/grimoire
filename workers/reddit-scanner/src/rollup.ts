// Daily trend rollup: 7-day topic aggregation with velocity computation

import type { Env, DailyTrend, TrendEntry } from './types'
import { storeTrend } from './storage'

interface TopicRow {
  topic: string
  subreddit: string
  sentiment: string
  intensity: number
  pain_points: string | null
  feature_requests: string | null
  scan_date: string
}

function safeJsonArray(val: string | null): string[] {
  if (!val) return []
  try { return JSON.parse(val) as string[] } catch { return [] }
}

/**
 * Run daily trend rollup.
 * Queries D1 for all topic_signals from the last 7 days, groups by topic,
 * computes velocity against the prior 7-day window, stores result to R2.
 * Biggest D1 read in the system (~1400 + ~1400 rows), but runs once daily.
 */
export async function runDailyRollup(env: Env): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().split('T')[0]

  // Current 7-day window: full rows for aggregation
  const current = await env.REDDIT_SCANNER_DB.prepare(
    `SELECT topic, subreddit, sentiment, intensity, pain_points, feature_requests, scan_date
     FROM topic_signals
     WHERE scan_date >= date('now', '-7 days')
     ORDER BY scan_date DESC`
  ).all<TopicRow>()

  // Prior 7-day window: just topic counts for velocity
  const prior = await env.REDDIT_SCANNER_DB.prepare(
    `SELECT topic, COUNT(*) as mentions
     FROM topic_signals
     WHERE scan_date >= date('now', '-14 days') AND scan_date < date('now', '-7 days')
     GROUP BY topic`
  ).all<{ topic: string; mentions: number }>()

  const priorMentions = new Map<string, number>()
  for (const row of (prior.results ?? [])) {
    priorMentions.set(row.topic, row.mentions)
  }

  // Group current window by topic
  const topicMap = new Map<string, {
    mentions: number
    sentiments: Map<string, number>
    subreddits: Set<string>
    painPoints: Set<string>
    featureRequests: Set<string>
    firstSeen: string
    totalIntensity: number
  }>()

  for (const row of (current.results ?? [])) {
    const existing = topicMap.get(row.topic)
    if (existing) {
      existing.mentions++
      existing.sentiments.set(row.sentiment, (existing.sentiments.get(row.sentiment) ?? 0) + 1)
      existing.subreddits.add(row.subreddit)
      existing.totalIntensity += row.intensity
      for (const pp of safeJsonArray(row.pain_points)) existing.painPoints.add(pp)
      for (const fr of safeJsonArray(row.feature_requests)) existing.featureRequests.add(fr)
      if (row.scan_date < existing.firstSeen) existing.firstSeen = row.scan_date
    } else {
      topicMap.set(row.topic, {
        mentions: 1,
        sentiments: new Map([[row.sentiment, 1]]),
        subreddits: new Set([row.subreddit]),
        painPoints: new Set(safeJsonArray(row.pain_points)),
        featureRequests: new Set(safeJsonArray(row.feature_requests)),
        firstSeen: row.scan_date,
        totalIntensity: row.intensity,
      })
    }
  }

  // Build trend entries
  const topics: TrendEntry[] = Array.from(topicMap.entries())
    .map(([topic, data]) => {
      const priorCount = priorMentions.get(topic) ?? 0
      const velocity = data.mentions - priorCount // positive = growing, negative = fading

      return {
        topic,
        total_mentions: data.mentions,
        sentiment_breakdown: Object.fromEntries(data.sentiments),
        velocity,
        subreddits: Array.from(data.subreddits),
        top_pain_points: Array.from(data.painPoints).slice(0, 10),
        top_feature_requests: Array.from(data.featureRequests).slice(0, 5),
        first_seen: data.firstSeen,
      }
    })
    .sort((a, b) => b.total_mentions - a.total_mentions)

  const trend: DailyTrend = { date: today, topics }
  await storeTrend(env, trend)

  console.log(`[rollup] ${today}: ${topics.length} topics, ${current.results?.length ?? 0} signals from 7-day window`)
  return { date: today, topics: topics.length, signals: current.results?.length ?? 0 }
}
