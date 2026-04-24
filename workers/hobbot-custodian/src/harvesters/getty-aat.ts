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
  sleep,
} from './base'
import { transformSparqlResults } from '../transforms/getty-aat'

const SOURCE_ID = 'getty-aat'
const SPARQL_ENDPOINT = 'http://vocab.getty.edu/sparql'
const SPARQL_TIMEOUT_MS = 30_000
const RATE_LIMIT_MS = 2_000
const MAX_ELAPSED_MS = 240_000 // 4 minutes, leaving headroom for Worker's 5min limit
const MAX_BATCHES = 40

// Flat query: all AAT Subjects with English preferred labels, broader term, and scope note.
// STRSTARTS filter restricts to AAT concepts only (excludes ULAN etc from the same endpoint).
// ORDER BY + OFFSET gives stable pagination (tested: works with LIMIT 50 on Getty).
function buildSparqlQuery(offset: number, limit: number): string {
  return `
PREFIX gvp: <http://vocab.getty.edu/ontology#>
PREFIX xl: <http://www.w3.org/2008/05/skos-xl#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT ?concept ?term ?broaderUri ?broaderTerm ?scopeNote WHERE {
  ?concept a gvp:Subject ;
    xl:prefLabel [ dcterms:language <http://vocab.getty.edu/aat/300388277> ; gvp:term ?term ] .
  FILTER(STRSTARTS(STR(?concept), "http://vocab.getty.edu/aat/"))
  OPTIONAL {
    ?concept gvp:broaderPreferred ?broaderUri .
    ?broaderUri xl:prefLabel [ dcterms:language <http://vocab.getty.edu/aat/300388277> ; gvp:term ?broaderTerm ]
  }
  OPTIONAL {
    ?concept skos:scopeNote [ dcterms:language <http://vocab.getty.edu/aat/300388277> ; rdf:value ?scopeNote ]
  }
}
ORDER BY ?concept
LIMIT ${limit} OFFSET ${offset}`.trim()
}

interface GettyAatCursor {
  offset: number
  complete?: boolean
  completed_at?: string
}

function parseCursor(raw: string | null): GettyAatCursor {
  if (!raw) return { offset: 0 }
  try {
    return JSON.parse(raw)
  } catch {
    return { offset: 0 }
  }
}

async function fetchSparql(query: string): Promise<unknown> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SPARQL_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/sparql-results+json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Getty SPARQL returned ${res.status}: ${await res.text().catch(() => 'no body')}`)
    }
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

export class GettyAatHarvester implements Harvester {
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
      cursor.offset = 0
      cursor.complete = false
      cursor.completed_at = undefined
    }

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
        const query = buildSparqlQuery(cursor.offset, batch_size)
        let sparqlData: unknown

        try {
          sparqlData = await fetchSparql(query)
        } catch (e) {
          errorMsg = e instanceof Error ? e.message : String(e)
          console.log(`[getty-aat] SPARQL fetch failed at offset ${cursor.offset}: ${errorMsg}`)
          runStatus = 'partial'
          break
        }

        const candidates = transformSparqlResults(sparqlData as Parameters<typeof transformSparqlResults>[0])
        const rawBindings = (sparqlData as { results: { bindings: unknown[] } }).results.bindings
        totalFetched += rawBindings.length

        if (rawBindings.length === 0) {
          cursor.complete = true
          cursor.completed_at = new Date().toISOString()
          console.log(`[getty-aat] Corpus complete at offset ${cursor.offset}`)
          break
        }

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
          // Pre-record all candidates; status updated after Grimoire response
          allRecords.push({
            source_id: SOURCE_ID,
            external_uri: candidate.external_uri,
            candidate_text: candidate.text,
            candidate_category: candidate.category_slug ?? null,
            status: 'ingested', // default; Grimoire dedup doesn't change this
            raw_data: JSON.stringify(candidate.metadata),
          })
        }

        // Rejected = raw bindings that didn't pass transform (length/word filters)
        totalRejected += rawBindings.length - candidates.length

        // Record ALL new candidates in source_atoms first (prevents re-fetching on retry)
        await batchRecordSourceAtoms(env.HOBBOT_DB, allRecords)

        // Ingest to Grimoire
        if (toIngest.length > 0) {
          try {
            const result = await ingestToGrimoire(env.GRIMOIRE, toIngest)
            totalIngested += result.inserted
            // Grimoire-level duplicates (text already in atoms table)
            totalSkipped += result.duplicates
          } catch (e) {
            errorMsg = e instanceof Error ? e.message : String(e)
            console.log(`[getty-aat] Grimoire ingest failed: ${errorMsg}`)
            runStatus = 'partial'
          }
        }

        // Advance cursor after successful batch
        cursor.offset += rawBindings.length
        await updateSourceCursor(env.HOBBOT_DB, SOURCE_ID, JSON.stringify(cursor))

        batchCount++
        console.log(`[getty-aat] batch ${batchCount}: fetched=${rawBindings.length} new=${toIngest.length} skipped=${totalSkipped} offset=${cursor.offset}`)

        // Rate limit between SPARQL requests
        if (batchCount < MAX_BATCHES && (Date.now() - startTime) < MAX_ELAPSED_MS) {
          await sleep(RATE_LIMIT_MS)
        }
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e)
      console.log(`[getty-aat] harvest error: ${errorMsg}`)
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

    console.log(`[getty-aat] harvest complete: status=${runStatus} fetched=${totalFetched} ingested=${totalIngested} skipped=${totalSkipped} rejected=${totalRejected} batches=${batchCount} elapsed=${Date.now() - startTime}ms`)

    return result
  }
}
