// RSS Feed Harvester: polls configured RSS/Atom feeds, scores relevance,
// flags high-scoring items for ingest by hobbot-worker's processRssIngestQueue.
// Does NOT call ingestKnowledge directly (decoupled via feed_entries table).

import type { Env } from '../index'
import type { Harvester, HarvesterResult } from './base'
import { startSyncRun, completeSyncRun, sleep } from './base'
import { parseFeedXml, type FeedItem } from '../transforms/rss'
import { loadKeywords, scoreItem, getThreshold, type FeedSourceConfig } from '../transforms/relevance'
import { logAction } from '@shared/ledger'

const SOURCE_TYPE = 'rss'
const FETCH_TIMEOUT_MS = 15_000
const MAX_ELAPSED_MS = 240_000 // 4 minutes

interface RssSourceRow {
  id: string
  name: string
  endpoint_url: string
  sync_cadence: string
  last_sync_at: string | null
  notes: string | null
  batch_size: number
  enabled: number
  ingest_to_grimoire: number | null
}

interface ParsedSourceConfig extends FeedSourceConfig {
  ingest_to_grimoire: boolean
}

function parseSourceConfig(notes: string | null, columnValue?: number | null): ParsedSourceConfig {
  let fromNotes = { tier: 'adjacent' as FeedSourceConfig['tier'], weight: 1.0, ingest_to_grimoire: true }
  if (notes) {
    try {
      const parsed = JSON.parse(notes)
      fromNotes = {
        tier: (parsed.tier ?? 'adjacent') as FeedSourceConfig['tier'],
        weight: parsed.weight ?? 1.0,
        ingest_to_grimoire: parsed.ingest_to_grimoire !== false,
      }
    } catch { /* use defaults */ }
  }
  return {
    tier: fromNotes.tier,
    weight: fromNotes.weight,
    // Column takes precedence over notes JSON when present
    ingest_to_grimoire: columnValue !== null && columnValue !== undefined
      ? columnValue === 1
      : fromNotes.ingest_to_grimoire,
  }
}

function getPollIntervalMs(notes: string | null): number {
  if (!notes) return 6 * 60 * 60 * 1000 // 6 hours default
  try {
    const parsed = JSON.parse(notes)
    return (parsed.poll_interval_minutes ?? 360) * 60 * 1000
  } catch {
    return 6 * 60 * 60 * 1000
  }
}

async function computeContentHash(title: string, url: string): Promise<string> {
  const data = new TextEncoder().encode(`${title}|${url}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export class RssHarvester implements Harvester {
  source_id = 'rss-feeds' // virtual source ID for the sync run

  async harvest(env: Env, _cursor: string | null, _batch_size: number): Promise<HarvesterResult> {
    const startTime = Date.now()
    const result: HarvesterResult = {
      items_fetched: 0,
      items_ingested: 0,
      items_rejected: 0,
      items_skipped: 0,
      new_cursor: null,
    }

    // Load all enabled RSS sources
    const { results: sources } = await env.HOBBOT_DB.prepare(
      "SELECT * FROM sources WHERE type = ? AND enabled = 1 ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC"
    ).bind(SOURCE_TYPE).all<RssSourceRow>()

    if (!sources || sources.length === 0) {
      console.log('[rss] no enabled RSS sources found')
      return result
    }

    // Load relevance keywords from Grimoire DB
    const keywords = await loadKeywords(env.GRIMOIRE_DB)

    const runId = await startSyncRun(env.HOBBOT_DB, this.source_id, null)
    let errorMsg: string | undefined

    try {
      for (const source of sources) {
        if ((Date.now() - startTime) > MAX_ELAPSED_MS) {
          console.log('[rss] time limit reached, stopping')
          break
        }

        // Check if this feed is due for polling
        if (source.last_sync_at) {
          const lastSync = new Date(source.last_sync_at).getTime()
          const pollInterval = getPollIntervalMs(source.notes)
          if (Date.now() - lastSync < pollInterval) continue
        }

        const config = parseSourceConfig(source.notes, source.ingest_to_grimoire)

        try {
          await this.pollFeed(env, source, config, keywords, result)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.log(`[rss] feed ${source.name} failed: ${msg}`)
          result.items_rejected++
        }

        // Update last_sync_at for this source
        await env.HOBBOT_DB.prepare(
          "UPDATE sources SET last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).bind(source.id).run()

        // Brief pause between feeds
        await sleep(500)
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e)
      console.log(`[rss] harvest error: ${errorMsg}`)
    }

    const status = errorMsg ? 'partial' : 'completed'
    await completeSyncRun(env.HOBBOT_DB, runId, status, result, null, errorMsg)

    // Log to session ledger
    try {
      await logAction(env.HOBBOT_DB, {
        action_type: 'ingested',
        topic_key: 'rss-feeds',
        payload: {
          feeds_polled: sources.length,
          fetched: result.items_fetched,
          ingested: result.items_ingested,
          skipped: result.items_skipped,
        },
        status: errorMsg ? 'failed' : 'complete',
        completed_at: new Date().toISOString(),
      })
    } catch (e) {
      console.warn(`[rss] ledger log failed: ${e instanceof Error ? e.message : e}`)
    }

    console.log(`[rss] harvest complete: feeds=${sources.length} fetched=${result.items_fetched} flagged=${result.items_ingested} skipped=${result.items_skipped}`)
    return result
  }

  private async pollFeed(
    env: Env,
    source: RssSourceRow,
    config: ParsedSourceConfig,
    keywords: Set<string>,
    result: HarvesterResult,
  ): Promise<void> {
    if (!source.endpoint_url) return

    console.log(`[rss] polling ${source.name} (${source.endpoint_url})`)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    let xml: string
    try {
      const res = await fetch(source.endpoint_url, {
        headers: { 'User-Agent': 'GrimoireBot/1.0 (+https://hob.farm)' },
        signal: controller.signal,
      })
      if (!res.ok) {
        console.log(`[rss] ${source.name} returned ${res.status}`)
        return
      }
      xml = await res.text()
    } finally {
      clearTimeout(timeout)
    }

    const items = parseFeedXml(xml)
    result.items_fetched += items.length

    if (items.length === 0) {
      console.log(`[rss] ${source.name}: no items parsed`)
      return
    }

    const threshold = getThreshold(config.tier)

    for (const item of items) {
      const contentHash = await computeContentHash(item.title, item.url)

      // Dedup: check if we've seen this item before
      const existing = await env.HOBBOT_DB.prepare(
        'SELECT id FROM feed_entries WHERE source_id = ? AND entry_url = ?'
      ).bind(source.id, item.url).first()

      if (existing) {
        result.items_skipped++
        continue
      }

      // Score relevance
      const score = scoreItem(item, config, keywords)

      // Insert feed entry (ingested=0: hobbot-worker picks up pending entries)
      await env.HOBBOT_DB.prepare(
        `INSERT INTO feed_entries
          (source_id, entry_url, entry_title, published_at, extraction_status, relevance_score, content_hash, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        source.id,
        item.url,
        item.title,
        item.published_at,
        score >= threshold ? 'pending' : 'no_terms',
        score,
        contentHash,
      ).run()

      // Count high-scoring items as "ingested" (flagged for pickup)
      if (score >= threshold && config.ingest_to_grimoire) {
        result.items_ingested++
      }
    }

    console.log(`[rss] ${source.name}: ${items.length} items, ${result.items_ingested} flagged for ingest`)
  }
}
