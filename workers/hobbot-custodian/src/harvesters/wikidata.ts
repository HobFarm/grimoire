import type { Env } from '../index'
import type { Harvester, HarvesterResult, AtomCandidate } from './base'
import {
  loadSource,
  startSyncRun,
  completeSyncRun,
  checkDedup,
  batchRecordSourceAtoms,
  updateSourceCursor,
  ingestToGrimoire,
  ensureCollection,
  sleep,
} from './base'
import { WIKIDATA_DOMAINS, transformWikidataResults } from '../transforms/wikidata'
import type { WikidataSparqlResults } from '../transforms/wikidata'

const SOURCE_ID = 'wikidata-visual-arts'
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql'
const SPARQL_TIMEOUT_MS = 60_000
const RATE_LIMIT_MS = 5_000
const MAX_ELAPSED_MS = 240_000
const MAX_BATCHES = 40
const USER_AGENT = 'HobBot/1.0 (hey@hob.farm)'

interface WikidataCursor {
  domain_index: number
  offset: number
  complete?: boolean
  completed_at?: string
}

function parseCursor(raw: string | null): WikidataCursor {
  if (!raw) return { domain_index: 0, offset: 0 }
  try {
    return JSON.parse(raw)
  } catch {
    return { domain_index: 0, offset: 0 }
  }
}

function buildQuery(template: string, batchSize: number, offset: number): string {
  return template
    .replace('{BATCH_SIZE}', String(batchSize))
    .replace('{OFFSET}', String(offset))
    .trim()
}

async function fetchSparql(query: string): Promise<unknown> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SPARQL_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/sparql-results+json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Wikidata SPARQL returned ${res.status}: ${await res.text().catch(() => 'no body')}`)
    }
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

export class WikidataHarvester implements Harvester {
  source_id = SOURCE_ID

  async harvest(env: Env, _cursor: string | null, batch_size: number): Promise<HarvesterResult> {
    const source = await loadSource(env.HOBBOT_DB, SOURCE_ID)
    if (!source) throw new Error(`Source ${SOURCE_ID} not found or disabled`)

    const cursor = parseCursor(source.sync_cursor)

    // If already complete and less than 30 days old, skip
    if (cursor.complete && cursor.completed_at) {
      const completedAt = new Date(cursor.completed_at).getTime()
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
      if (completedAt > thirtyDaysAgo) {
        return { items_fetched: 0, items_ingested: 0, items_rejected: 0, items_skipped: 0, new_cursor: source.sync_cursor }
      }
      // Reset for re-harvest
      cursor.domain_index = 0
      cursor.offset = 0
      cursor.complete = false
      cursor.completed_at = undefined
    }

    // Ensure wikidata collection exists in Grimoire
    await ensureCollection(env.GRIMOIRE, 'wikidata', 'Wikidata', 'Structured knowledge from Wikidata SPARQL')

    const runId = await startSyncRun(env.HOBBOT_DB, SOURCE_ID, source.sync_cursor)
    const startTime = Date.now()
    let totalFetched = 0
    let totalIngested = 0
    let totalSkipped = 0
    let totalRejected = 0
    let batchCount = 0
    let runStatus: 'completed' | 'failed' | 'partial' = 'completed'
    let errorMsg: string | undefined

    try {
      while (batchCount < MAX_BATCHES && (Date.now() - startTime) < MAX_ELAPSED_MS) {
        // Check if all domains are exhausted
        if (cursor.domain_index >= WIKIDATA_DOMAINS.length) {
          cursor.complete = true
          cursor.completed_at = new Date().toISOString()
          console.log(`[wikidata] All domains complete`)
          break
        }

        const domain = WIKIDATA_DOMAINS[cursor.domain_index]
        const query = buildQuery(domain.query, batch_size, cursor.offset)
        let sparqlData: unknown

        try {
          sparqlData = await fetchSparql(query)
        } catch (e) {
          errorMsg = e instanceof Error ? e.message : String(e)
          console.log(`[wikidata] SPARQL fetch failed for ${domain.id} at offset ${cursor.offset}: ${errorMsg}`)
          runStatus = 'partial'
          break
        }

        const rawBindings = (sparqlData as WikidataSparqlResults).results.bindings
        totalFetched += rawBindings.length

        if (rawBindings.length === 0) {
          // Domain exhausted, advance to next
          console.log(`[wikidata] Domain '${domain.id}' complete at offset ${cursor.offset}`)
          cursor.domain_index++
          cursor.offset = 0
          await updateSourceCursor(env.HOBBOT_DB, SOURCE_ID, JSON.stringify(cursor))
          continue // don't count as a batch or rate-limit
        }

        const candidates = transformWikidataResults(sparqlData as WikidataSparqlResults, domain)

        // Dedup against source_atoms
        const toIngest: AtomCandidate[] = []
        const allRecords: { source_id: string; external_uri: string; candidate_text: string; candidate_category: string | null; status: string; raw_data?: string }[] = []

        for (const candidate of candidates) {
          const exists = await checkDedup(env.HOBBOT_DB, SOURCE_ID, candidate.external_uri)
          if (exists) {
            totalSkipped++
            continue
          }
          toIngest.push(candidate)
          allRecords.push({
            source_id: SOURCE_ID,
            external_uri: candidate.external_uri,
            candidate_text: candidate.text,
            candidate_category: candidate.category_slug ?? null,
            status: 'ingested',
            raw_data: JSON.stringify(candidate.metadata),
          })
        }

        // Rejected = raw bindings that didn't pass transform filters
        totalRejected += rawBindings.length - candidates.length

        // Record all new candidates in source_atoms first
        await batchRecordSourceAtoms(env.HOBBOT_DB, allRecords)

        // Ingest to Grimoire
        if (toIngest.length > 0) {
          try {
            const result = await ingestToGrimoire(env.GRIMOIRE, toIngest)
            totalIngested += result.inserted
            totalSkipped += result.duplicates
          } catch (e) {
            errorMsg = e instanceof Error ? e.message : String(e)
            console.log(`[wikidata] Grimoire ingest failed: ${errorMsg}`)
            runStatus = 'partial'
          }
        }

        // Advance cursor after successful batch
        cursor.offset += rawBindings.length
        await updateSourceCursor(env.HOBBOT_DB, SOURCE_ID, JSON.stringify(cursor))

        batchCount++
        console.log(`[wikidata] batch ${batchCount} (${domain.id}): fetched=${rawBindings.length} new=${toIngest.length} skipped=${totalSkipped} offset=${cursor.offset}`)

        // Rate limit between SPARQL requests
        if (batchCount < MAX_BATCHES && (Date.now() - startTime) < MAX_ELAPSED_MS) {
          await sleep(RATE_LIMIT_MS)
        }
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e)
      console.log(`[wikidata] harvest error: ${errorMsg}`)
      runStatus = 'failed'
    }

    const result: HarvesterResult = {
      items_fetched: totalFetched,
      items_ingested: totalIngested,
      items_rejected: totalRejected,
      items_skipped: totalSkipped,
      new_cursor: JSON.stringify(cursor),
      error: errorMsg,
    }

    await completeSyncRun(env.HOBBOT_DB, runId, runStatus, result, JSON.stringify(cursor), errorMsg)

    console.log(`[wikidata] harvest complete: status=${runStatus} fetched=${totalFetched} ingested=${totalIngested} skipped=${totalSkipped} rejected=${totalRejected} batches=${batchCount} elapsed=${Date.now() - startTime}ms`)

    return result
  }
}
