// Maintenance operations: purge stale logs, clear expired cache entries

import { CLEANUP } from '@shared/config'

export async function purgeOldUsageLogs(db: D1Database): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - CLEANUP.USAGE_LOG_RETENTION_DAYS)

  const result = await db.prepare(
    'DELETE FROM usage_log WHERE created_at < ?'
  ).bind(cutoff.toISOString()).run()

  const deleted = result.meta?.changes ?? 0
  if (deleted > 0) console.log(`cleanup_usage_log: deleted=${deleted}`)
  return deleted
}

export async function purgeOldScanHistory(db: D1Database): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - CLEANUP.SCAN_HISTORY_RETENTION_DAYS)

  const result = await db.prepare(
    'DELETE FROM integrity_scans WHERE created_at < ?'
  ).bind(cutoff.toISOString()).run()

  const deleted = result.meta?.changes ?? 0
  if (deleted > 0) console.log(`cleanup_scan_history: deleted=${deleted}`)
  return deleted
}

export async function clearExpiredClassificationCache(db: D1Database): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)

  let deleted = 0
  try {
    const result = await db.prepare(
      'DELETE FROM classification_cache WHERE created_at < ?'
    ).bind(cutoff.toISOString()).run()
    deleted = result.meta?.changes ?? 0
    if (deleted > 0) console.log(`cleanup_classification_cache: deleted=${deleted}`)
  } catch {
    // Table may not have created_at; skip silently
  }

  return deleted
}

export async function runMaintenance(db: D1Database): Promise<void> {
  await Promise.all([
    purgeOldUsageLogs(db),
    purgeOldScanHistory(db),
    clearExpiredClassificationCache(db),
  ])
}
