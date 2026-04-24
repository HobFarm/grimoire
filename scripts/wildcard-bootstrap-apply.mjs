#!/usr/bin/env node
// Phase 2 of the wildcard bootstrap. Reads the manifest produced by
// scripts/wildcard-bootstrap.mjs and POSTs each stage in chunks to
// /admin/wildcard-bootstrap/apply on the grimoire worker.
//
// Idempotent: re-running re-applies INSERT OR IGNORE statements; skipped counts
// will dominate on the second run.
//
// Stages, in order:
//   1. tags                  — insert tag definitions
//   2. atom_tags             — junction rows linking atoms to tags
//   3. memberships           — dimension_memberships rows for axis files
//   4. correspondences       — co-membership pairs (small files only)
//   5. correspondences       — movement-membership edges (artist -> movement)
//
// Usage:
//   node scripts/wildcard-bootstrap-apply.mjs                 # full
//   node scripts/wildcard-bootstrap-apply.mjs --validation-batch
//   node scripts/wildcard-bootstrap-apply.mjs --dry-run
//   node scripts/wildcard-bootstrap-apply.mjs --manifest path/to/manifest.json

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const ADMIN_URL = process.env.GRIMOIRE_ADMIN_URL
  || 'https://grimoire.damp-violet-bf89.workers.dev/admin/wildcard-bootstrap/apply'
const SERVICE_TOKEN = process.env.GRIMOIRE_SERVICE_TOKEN || 'hf-svc-9k3mX7pRwL2nYdQ8vB4jF6'
const OUTPUT_DIR = 'scripts/output'

const REQUEST_CHUNK = 100             // items per HTTP request
const REQUEST_TIMEOUT_MS = 60_000
const PROGRESS_EVERY_REQUESTS = 50
const REQUEST_RETRY_LIMIT = 5
const VALIDATION_PREFIX_RE = /^(body|clothing|attire|material)/i
const VALIDATION_CORR_CAP = 10_000  // subsample Stage 4 in --validation-batch mode

// --- args ---
const args = process.argv.slice(2)
const validationBatch = args.includes('--validation-batch')
const dryRun = args.includes('--dry-run')
const manifestPathArg = args.indexOf('--manifest')
const manifestPath = manifestPathArg >= 0 ? args[manifestPathArg + 1] : null

// --- helpers ---
async function fetchWithRetry(body, attempt = 1) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const r = await fetch(ADMIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_TOKEN}`,
        'Connection': 'close', // sidestep keepalive issues with cloudflare / undici
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      if (attempt < REQUEST_RETRY_LIMIT && (r.status === 500 || r.status === 502 || r.status === 503 || r.status === 504 || r.status === 524)) {
        await new Promise(res => setTimeout(res, 1000 * attempt))
        return fetchWithRetry(body, attempt + 1)
      }
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`)
    }
    return r.json()
  } catch (err) {
    // Retry on socket-level failures (UND_ERR_SOCKET, "other side closed", AbortError, ECONNRESET, etc.)
    const cause = err.cause
    const causeCode = cause && typeof cause === 'object' ? cause.code : null
    const isSocketErr = err.name === 'AbortError'
      || err.name === 'TypeError'   // undici "fetch failed" wrapper
      || causeCode === 'UND_ERR_SOCKET'
      || causeCode === 'ECONNRESET'
      || causeCode === 'EPIPE'
      || causeCode === 'ETIMEDOUT'
    if (isSocketErr && attempt < REQUEST_RETRY_LIMIT) {
      const delay = 1000 * attempt
      console.error(`  [transient ${err.name}/${causeCode || '?'}, retry ${attempt}/${REQUEST_RETRY_LIMIT} in ${delay}ms]`)
      await new Promise(res => setTimeout(res, delay))
      return fetchWithRetry(body, attempt + 1)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function applyStage(stage, payload) {
  const totals = { stage, inserted: 0, skipped: 0, missing_tags: 0, requests: 0 }
  if (payload.length === 0) {
    console.error(`  [${stage}] empty payload, skipping stage`)
    return totals
  }
  const batches = chunk(payload, REQUEST_CHUNK)
  console.error(`  [${stage}] ${payload.length} items in ${batches.length} requests (chunk=${REQUEST_CHUNK})`)
  const startMs = Date.now()
  for (let i = 0; i < batches.length; i++) {
    const result = await fetchWithRetry({ stage, payload: batches[i], dry_run: dryRun })
    totals.inserted += result.inserted ?? 0
    totals.skipped += result.skipped ?? 0
    if (result.missing_tags) totals.missing_tags += result.missing_tags
    totals.requests++
    if (totals.requests % PROGRESS_EVERY_REQUESTS === 0) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(0)
      const pct = ((totals.requests / batches.length) * 100).toFixed(1)
      console.error(`    ...${totals.requests}/${batches.length} (${pct}%) inserted=${totals.inserted} skipped=${totals.skipped} elapsed=${elapsed}s`)
    }
  }
  console.error(`  [${stage}] done: inserted=${totals.inserted} skipped=${totals.skipped} requests=${totals.requests}`)
  return totals
}

// Build per-stage payloads from the manifest. Filter by validation prefix if set.
function buildPayloads(manifest) {
  const atomFilter = (a) => {
    if (!validationBatch) return true
    return a.files.some(f => VALIDATION_PREFIX_RE.test(f))
  }
  const fileFilter = (file) => {
    if (!validationBatch) return true
    return VALIDATION_PREFIX_RE.test(file)
  }

  // 1. tags — every (slug, category) pair encountered in the manifest's tags + per-atom tag sets + movement tags.
  const tagSet = new Map() // slug -> {slug, category}
  for (const slug of Object.keys(manifest.tags || {})) {
    if (validationBatch) {
      const files = manifest.tags[slug] || []
      if (!files.some(fileFilter)) continue
    }
    const [category] = slug.split(':', 1)
    tagSet.set(slug, { slug, category })
  }
  // movement tags
  for (const slug of Object.keys(manifest.movement_files || {})) {
    if (validationBatch) {
      const m = manifest.movement_files[slug]
      if (!fileFilter(m.file)) continue
    }
    const [category] = slug.split(':', 1)
    tagSet.set(slug, { slug, category })
  }
  // yaml-derived tags appear on per-atom records, not in manifest.tags. Sweep those:
  for (const [, atom] of Object.entries(manifest.atoms || {})) {
    if (!atomFilter(atom)) continue
    for (const t of (atom.tags_from_yaml || [])) {
      const [category] = t.split(':', 1)
      tagSet.set(t, { slug: t, category })
    }
  }
  const tags = Array.from(tagSet.values())

  // 2. atom_tags — cross-product of resolved atoms and their tag sets.
  const atomTags = []
  for (const [, atom] of Object.entries(manifest.atoms || {})) {
    if (!atomFilter(atom)) continue
    const tagsForAtom = new Set([...(atom.tags_from_files || []), ...(atom.tags_from_yaml || [])])
    for (const tag of tagsForAtom) {
      if (!tagSet.has(tag)) continue  // skip tags not in our payload
      atomTags.push({ atom_id: atom.atom_id, tag_slug: tag })
    }
  }

  // 3. memberships — from atom.axes
  const memberships = []
  for (const [, atom] of Object.entries(manifest.atoms || {})) {
    if (!atomFilter(atom)) continue
    for (const a of (atom.axes || [])) {
      memberships.push({ atom_id: atom.atom_id, axis_slug: a.axis, pole: a.pole })
    }
  }

  // 4. co-membership correspondences — pairs within each non-skip file.
  // Build atom-id-per-file index by inverting manifest.atoms[*].files.
  const atomsByFile = new Map() // file -> Set<atom_id>
  for (const [, atom] of Object.entries(manifest.atoms || {})) {
    for (const f of atom.files) {
      if (validationBatch && !fileFilter(f)) continue
      let s = atomsByFile.get(f)
      if (!s) { s = new Set(); atomsByFile.set(f, s) }
      s.add(atom.atom_id)
    }
  }
  // Skip files whose manifest record says skipCoMembership=true.
  const skipCoSet = new Set((manifest.files || []).filter(f => f.skipCoMembership).map(f => f.file))
  const coPairs = []
  for (const [file, atomIds] of atomsByFile) {
    if (skipCoSet.has(file)) continue
    const ids = Array.from(atomIds)
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (ids[i] === ids[j]) continue
        coPairs.push({ atom_a_id: ids[i], atom_b_id: ids[j], source: 'wildcard-co-membership', file })
      }
    }
  }

  // 5. movement correspondences — per-member edges to the movement atom.
  const movementPairs = []
  for (const [slug, info] of Object.entries(manifest.movement_files || {})) {
    if (!info.movementAtomId) continue
    if (validationBatch && !fileFilter(info.file)) continue
    const memberIds = atomsByFile.get(info.file)
    if (!memberIds) continue
    for (const memberId of memberIds) {
      if (memberId === info.movementAtomId) continue
      movementPairs.push({
        atom_a_id: memberId,
        atom_b_id: info.movementAtomId,
        source: 'movement-membership',
        movement: slug,
        file: info.file,
      })
    }
  }

  return { tags, atomTags, memberships, coPairs, movementPairs }
}

async function findLatestManifest() {
  const entries = await readdir(OUTPUT_DIR)
  const candidates = entries
    .filter(e => /^wildcard-bootstrap-\d{4}-\d{2}-\d{2}\.json$/.test(e))
    .sort()
    .reverse()
  if (candidates.length === 0) throw new Error('no wildcard-bootstrap-YYYY-MM-DD.json found in scripts/output/')
  return join(OUTPUT_DIR, candidates[0])
}

async function main() {
  const path = manifestPath || await findLatestManifest()
  console.error(`reading manifest: ${path}`)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  console.error(`manifest stats: ${JSON.stringify(manifest.stats)}`)
  if (validationBatch) console.error('mode: --validation-batch (filtered to body|clothing|attire|material)')
  if (dryRun) console.error('mode: --dry-run (no writes)')
  console.error(`endpoint: ${ADMIN_URL}\n`)

  const { tags, atomTags, memberships, coPairs, movementPairs } = buildPayloads(manifest)
  console.error(`payload counts: tags=${tags.length} atom_tags=${atomTags.length} memberships=${memberships.length} co_pairs=${coPairs.length} movement_pairs=${movementPairs.length}`)
  console.error('')

  const totals = {}
  console.error('Stage 1: tags')
  totals.tags = await applyStage('tags', tags)
  console.error('\nStage 2: atom_tags')
  totals.atom_tags = await applyStage('atom_tags', atomTags)
  console.error('\nStage 3: memberships')
  totals.memberships = await applyStage('memberships', memberships)
  console.error('\nStage 4: co-membership correspondences')
  let stage4Pairs = coPairs
  if (validationBatch && coPairs.length > VALIDATION_CORR_CAP) {
    console.error(`  [validation] capping Stage 4 from ${coPairs.length} to ${VALIDATION_CORR_CAP} pairs`)
    stage4Pairs = coPairs.slice(0, VALIDATION_CORR_CAP)
  }
  totals.co_correspondences = await applyStage('correspondences', stage4Pairs)
  console.error('\nStage 5: movement correspondences')
  totals.movement_correspondences = await applyStage('correspondences', movementPairs)

  await mkdir(OUTPUT_DIR, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const suffix = validationBatch ? '-validation' : '-full'
  const dryTag = dryRun ? '-dryrun' : ''
  const reportPath = join(OUTPUT_DIR, `wildcard-apply-${date}${suffix}${dryTag}.json`)
  await writeFile(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), manifest_path: path, dry_run: dryRun, validation_batch: validationBatch, totals }, null, 2))

  console.error('\n=== Apply Summary ===')
  console.error(JSON.stringify(totals, null, 2))
  console.error(`\nReport: ${reportPath}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
