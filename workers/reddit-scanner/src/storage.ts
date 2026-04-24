// R2 read/write helpers and D1 topic_signals operations

import type { Env, ScanResult, ScanExtraction, DailyTrend, TopicSignal } from './types'

// --- Date helpers ---

function formatDate(date?: Date): string {
  const d = date ?? new Date()
  return d.toISOString().split('T')[0]
}

// --- R2 Operations ---

export async function storeRawScan(env: Env, scan: ScanResult): Promise<string> {
  const date = formatDate(new Date(scan.timestamp * 1000))
  const key = `scans/${date}/${scan.subreddit}-${scan.sort}-${scan.timestamp}.json`
  await env.REDDIT_SCANS.put(key, JSON.stringify(scan), {
    httpMetadata: { contentType: 'application/json' },
  })
  console.log(`[storage] Raw scan stored: ${key} (${scan.posts.length} posts)`)
  return key
}

export async function storeExtraction(env: Env, extraction: ScanExtraction): Promise<string> {
  const ts = Math.floor(new Date(extraction.scan_timestamp).getTime() / 1000)
  const key = `extractions/${extraction.scan_date}/${extraction.subreddit}-${ts}.json`
  await env.REDDIT_SCANS.put(key, JSON.stringify(extraction), {
    httpMetadata: { contentType: 'application/json' },
  })
  console.log(`[storage] Extraction stored: ${key} (${extraction.topics.length} topics)`)
  return key
}

export async function storeTrend(env: Env, trend: DailyTrend): Promise<string> {
  const key = `trends/${trend.date}.json`
  await env.REDDIT_SCANS.put(key, JSON.stringify(trend), {
    httpMetadata: { contentType: 'application/json' },
  })
  console.log(`[storage] Trend stored: ${key} (${trend.topics.length} topics)`)
  return key
}

export async function getLatestTrend(env: Env, date: string): Promise<DailyTrend | null> {
  const key = `trends/${date}.json`
  const obj = await env.REDDIT_SCANS.get(key)
  if (!obj) return null
  return (await obj.json()) as DailyTrend
}

// --- D1 Operations ---

export async function insertTopicSignals(db: D1Database, extraction: ScanExtraction): Promise<number> {
  if (extraction.topics.length === 0) return 0

  const statements = extraction.topics.map(topic =>
    db.prepare(
      `INSERT INTO topic_signals (topic, subreddit, sentiment, intensity, pain_points, feature_requests, tools_mentioned, sample_post_ids, scan_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      topic.topic,
      extraction.subreddit,
      topic.sentiment,
      topic.intensity,
      JSON.stringify(topic.pain_points),
      JSON.stringify(topic.feature_requests),
      JSON.stringify(topic.tools_mentioned),
      JSON.stringify(topic.sample_post_ids),
      extraction.scan_date,
    )
  )

  await db.batch(statements)
  console.log(`[storage] Inserted ${statements.length} topic signals for ${extraction.subreddit}`)
  return statements.length
}

export async function querySignalsBySubreddit(
  db: D1Database,
  subreddit: string,
  days: number,
): Promise<TopicSignal[]> {
  const result = await db.prepare(
    `SELECT topic, subreddit, sentiment, intensity, pain_points, feature_requests, tools_mentioned, sample_post_ids, scan_date
     FROM topic_signals
     WHERE subreddit = ? AND scan_date >= date('now', '-' || ? || ' days')
     ORDER BY scan_date DESC, intensity DESC
     LIMIT 100`
  ).bind(subreddit, days).all()

  return (result.results ?? []).map(parseSignalRow)
}

export async function querySignalsByTopic(
  db: D1Database,
  query: string,
  days: number,
): Promise<TopicSignal[]> {
  const result = await db.prepare(
    `SELECT topic, subreddit, sentiment, intensity, pain_points, feature_requests, tools_mentioned, sample_post_ids, scan_date
     FROM topic_signals
     WHERE topic LIKE ? AND scan_date >= date('now', '-' || ? || ' days')
     ORDER BY scan_date DESC, intensity DESC
     LIMIT 100`
  ).bind(`%${query}%`, days).all()

  return (result.results ?? []).map(parseSignalRow)
}

function parseSignalRow(row: Record<string, unknown>): TopicSignal {
  return {
    topic: String(row.topic),
    sentiment: String(row.sentiment) as TopicSignal['sentiment'],
    intensity: Number(row.intensity),
    pain_points: safeJsonArray(row.pain_points),
    feature_requests: safeJsonArray(row.feature_requests),
    tools_mentioned: safeJsonArray(row.tools_mentioned),
    sample_post_ids: safeJsonArray(row.sample_post_ids),
  }
}

function safeJsonArray(val: unknown): string[] {
  if (!val || typeof val !== 'string') return []
  try { return JSON.parse(val) as string[] } catch { return [] }
}
