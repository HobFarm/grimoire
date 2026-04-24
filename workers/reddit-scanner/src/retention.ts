// Cleanup cron: delete expired D1 rows and R2 objects

import type { Env } from './types'
import {
  RETENTION_D1_DAYS,
  RETENTION_R2_SCANS_DAYS,
  RETENTION_R2_EXTRACTIONS_DAYS,
  RETENTION_R2_TRENDS_DAYS,
} from './config'

export interface RetentionResult {
  d1Deleted: number
  r2Scans: number
  r2Extractions: number
  r2Trends: number
}

/**
 * Run retention cleanup.
 * - D1: delete topic_signals older than 30 days
 * - R2: delete scans (14d), extractions (30d), trends (90d)
 */
export async function runRetention(env: Env): Promise<Record<string, unknown>> {
  const result: RetentionResult = { d1Deleted: 0, r2Scans: 0, r2Extractions: 0, r2Trends: 0 }

  // D1 cleanup
  const d1Result = await env.REDDIT_SCANNER_DB.prepare(
    `DELETE FROM topic_signals WHERE scan_date < date('now', '-${RETENTION_D1_DAYS} days')`
  ).run()
  result.d1Deleted = d1Result.meta?.changes ?? 0
  console.log(`[retention] D1: deleted ${result.d1Deleted} rows older than ${RETENTION_D1_DAYS} days`)

  // R2 cleanup by prefix
  result.r2Scans = await cleanR2Prefix(env.REDDIT_SCANS, 'scans/', RETENTION_R2_SCANS_DAYS)
  result.r2Extractions = await cleanR2Prefix(env.REDDIT_SCANS, 'extractions/', RETENTION_R2_EXTRACTIONS_DAYS)
  result.r2Trends = await cleanR2Prefix(env.REDDIT_SCANS, 'trends/', RETENTION_R2_TRENDS_DAYS)

  console.log(`[retention] R2: scans=${result.r2Scans}, extractions=${result.r2Extractions}, trends=${result.r2Trends}`)
  return result as unknown as Record<string, unknown>
}

/**
 * List R2 objects under a prefix, parse the date from the key path, delete expired objects.
 * Key patterns:
 *   scans/{YYYY-MM-DD}/{sub}-{sort}-{ts}.json
 *   extractions/{YYYY-MM-DD}/{sub}-{ts}.json
 *   trends/{YYYY-MM-DD}.json
 */
async function cleanR2Prefix(bucket: R2Bucket, prefix: string, retentionDays: number): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  let deleted = 0
  let cursor: string | undefined

  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 })

    const toDelete: string[] = []
    for (const obj of listed.objects) {
      const dateMatch = obj.key.match(/\/(\d{4}-\d{2}-\d{2})/)
      if (dateMatch && dateMatch[1] < cutoffStr) {
        toDelete.push(obj.key)
      }
    }

    // R2 delete supports up to 1000 keys per call
    if (toDelete.length > 0) {
      await bucket.delete(toDelete)
      deleted += toDelete.length
    }

    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  return deleted
}
