// Subreddit scanning logic: tier routing, sequential RSS fetching, R2 storage, extraction

import type { Env, ScanResult, RedditPost } from './types'
import { SUBREDDITS, REQUEST_DELAY_MS } from './config'
import { fetchRssFeed, sleep } from './rss-fetcher'
import { storeRawScan, storeExtraction, insertTopicSignals } from './storage'
import { extractTopics } from './extractor'

export interface ScanTierResult {
  scanned: number
  extracted: number
  errors: string[]
  totalRequests: number
}

/**
 * Scan all subreddits in a given tier via RSS.
 * Sequential with 200ms courtesy delay between requests.
 * For each sub: fetch RSS -> store raw -> extract -> store extraction -> insert D1.
 */
export async function scanTier(tier: 1 | 2 | 3, env: Env): Promise<ScanTierResult> {
  const subs = SUBREDDITS.filter(s => s.tier === tier)
  const result: ScanTierResult = { scanned: 0, extracted: 0, errors: [], totalRequests: 0 }

  for (const sub of subs) {
    try {
      const scanResult = await scanSubreddit(sub.name, tier)
      result.totalRequests += scanResult.requestCount
      result.scanned++

      // Store raw scan to R2
      await storeRawScan(env, scanResult.scan)

      // Run AI extraction
      const extraction = await extractTopics(env, scanResult.scan, tier)

      // Store extraction to R2
      await storeExtraction(env, extraction)

      // Insert topic signals to D1
      const inserted = await insertTopicSignals(env.REDDIT_SCANNER_DB, extraction)
      if (inserted > 0) result.extracted += inserted

      console.log(`[scanner] r/${sub.name} complete: ${scanResult.scan.posts.length} posts, ${extraction.topics.length} topics, ${scanResult.requestCount} requests`)
    } catch (e) {
      const msg = `r/${sub.name}: ${e instanceof Error ? e.message : String(e)}`
      console.error(`[scanner] Error scanning ${msg}`)
      result.errors.push(msg)
    }
  }

  console.log(`[scanner] tier${tier} complete: subs=${subs.length}, scanned=${result.scanned}, extracted=${result.extracted}, total_requests=${result.totalRequests}, errors=${result.errors.length}`)
  return result
}

interface SubredditScanResult {
  scan: ScanResult
  requestCount: number
}

async function scanSubreddit(
  subreddit: string,
  tier: 1 | 2 | 3,
): Promise<SubredditScanResult> {
  let requestCount = 0
  const timestamp = Math.floor(Date.now() / 1000)
  const allPosts: RedditPost[] = []

  // Tier 1: hot (25) + rising (10)
  // Tier 2: hot (25)
  // Tier 3: top/day (10)

  if (tier === 1 || tier === 2) {
    await sleep(REQUEST_DELAY_MS)
    const hotPosts = await fetchRssFeed(subreddit, 'hot', 25)
    requestCount++
    allPosts.push(...hotPosts)

    if (tier === 1) {
      await sleep(REQUEST_DELAY_MS)
      const risingPosts = await fetchRssFeed(subreddit, 'rising', 10)
      requestCount++
      allPosts.push(...risingPosts)
    }
  } else {
    // Tier 3: top posts from the last day
    await sleep(REQUEST_DELAY_MS)
    const topPosts = await fetchRssFeed(subreddit, 'top', 10, { timeWindow: 'day' })
    requestCount++
    allPosts.push(...topPosts)
  }

  const scan: ScanResult = {
    subreddit,
    sort: tier === 3 ? 'top' : 'hot',
    timestamp,
    posts: allPosts,
  }

  return { scan, requestCount }
}
