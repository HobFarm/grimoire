#!/usr/bin/env node
/**
 * Aesthetics Wiki Batch Ingestion Script
 *
 * Scrapes the Aesthetics Wiki "List of Aesthetics" page for all URLs,
 * deduplicates against existing sources and ingest_log, then batches
 * through the HobBot worker's knowledge ingest pipeline.
 *
 * Usage:
 *   node scripts/aesthetics-wiki-batch.mjs --scrape        # Step 1: scrape + dedup, write JSON
 *   node scripts/aesthetics-wiki-batch.mjs --ingest        # Step 2: batch ingest from JSON
 *   node scripts/aesthetics-wiki-batch.mjs --audit         # Step 3: post-run audit
 *   node scripts/aesthetics-wiki-batch.mjs --ingest --dry  # Preview without creating records
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from './ingest/utils/env.mjs'
import { queryD1 } from './ingest/utils/d1.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const URLS_FILE = join(__dirname, 'aesthetics-wiki-urls.json')
const REMAINING_FILE = join(__dirname, 'aesthetics-wiki-remaining.json')
const CHECKPOINT_FILE = join(__dirname, 'aesthetics-wiki-checkpoint.json')

const HOBBOT_URL = 'https://hobbot-worker.damp-violet-bf89.workers.dev'
const BATCH_SIZE = 10
const BATCH_DELAY_MS = 30_000
const WIKI_API = 'https://aesthetics.fandom.com/api.php'

// Meta pages to exclude (by title pattern)
const EXCLUDED_TITLES = new Set([
  'List of Aesthetics', 'Main Page',
])
const EXCLUDED_PREFIXES = ['-core', '-ism', '-punk', '-wave']

function getServiceToken() {
  const token = process.env.HOBBOT_SERVICE_TOKEN
  if (!token) throw new Error('HOBBOT_SERVICE_TOKEN not set in .env or environment')
  return token
}

// ---------- Step 1: Enumerate via MediaWiki API + Dedup ----------

async function scrapeIndex() {
  console.log(`[scrape] Enumerating all pages via MediaWiki API...`)
  const urls = []
  let continueParam = ''

  while (true) {
    const apiUrl = `${WIKI_API}?action=query&list=allpages&aplimit=500&apnamespace=0&format=json${continueParam}`
    const res = await fetch(apiUrl)
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    const data = await res.json()

    for (const page of data.query.allpages) {
      if (EXCLUDED_TITLES.has(page.title)) continue
      if (EXCLUDED_PREFIXES.some(p => page.title === p)) continue
      const encoded = encodeURIComponent(page.title.replace(/ /g, '_'))
      urls.push(`https://aesthetics.fandom.com/wiki/${encoded}`)
    }

    if (data.continue) {
      continueParam = '&apcontinue=' + encodeURIComponent(data.continue.apcontinue)
    } else {
      break
    }
  }

  console.log(`[scrape] Found ${urls.length} pages (ns=0, excluding meta pages)`)
  writeFileSync(URLS_FILE, JSON.stringify(urls, null, 2))
  console.log(`[scrape] Wrote ${URLS_FILE}`)
  return urls
}

async function dedup(urls) {
  console.log(`[dedup] Checking existing sources and ingest_log...`)

  // Query existing source URLs
  const sourceRows = await queryD1(
    "SELECT source_url FROM sources WHERE source_url LIKE '%aesthetics.fandom%'"
  )
  const existingSources = new Set(sourceRows.map(r => r.source_url))

  // Query existing ingest_log URLs
  const logRows = await queryD1(
    "SELECT url FROM ingest_log WHERE url LIKE '%aesthetics.fandom%'"
  )
  const existingLogs = new Set(logRows.map(r => r.url))

  const remaining = urls.filter(u => !existingSources.has(u) && !existingLogs.has(u))

  console.log(`[dedup] Total: ${urls.length}, Already ingested: ${urls.length - remaining.length}, Remaining: ${remaining.length}`)
  writeFileSync(REMAINING_FILE, JSON.stringify(remaining, null, 2))
  console.log(`[dedup] Wrote ${REMAINING_FILE}`)
  return remaining
}

// ---------- Step 2: Batch Ingest ----------

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { last_batch_index: -1, failed_urls: [] }
  return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
}

function saveCheckpoint(checkpoint) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2))
}

async function ingestBatch(urls, dryRun = false) {
  if (!existsSync(REMAINING_FILE)) {
    throw new Error(`${REMAINING_FILE} not found. Run --scrape first.`)
  }

  const remaining = urls || JSON.parse(readFileSync(REMAINING_FILE, 'utf-8'))
  const token = getServiceToken()
  const checkpoint = loadCheckpoint()
  const startBatch = checkpoint.last_batch_index + 1
  const totalBatches = Math.ceil(remaining.length / BATCH_SIZE)

  console.log(`[ingest] ${remaining.length} URLs, ${totalBatches} batches, starting from batch ${startBatch}`)
  if (dryRun) console.log('[ingest] DRY RUN - no records will be created')

  let totalSuccess = 0
  let totalFailed = 0

  for (let i = startBatch; i < totalBatches; i++) {
    const batch = remaining.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
    const batchUrls = batch.map(url => ({ url, source_type: 'aesthetic' }))

    console.log(`[ingest] Batch ${i + 1}/${totalBatches} (${batch.length} URLs)`)

    try {
      const res = await fetch(`${HOBBOT_URL}/api/v1/ingest/knowledge/batch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          urls: batchUrls,
          collection_slug: 'uncategorized',
          dry_run: dryRun,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error(`[ingest] Batch ${i + 1} HTTP error ${res.status}: ${text.slice(0, 300)}`)
        checkpoint.failed_urls.push(...batch)
        totalFailed += batch.length
      } else {
        const data = await res.json()
        const results = data.results || []
        const succeeded = results.filter(r => r.status === 'ok').length
        const failed = results.filter(r => r.status === 'error')

        totalSuccess += succeeded
        totalFailed += failed.length

        for (const f of failed) {
          console.error(`  [fail] ${f.url}: ${f.error}`)
          checkpoint.failed_urls.push(f.url)
        }

        console.log(`  ok=${succeeded} fail=${failed.length} total_ok=${totalSuccess} total_fail=${totalFailed}`)
      }
    } catch (err) {
      console.error(`[ingest] Batch ${i + 1} network error: ${err.message}`)
      checkpoint.failed_urls.push(...batch)
      totalFailed += batch.length
    }

    checkpoint.last_batch_index = i
    saveCheckpoint(checkpoint)

    // Rate limit between batches (skip on last batch)
    if (i < totalBatches - 1) {
      console.log(`  waiting ${BATCH_DELAY_MS / 1000}s...`)
      await sleep(BATCH_DELAY_MS)
    }
  }

  console.log(`\n[ingest] Complete: success=${totalSuccess} failed=${totalFailed}`)
  if (checkpoint.failed_urls.length > 0) {
    console.log(`[ingest] ${checkpoint.failed_urls.length} failed URLs saved in checkpoint for retry`)
  }
}

// ---------- Step 3: Audit ----------

async function audit() {
  console.log('[audit] Querying post-ingest counts...')

  const sources = await queryD1(
    "SELECT COUNT(*) as count FROM sources WHERE source_url LIKE '%aesthetics.fandom%'"
  )
  const docs = await queryD1('SELECT COUNT(*) as count FROM documents')
  const atoms = await queryD1("SELECT COUNT(*) as count FROM atoms WHERE status != 'rejected'")
  const ingestLogs = await queryD1(
    "SELECT status, COUNT(*) as count FROM ingest_log WHERE url LIKE '%aesthetics.fandom%' GROUP BY status"
  )

  console.log(`  Sources (aesthetics wiki): ${sources[0].count}`)
  console.log(`  Documents (total): ${docs[0].count}`)
  console.log(`  Atoms (non-rejected): ${atoms[0].count}`)
  console.log(`  Ingest log breakdown:`)
  for (const row of ingestLogs) {
    console.log(`    ${row.status}: ${row.count}`)
  }
}

// ---------- CLI ----------

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')

try {
  if (args.includes('--scrape')) {
    const urls = await scrapeIndex()
    await dedup(urls)
  } else if (args.includes('--ingest')) {
    await ingestBatch(null, dryRun)
  } else if (args.includes('--retry')) {
    const checkpoint = loadCheckpoint()
    if (checkpoint.failed_urls.length === 0) {
      console.log('[retry] No failed URLs to retry')
    } else {
      console.log(`[retry] Retrying ${checkpoint.failed_urls.length} failed URLs`)
      // Reset checkpoint for retry pass
      const retryUrls = [...checkpoint.failed_urls]
      checkpoint.last_batch_index = -1
      checkpoint.failed_urls = []
      saveCheckpoint(checkpoint)
      writeFileSync(REMAINING_FILE, JSON.stringify(retryUrls, null, 2))
      await ingestBatch(retryUrls, dryRun)
    }
  } else if (args.includes('--audit')) {
    await audit()
  } else {
    console.log('Usage:')
    console.log('  node scripts/aesthetics-wiki-batch.mjs --scrape   # Scrape index + dedup')
    console.log('  node scripts/aesthetics-wiki-batch.mjs --ingest   # Batch ingest')
    console.log('  node scripts/aesthetics-wiki-batch.mjs --retry    # Retry failed URLs')
    console.log('  node scripts/aesthetics-wiki-batch.mjs --audit    # Post-run audit')
    console.log('  Add --dry for dry run (no records created)')
  }
} catch (err) {
  console.error(`[fatal] ${err.message}`)
  process.exit(1)
}
