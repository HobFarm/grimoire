#!/usr/bin/env node
/**
 * Archive.org Psychedelic/Visionary Art Batch Ingestion
 *
 * Searches Archive.org for psychedelic art, visionary art, sacred geometry,
 * and concert poster content. Routes images to Grimoire's image extraction
 * pipeline and PDFs to the fromPdf knowledge ingest pipeline.
 *
 * Usage:
 *   node scripts/ingest/archive-psychedelic.mjs --search     # Phase 1: search + deduplicate
 *   node scripts/ingest/archive-psychedelic.mjs --metadata   # Phase 2: fetch metadata + select files
 *   node scripts/ingest/archive-psychedelic.mjs --upload     # Phase 3: download images, upload to R2
 *   node scripts/ingest/archive-psychedelic.mjs --ingest     # Phase 4: trigger ingestion
 *   node scripts/ingest/archive-psychedelic.mjs --audit      # Phase 5: post-run verification
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { sleep, WORKER_URL } from './utils/env.mjs'
import { queryD1 } from './utils/d1.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const SEARCH_FILE = join(__dirname, 'archive-psychedelic-search.json')
const METADATA_FILE = join(__dirname, 'archive-psychedelic-metadata.json')
const UPLOAD_FILE = join(__dirname, 'archive-psychedelic-upload.json')

const GRIMOIRE_URL = WORKER_URL // grimoire worker
const HOBBOT_URL = 'https://hobbot-worker.damp-violet-bf89.workers.dev'
const IA_SEARCH_URL = 'https://archive.org/advancedsearch.php'
const IA_METADATA_URL = 'https://archive.org/metadata'
const USER_AGENT = 'HobBot/1.0 (https://hob.farm; hobfarm content ingestion)'

const SEARCH_QUERIES = [
  'psychedelic art',
  'visionary art',
  'fractal art',
  'psychedelic poster',
  'concert poster 1960s',
  'concert poster 1970s',
  'sacred geometry',
  'mandala art',
  'kaleidoscope poster',
  'fillmore poster',
  'acid rock poster',
]

// ─── File Selection ─────────────────────────────────────────────────

function pickBestImage(identifier, files) {
  const isImage = (f) => /\.(png|jpe?g|tiff?)$/i.test(f.name)
  const isThumb = (f) =>
    /__ia_thumb|_thumb/i.test(f.name) ||
    ['Item Tile', 'JPEG Thumb', 'Thumbnail', 'Item Image'].includes(f.format ?? '')

  const candidates = files.filter(f => isImage(f) && !isThumb(f))
  if (candidates.length === 0) return null

  // Prefer PNG originals, then largest by byte size
  const png = candidates.find(f => /\.png$/i.test(f.name) && f.format === 'PNG')
  const bySize = [...candidates].sort((a, b) =>
    (parseInt(b.size ?? '0') || 0) - (parseInt(a.size ?? '0') || 0)
  )
  const pick = png ?? bySize[0]

  const sizeBytes = parseInt(pick.size ?? '0') || 0
  const sizeMB = sizeBytes / (1024 * 1024)
  if (sizeMB > 10) return null

  return {
    filename: pick.name,
    format: pick.format ?? 'unknown',
    sizeMB: Math.round(sizeMB * 100) / 100,
    downloadUrl: `https://archive.org/download/${identifier}/${encodeURIComponent(pick.name)}`,
  }
}

function pickBestPdf(identifier, files) {
  const isPdf = (f) => f.name.toLowerCase().endsWith('.pdf')
  const byFormat = (label) => files.find(f => isPdf(f) && f.format === label)

  let pick = byFormat('Text PDF') || byFormat('Additional Text PDF')
  if (!pick) {
    const pdfs = files.filter(isPdf)
    const regular = pdfs.find(f => !/_text\.pdf$/i.test(f.name))
    pick = regular ?? pdfs[0]
  }
  if (!pick) return null

  const sizeBytes = parseInt(pick.size ?? '0') || 0
  const sizeMB = sizeBytes / (1024 * 1024)
  if (sizeMB > 100) return null

  return {
    filename: pick.name,
    format: pick.format ?? 'unknown',
    sizeMB: Math.round(sizeMB * 100) / 100,
    downloadUrl: `https://archive.org/download/${identifier}/${encodeURIComponent(pick.name)}`,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function getServiceToken() {
  const token = process.env.HOBBOT_SERVICE_TOKEN
  if (!token) throw new Error('HOBBOT_SERVICE_TOKEN not set in .env or environment')
  return token
}

async function iaFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new Error(`IA fetch ${res.status}: ${url}`)
  return res
}

function loadJson(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

// ─── Phase 1: Search ────────────────────────────────────────────────

async function searchIA() {
  console.log('[search] Starting Archive.org search across 11 queries x 2 mediatypes...')
  const items = {} // identifier -> { title, mediatype, year, found_in }
  let queriesRun = 0
  let totalHits = 0
  const zeroResultQueries = []

  for (const query of SEARCH_QUERIES) {
    for (const config of [
      {
        mediatype: 'image',
        q: `${query} AND mediatype:image AND year:[* TO 2015]`,
      },
      {
        mediatype: 'texts',
        q: `${query} AND mediatype:texts AND (collection:internetarchivebooks OR collection:opensource) AND year:[* TO 2015]`,
      },
    ]) {
      queriesRun++
      let page = 1
      let pageHits = 0

      while (true) {
        const params = new URLSearchParams({
          q: config.q,
          'fl[]': 'identifier,title,year,mediatype',
          rows: '50',
          page: String(page),
          output: 'json',
        })

        try {
          const res = await iaFetch(`${IA_SEARCH_URL}?${params}`)
          const data = await res.json()
          const docs = data.response?.docs ?? []

          if (docs.length === 0) break

          for (const doc of docs) {
            const id = doc.identifier
            if (!id) continue

            if (items[id]) {
              // Already seen: add this query to found_in
              if (!items[id].found_in.includes(query)) {
                items[id].found_in.push(query)
              }
            } else {
              items[id] = {
                title: doc.title ?? id,
                mediatype: doc.mediatype ?? config.mediatype,
                year: doc.year ?? null,
                found_in: [query],
              }
              pageHits++
            }
          }

          totalHits += docs.length
          console.log(`  [${config.mediatype}] "${query}" page ${page}: ${docs.length} hits (${pageHits} new)`)

          if (docs.length < 50) break // Last page
          page++
        } catch (err) {
          console.error(`  [error] "${query}" ${config.mediatype} page ${page}: ${err.message}`)
          break
        }

        await sleep(1000)
      }

      if (pageHits === 0) {
        zeroResultQueries.push(`${query} (${config.mediatype})`)
      }

      await sleep(1000) // Between queries
    }
  }

  const imageCount = Object.values(items).filter(i => i.mediatype === 'image').length
  const textsCount = Object.values(items).filter(i => i.mediatype === 'texts').length

  const result = {
    searched_at: new Date().toISOString(),
    queries_run: queriesRun,
    items,
    stats: {
      total_unique: Object.keys(items).length,
      total_image: imageCount,
      total_texts: textsCount,
      total_hits_before_dedup: totalHits,
    },
    zero_result_queries: zeroResultQueries,
  }

  saveJson(SEARCH_FILE, result)
  console.log(`\n[search] Complete:`)
  console.log(`  Queries run: ${queriesRun}`)
  console.log(`  Total hits (before dedup): ${totalHits}`)
  console.log(`  Unique identifiers: ${Object.keys(items).length}`)
  console.log(`  Images: ${imageCount}, Texts: ${textsCount}`)
  if (zeroResultQueries.length > 0) {
    console.log(`  Zero-result queries: ${zeroResultQueries.join(', ')}`)
  }
}

// ─── Phase 2: Metadata ─────────────────────────────────────────────

async function fetchMetadata() {
  const search = loadJson(SEARCH_FILE)
  if (!search) throw new Error(`${SEARCH_FILE} not found. Run --search first.`)

  const identifiers = Object.keys(search.items)
  console.log(`[metadata] Fetching metadata for ${identifiers.length} identifiers...`)

  // Load existing progress if resuming
  const existing = loadJson(METADATA_FILE)
  const results = existing?.items ?? {}
  const startIdx = Object.keys(results).length

  let readyImages = 0
  let readyTexts = 0
  let skipped = 0
  const skipReasons = {}

  // Count already-processed items
  for (const item of Object.values(results)) {
    if (item.status === 'ready') {
      if (item.mediatype === 'image') readyImages++
      else readyTexts++
    } else {
      skipped++
    }
  }

  for (let i = startIdx; i < identifiers.length; i++) {
    const id = identifiers[i]
    if (results[id]) continue // Already processed

    const mediatype = search.items[id].mediatype

    try {
      const res = await iaFetch(`${IA_METADATA_URL}/${id}`)
      const data = await res.json()
      const files = data.files ?? []

      let selected = null
      let skipReason = null

      if (mediatype === 'image') {
        selected = pickBestImage(id, files)
        if (!selected) skipReason = 'no_valid_image'
      } else {
        selected = pickBestPdf(id, files)
        if (!selected) skipReason = 'no_valid_pdf'
      }

      if (selected) {
        results[id] = {
          mediatype,
          title: search.items[id].title,
          selected_file: {
            filename: selected.filename,
            format: selected.format,
            sizeMB: selected.sizeMB,
          },
          download_url: selected.downloadUrl,
          status: 'ready',
          skip_reason: null,
        }
        if (mediatype === 'image') readyImages++
        else readyTexts++
      } else {
        results[id] = {
          mediatype,
          title: search.items[id].title,
          selected_file: null,
          download_url: null,
          status: 'skipped',
          skip_reason: skipReason,
        }
        skipped++
        skipReasons[skipReason] = (skipReasons[skipReason] ?? 0) + 1
      }

      if ((i + 1) % 50 === 0 || i === identifiers.length - 1) {
        console.log(`  [${i + 1}/${identifiers.length}] images=${readyImages} texts=${readyTexts} skipped=${skipped}`)
        // Checkpoint save
        saveJson(METADATA_FILE, {
          metadata_at: new Date().toISOString(),
          items: results,
          stats: { ready_images: readyImages, ready_texts: readyTexts, skipped, skip_reasons: skipReasons },
        })
      }
    } catch (err) {
      console.error(`  [error] ${id}: ${err.message}`)
      results[id] = {
        mediatype,
        title: search.items[id].title,
        selected_file: null,
        download_url: null,
        status: 'skipped',
        skip_reason: `error: ${err.message}`,
      }
      skipped++
      skipReasons['fetch_error'] = (skipReasons['fetch_error'] ?? 0) + 1
    }

    await sleep(300)
  }

  const final = {
    metadata_at: new Date().toISOString(),
    items: results,
    stats: { ready_images: readyImages, ready_texts: readyTexts, skipped, skip_reasons: skipReasons },
  }
  saveJson(METADATA_FILE, final)

  console.log(`\n[metadata] Complete:`)
  console.log(`  Ready images: ${readyImages}`)
  console.log(`  Ready texts/PDFs: ${readyTexts}`)
  console.log(`  Skipped: ${skipped}`)
  if (Object.keys(skipReasons).length > 0) {
    console.log(`  Skip reasons:`)
    for (const [reason, count] of Object.entries(skipReasons)) {
      console.log(`    ${reason}: ${count}`)
    }
  }
}

// ─── Phase 3: Upload Images to R2 ──────────────────────────────────

async function uploadImages() {
  const metadata = loadJson(METADATA_FILE)
  if (!metadata) throw new Error(`${METADATA_FILE} not found. Run --metadata first.`)

  // Filter to ready images only
  const imageItems = Object.entries(metadata.items)
    .filter(([, v]) => v.status === 'ready' && v.mediatype === 'image')

  console.log(`[upload] ${imageItems.length} images to upload to R2 (grimoire bucket)...`)

  // Load existing progress
  const existing = loadJson(UPLOAD_FILE)
  const uploaded = existing?.uploaded ?? {}
  let successCount = Object.values(uploaded).filter(v => v.status === 'uploaded').length
  let failCount = Object.values(uploaded).filter(v => v.status === 'failed').length

  const tempDir = join(tmpdir(), 'grimoire-archive-upload')
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })

  for (const [id, item] of imageItems) {
    if (uploaded[id]?.status === 'uploaded') continue // Already done

    const filename = item.selected_file.filename
    const r2Key = `image-candidates/psychedelic-art/${id}/${filename}`
    const tempFile = join(tempDir, `${id}_${filename}`.replace(/[^a-zA-Z0-9._-]/g, '_'))

    try {
      // Download from IA
      console.log(`  [download] ${id}: ${filename} (${item.selected_file.sizeMB}MB)`)
      const res = await fetch(item.download_url, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)

      const buffer = Buffer.from(await res.arrayBuffer())
      writeFileSync(tempFile, buffer)

      // Upload to R2 grimoire bucket
      console.log(`  [upload] ${r2Key}`)
      execSync(
        `npx wrangler r2 object put "grimoire/${r2Key}" --file "${tempFile}" --remote`,
        { stdio: 'pipe', cwd: join(__dirname, '..', '..') }
      )

      uploaded[id] = { status: 'uploaded', r2Key, filename, sizeMB: item.selected_file.sizeMB }
      successCount++
    } catch (err) {
      console.error(`  [error] ${id}: ${err.message}`)
      uploaded[id] = { status: 'failed', error: err.message }
      failCount++
    } finally {
      // Clean up temp file
      try { unlinkSync(tempFile) } catch {}
    }

    // Checkpoint every 10 uploads
    if ((successCount + failCount) % 10 === 0) {
      saveJson(UPLOAD_FILE, { uploaded_at: new Date().toISOString(), uploaded, stats: { success: successCount, failed: failCount } })
    }
  }

  // Write manifest to R2
  const manifest = {
    campaign: 'psychedelic-art',
    created_at: new Date().toISOString(),
    items: Object.entries(uploaded)
      .filter(([, v]) => v.status === 'uploaded')
      .map(([id, v]) => ({ identifier: id, r2Key: v.r2Key, filename: v.filename, sizeMB: v.sizeMB })),
  }

  const manifestTemp = join(tempDir, '_manifest.json')
  writeFileSync(manifestTemp, JSON.stringify(manifest, null, 2))
  try {
    execSync(
      `npx wrangler r2 object put "grimoire/image-candidates/psychedelic-art/_manifest.json" --file "${manifestTemp}" --remote`,
      { stdio: 'pipe', cwd: join(__dirname, '..', '..') }
    )
    console.log(`  [manifest] Written to R2`)
  } catch (err) {
    console.error(`  [manifest] Failed: ${err.message}`)
  }
  try { unlinkSync(manifestTemp) } catch {}

  saveJson(UPLOAD_FILE, { uploaded_at: new Date().toISOString(), uploaded, stats: { success: successCount, failed: failCount } })

  console.log(`\n[upload] Complete:`)
  console.log(`  Uploaded: ${successCount}`)
  console.log(`  Failed: ${failCount}`)
}

// ─── Phase 4: Ingest ────────────────────────────────────────────────

async function ingest() {
  const metadata = loadJson(METADATA_FILE)
  if (!metadata) throw new Error(`${METADATA_FILE} not found. Run --metadata first.`)

  // --- Image batch extraction (no auth required) ---
  const upload = loadJson(UPLOAD_FILE)
  const uploadedCount = upload
    ? Object.values(upload.uploaded).filter(v => v.status === 'uploaded').length
    : 0

  if (uploadedCount > 0) {
    console.log(`[ingest] Triggering image batch extraction for ${uploadedCount} uploaded images...`)
    let totalProcessed = 0
    let totalFailed = 0
    let invocations = 0

    while (true) {
      invocations++
      try {
        const res = await fetch(`${GRIMOIRE_URL}/image/extract/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prefix: 'image-candidates/psychedelic-art/',
            limit: 25,
          }),
        })

        if (!res.ok) {
          const text = await res.text()
          console.error(`  [error] Batch ${invocations}: HTTP ${res.status}: ${text.slice(0, 300)}`)
          break
        }

        const data = await res.json()
        totalProcessed += data.processed ?? 0
        totalFailed += data.failed ?? 0
        const remaining = data.remaining ?? 0

        console.log(`  [batch ${invocations}] processed=${data.processed} failed=${data.failed} skipped=${data.skipped} remaining=${remaining}`)

        if (remaining === 0) {
          console.log(`  [images] All images processed.`)
          break
        }

        // Brief pause between batch invocations
        await sleep(2000)
      } catch (err) {
        console.error(`  [error] Batch ${invocations}: ${err.message}`)
        break
      }
    }

    console.log(`  [images] Total: ${invocations} invocations, ${totalProcessed} processed, ${totalFailed} failed`)
  } else {
    console.log('[ingest] No uploaded images found. Skipping image extraction.')
  }

  // --- PDF ingestion (auth required) ---
  const pdfItems = Object.entries(metadata.items)
    .filter(([, v]) => v.status === 'ready' && v.mediatype === 'texts')

  if (pdfItems.length > 0) {
    console.log(`\n[ingest] Ingesting ${pdfItems.length} PDFs via fromPdf adapter...`)
    const token = getServiceToken()
    let pdfSuccess = 0
    let pdfFail = 0

    for (const [id, item] of pdfItems) {
      try {
        const res = await fetch(`${HOBBOT_URL}/api/v1/ingest/pdf`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: item.download_url,
            source_type: 'aesthetic',
            tags: ['psychedelic-art', 'archive-org'],
          }),
        })

        if (!res.ok) {
          const text = await res.text()
          console.error(`  [fail] ${id}: HTTP ${res.status}: ${text.slice(0, 200)}`)
          pdfFail++
        } else {
          const data = await res.json()
          console.log(`  [ok] ${id}: ${item.title?.slice(0, 60)}`)
          pdfSuccess++
        }
      } catch (err) {
        console.error(`  [fail] ${id}: ${err.message}`)
        pdfFail++
      }

      await sleep(5000) // Pipeline does heavy AI work per PDF
    }

    console.log(`\n  [pdfs] Total: ${pdfSuccess} success, ${pdfFail} failed`)
  } else {
    console.log('[ingest] No ready PDFs found. Skipping PDF ingestion.')
  }
}

// ─── Phase 5: Audit ─────────────────────────────────────────────────

async function audit() {
  console.log('[audit] Querying post-ingest counts...')

  try {
    const imageCandidates = await queryD1(
      "SELECT COUNT(*) as count, status FROM image_extraction_candidates WHERE source_url LIKE '%psychedelic-art%' GROUP BY status"
    )
    console.log('  Image extraction candidates:')
    for (const row of imageCandidates) {
      console.log(`    ${row.status}: ${row.count}`)
    }
  } catch (err) {
    console.log(`  Image candidates query failed: ${err.message}`)
  }

  try {
    const ingestLogs = await queryD1(
      "SELECT COUNT(*) as count, status FROM ingest_log WHERE url LIKE '%archive.org%' GROUP BY status"
    )
    console.log('  PDF ingest log (archive.org):')
    for (const row of ingestLogs) {
      console.log(`    ${row.status}: ${row.count}`)
    }
  } catch (err) {
    console.log(`  Ingest log query failed: ${err.message}`)
  }

  // Load local stats
  const search = loadJson(SEARCH_FILE)
  const metadata = loadJson(METADATA_FILE)
  const upload = loadJson(UPLOAD_FILE)

  if (search) {
    console.log(`\n  Search stats:`)
    console.log(`    Unique identifiers: ${search.stats.total_unique}`)
    console.log(`    Images: ${search.stats.total_image}`)
    console.log(`    Texts: ${search.stats.total_texts}`)
    if (search.zero_result_queries.length > 0) {
      console.log(`    Zero-result queries: ${search.zero_result_queries.join(', ')}`)
    }
  }

  if (metadata) {
    console.log(`  Metadata stats:`)
    console.log(`    Ready images: ${metadata.stats.ready_images}`)
    console.log(`    Ready texts: ${metadata.stats.ready_texts}`)
    console.log(`    Skipped: ${metadata.stats.skipped}`)
    if (metadata.stats.skip_reasons) {
      for (const [reason, count] of Object.entries(metadata.stats.skip_reasons)) {
        console.log(`      ${reason}: ${count}`)
      }
    }
  }

  if (upload) {
    console.log(`  Upload stats:`)
    console.log(`    Uploaded: ${upload.stats.success}`)
    console.log(`    Failed: ${upload.stats.failed}`)
  }
}

// ─── CLI ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

try {
  if (args.includes('--search')) {
    await searchIA()
  } else if (args.includes('--metadata')) {
    await fetchMetadata()
  } else if (args.includes('--upload')) {
    await uploadImages()
  } else if (args.includes('--ingest')) {
    await ingest()
  } else if (args.includes('--audit')) {
    await audit()
  } else {
    console.log('Archive.org Psychedelic/Visionary Art Batch Ingestion')
    console.log('')
    console.log('Usage:')
    console.log('  node scripts/ingest/archive-psychedelic.mjs --search     # Search IA + deduplicate')
    console.log('  node scripts/ingest/archive-psychedelic.mjs --metadata   # Fetch metadata + select files')
    console.log('  node scripts/ingest/archive-psychedelic.mjs --upload     # Download images, upload to R2')
    console.log('  node scripts/ingest/archive-psychedelic.mjs --ingest     # Trigger ingestion pipelines')
    console.log('  node scripts/ingest/archive-psychedelic.mjs --audit      # Post-run verification')
    console.log('')
    console.log('Run phases in order. Each phase saves progress and is resumable.')
  }
} catch (err) {
  console.error(`[fatal] ${err.message}`)
  process.exit(1)
}
