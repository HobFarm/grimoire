import type { CachedHit, CacheRow, CacheStats } from './types'

const LOW_CONFIDENCE_THRESHOLD = 0.7
const MAX_RECLASSIFY_ATTEMPTS = 3

/**
 * SHA-256 hash via Web Crypto API. Returns hex string.
 */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Compute cache key for a single (text, category_slug, contexts) triple.
 */
export async function computeCacheKey(
  text: string,
  categorySlug: string,
  contexts: string[]
): Promise<string> {
  const sortedContexts = [...contexts].sort().join(',')
  return sha256(`${text}|${categorySlug}|${sortedContexts}`)
}

/**
 * Look up cached results for a text against multiple categories.
 * Returns a Map of category slugs to cached results.
 * Entries with confidence < 0.7 AND reclassify_count < 3 are treated as misses (need re-classification).
 * Entries with confidence < 0.7 AND reclassify_count >= 3 are accepted (ambiguous, stop retrying).
 */
export async function getCachedResults(
  db: D1Database,
  text: string,
  categorySlugs: string[],
  contexts: string[]
): Promise<Map<string, CachedHit>> {
  const hits = new Map<string, CachedHit>()
  if (categorySlugs.length === 0) return hits

  // Compute all hashes
  const hashEntries: Array<{ slug: string; hash: string }> = []
  for (const slug of categorySlugs) {
    const hash = await computeCacheKey(text, slug, contexts)
    hashEntries.push({ slug, hash })
  }

  const placeholders = hashEntries.map(() => '?').join(',')
  const res = await db
    .prepare(
      `SELECT term_hash, category_slug, result, confidence, reclassify_count
       FROM classification_cache
       WHERE term_hash IN (${placeholders})`
    )
    .bind(...hashEntries.map(e => e.hash))
    .all<CacheRow>()

  const now = new Date().toISOString()
  const updateStmt = db.prepare(
    'UPDATE classification_cache SET access_count = access_count + 1, accessed_at = ? WHERE term_hash = ?'
  )

  const updates: D1PreparedStatement[] = []

  for (const row of res.results) {
    const isLowConfidence = row.confidence < LOW_CONFIDENCE_THRESHOLD
    const exhaustedRetries = row.reclassify_count >= MAX_RECLASSIFY_ATTEMPTS

    // Low confidence and still have retries left: treat as cache miss
    if (isLowConfidence && !exhaustedRetries) continue

    hits.set(row.category_slug, {
      result: JSON.parse(row.result),
      confidence: row.confidence,
      cached: true,
    })

    updates.push(updateStmt.bind(now, row.term_hash))
  }

  // Batch update access counts
  if (updates.length > 0) {
    await db.batch(updates)
  }

  return hits
}

/**
 * Write classification results to cache. Only writes entries that matched a known category.
 * On re-classification of low-confidence entries, increments reclassify_count.
 */
export async function writeCacheResults(
  db: D1Database,
  text: string,
  contexts: string[],
  results: Array<{ category: string; result: Record<string, unknown>; confidence: number }>
): Promise<void> {
  if (results.length === 0) return

  const statements: D1PreparedStatement[] = []

  for (const entry of results) {
    const hash = await computeCacheKey(text, entry.category, contexts)

    // Check if this is a re-classification (existing low-confidence entry)
    const existing = await db
      .prepare('SELECT reclassify_count FROM classification_cache WHERE term_hash = ?')
      .bind(hash)
      .first<{ reclassify_count: number }>()

    const reclassifyCount = existing ? existing.reclassify_count + 1 : 0
    const now = new Date().toISOString()

    statements.push(
      db.prepare(
        `INSERT OR REPLACE INTO classification_cache
         (term_hash, term, category_slug, result, confidence, created_at, accessed_at, access_count, reclassify_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).bind(
        hash,
        text,
        entry.category,
        JSON.stringify(entry.result),
        entry.confidence,
        now,
        now,
        reclassifyCount
      )
    )
  }

  await db.batch(statements)
}

/**
 * Get cache statistics.
 */
export async function getCacheStats(db: D1Database): Promise<CacheStats> {
  const res = await db
    .prepare(
      `SELECT
        COUNT(*) as total_entries,
        COALESCE(SUM(access_count), 0) as total_hits,
        COUNT(CASE WHEN confidence < ? THEN 1 END) as low_confidence_count,
        COUNT(CASE WHEN confidence < ? AND reclassify_count >= ? THEN 1 END) as stale_reclassify_count,
        COUNT(DISTINCT category_slug) as categories_cached
       FROM classification_cache`
    )
    .bind(LOW_CONFIDENCE_THRESHOLD, LOW_CONFIDENCE_THRESHOLD, MAX_RECLASSIFY_ATTEMPTS)
    .first<CacheStats>()

  return res ?? {
    total_entries: 0,
    total_hits: 0,
    low_confidence_count: 0,
    stale_reclassify_count: 0,
    categories_cached: 0,
  }
}

/**
 * Clear all cache entries.
 */
export async function clearCache(db: D1Database): Promise<{ deleted: number }> {
  const res = await db.prepare('DELETE FROM classification_cache').run()
  return { deleted: res.meta.changes ?? 0 }
}

/**
 * Clear cache entries for a specific category slug.
 */
export async function clearCacheByCategory(
  db: D1Database,
  categorySlug: string
): Promise<{ deleted: number }> {
  const res = await db
    .prepare('DELETE FROM classification_cache WHERE category_slug = ?')
    .bind(categorySlug)
    .run()
  return { deleted: res.meta.changes ?? 0 }
}
