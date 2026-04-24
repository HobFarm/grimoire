#!/usr/bin/env node
/**
 * MJ Vocabulary Extraction + Grimoire Audit Script
 *
 * Extracts aesthetic vocabulary from Midjourney /describe prompts,
 * queries Grimoire for each term, and produces a structured audit report.
 *
 * Usage:
 *   node scripts/mj-vocab-audit.mjs                  # full run
 *   node scripts/mj-vocab-audit.mjs --extract-only    # extraction only (no D1)
 *   node scripts/mj-vocab-audit.mjs --skip-vector     # skip tier 3 vector search
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryD1 } from './ingest/utils/d1.mjs'
import { WORKER_URL, sleep } from './ingest/utils/env.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const INPUT_FILE = join(__dirname, '..', '_notes', 'midjourney describe prompts - all.txt')
const OUTPUT_FILE = join(__dirname, '_data', 'mj-audit-report.json')

const args = process.argv.slice(2)
const EXTRACT_ONLY = args.includes('--extract-only')
const SKIP_VECTOR = args.includes('--skip-vector')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLOR_WORDS = new Set([
  'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'violet', 'cyan',
  'magenta', 'amber', 'bronze', 'gold', 'silver', 'crimson', 'indigo',
  'navy', 'emerald', 'scarlet', 'ivory', 'onyx', 'brown', 'white', 'black',
  'gray', 'grey', 'pink', 'teal', 'turquoise', 'coral', 'maroon', 'burgundy',
  'olive', 'cream', 'beige', 'tan', 'azure', 'cobalt', 'slate', 'charcoal',
  'pewter', 'copper', 'brass', 'rose', 'mauve', 'lavender', 'lilac', 'plum',
  'sage', 'mint', 'aqua', 'rust', 'sienna', 'umber', 'ochre', 'khaki',
])

const COLOR_MODIFIERS = new Set([
  'dark', 'light', 'deep', 'pale', 'bright', 'muted', 'warm', 'cool',
])

const FILM_STOCK_STEMS = [
  'cinestill', 'ferrania', 'provia', 'portra', 'ektar', 'kodachrome',
  'velvia', 'ilford', 'tri-x', 'hp5', 'delta', 'fujifilm', 'fujichrome',
  'ektachrome', 'kodak',
]

const CAMERA_BODY_STEMS = [
  'nikon', 'canon', 'hasselblad', 'leica', 'sony', 'pentax', 'mamiya',
  'phase one', 'sigma', 'fuji x', 'olympus',
]

const QUALITY_PATTERNS = [
  /\buhd\b/, /\b32k\b/, /\b8k\b/, /\b4k\b/, /\bhdr\b/,
  /\bhigh detail\b/, /\bultra detailed\b/, /\bphotorealistic\b/,
  /\buhd image\b/, /\b\d+k uhd\b/, /\b\d+k resolution\b/,
  /\b\d{3,4}x\d{3,4}\b/, /\bhyperrealistic\b/, /\bultra hd\b/,
]

const RENDERING_ENGINES = [
  'unreal engine', 'octane render', 'cinema 4d', 'v-ray', 'blender',
  'unity engine', 'cryengine', 'ray tracing',
]

// Expected categories by term type (for classification_inconsistency detection)
const EXPECTED_CATEGORIES = {
  core: ['style.genre', 'style.medium', 'style.era'],
  punk: ['style.genre', 'style.medium', 'style.era'],
  wave: ['style.genre', 'style.medium', 'style.era'],
  artist: ['reference.person', 'reference.film'],
  color_pair: ['color.palette'],
}

// ---------------------------------------------------------------------------
// Phase 1: Term Extraction
// ---------------------------------------------------------------------------

function readPrompts() {
  const raw = readFileSync(INPUT_FILE, 'utf-8')
  const lines = raw.split(/\r?\n/)

  // File has a blank line between every prompt. Collect all non-blank lines first,
  // then group into source images (4 prompts per source image, sequential).
  const prompts = lines.map(l => l.trim()).filter(l => l.length > 0)

  const PROMPTS_PER_IMAGE = 4
  const images = []
  for (let i = 0; i < prompts.length; i += PROMPTS_PER_IMAGE) {
    images.push(prompts.slice(i, i + PROMPTS_PER_IMAGE))
  }

  return images
}

function classifySegment(segment) {
  const lower = segment.toLowerCase().trim()
  if (!lower || lower.length < 2) return null

  // -core terms
  if (/\b\w+core\b/.test(lower)) return { type: 'core', term: lower.match(/\b\w+core\b/)[0] }

  // -punk terms
  if (/\b\w+punk\b/.test(lower)) return { type: 'punk', term: lower.match(/\b\w+punk\b/)[0] }

  // -wave terms
  if (/\b\w+wave\b/.test(lower)) return { type: 'wave', term: lower.match(/\b\w+wave\b/)[0] }

  // Rendering engines (check before quality boosters)
  for (const engine of RENDERING_ENGINES) {
    if (lower.includes(engine)) return { type: 'rendering_engine', term: lower }
  }

  // Quality boosters
  for (const pat of QUALITY_PATTERNS) {
    if (pat.test(lower)) return { type: 'quality_booster', term: lower }
  }

  // Film stocks
  for (const stem of FILM_STOCK_STEMS) {
    if (lower.includes(stem)) return { type: 'film_stock', term: lower }
  }

  // Camera bodies
  for (const stem of CAMERA_BODY_STEMS) {
    if (lower.includes(stem)) return { type: 'camera_body', term: lower }
  }

  // Color pairs: "X and Y" where both sides contain color words
  const andMatch = lower.match(/^(.+?)\s+and\s+(.+)$/)
  if (andMatch) {
    const left = andMatch[1].trim().split(/\s+/)
    const right = andMatch[2].trim().split(/\s+/)
    const leftHasColor = left.some(w => COLOR_WORDS.has(w) || COLOR_MODIFIERS.has(w))
    const rightHasColor = right.some(w => COLOR_WORDS.has(w) || COLOR_MODIFIERS.has(w))
    if (leftHasColor && rightHasColor) return { type: 'color_pair', term: lower }
  }

  return null
}

function extractArtists(prompt) {
  const artists = []
  const regex = /in the style of\s+([^,]+)/gi
  let match
  while ((match = regex.exec(prompt)) !== null) {
    const artist = match[1].trim().toLowerCase()
    if (artist.length > 1) artists.push(artist)
  }
  return artists
}

function extractTerms(images) {
  // Map<lowercaseTerm, { type, promptCount, imageSet }>
  const terms = new Map()

  function record(term, type, imageIdx) {
    const key = term.toLowerCase().trim()
    if (!key || key.length < 2) return
    if (!terms.has(key)) {
      terms.set(key, { type, promptCount: 0, imageSet: new Set() })
    }
    const entry = terms.get(key)
    entry.promptCount++
    entry.imageSet.add(imageIdx)
  }

  for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
    const prompts = images[imgIdx]
    for (const prompt of prompts) {
      // Extract artists from "in the style of" before comma splitting.
      // Reclassify if the term matches a more specific type.
      const artists = extractArtists(prompt)
      for (const artist of artists) {
        const reclassified = classifySegment(artist)
        if (reclassified) {
          record(reclassified.term, reclassified.type, imgIdx)
        } else {
          record(artist, 'artist', imgIdx)
        }
      }

      // Split on commas, classify each segment
      const segments = prompt.split(',').map(s => s.trim())
      for (const segment of segments) {
        // Skip the subject description (first segment, usually long)
        // and "in the style of X" segments (already captured as artists)
        if (/^in the style of/i.test(segment)) continue

        const classified = classifySegment(segment)
        if (classified) {
          record(classified.term, classified.type, imgIdx)
        }
      }
    }
  }

  return terms
}

// ---------------------------------------------------------------------------
// Phase 2: Grimoire Query
// ---------------------------------------------------------------------------

const QUERY_BATCH_SIZE = 80 // D1 binding limit ~100, leave margin

async function tier1ExactLookup(uniqueTerms) {
  console.log(`[tier1] Querying ${uniqueTerms.length} terms in batches of ${QUERY_BATCH_SIZE}...`)
  const atomsByTerm = new Map() // term -> AtomRow[]

  for (let i = 0; i < uniqueTerms.length; i += QUERY_BATCH_SIZE) {
    const batch = uniqueTerms.slice(i, i + QUERY_BATCH_SIZE)
    const placeholders = batch.map(t => `'${t.replace(/'/g, "''")}'`).join(',')
    const sql = `SELECT id, text, text_lower, category_slug, source, source_app, collection_slug, status, harmonics, register
      FROM atoms WHERE text_lower IN (${placeholders}) AND status <> 'rejected'`

    try {
      const rows = await queryD1(sql)
      for (const row of rows) {
        const key = row.text_lower
        if (!atomsByTerm.has(key)) atomsByTerm.set(key, [])
        atomsByTerm.get(key).push(row)
      }
    } catch (err) {
      console.error(`  [tier1] Batch ${i} failed: ${err.message}`)
    }

    if (i + QUERY_BATCH_SIZE < uniqueTerms.length) await sleep(200)
  }

  console.log(`[tier1] Found atoms for ${atomsByTerm.size} terms`)
  return atomsByTerm
}

async function tier2FtsLookup(terms) {
  if (terms.length === 0) return new Map()
  console.log(`[tier2] FTS5 search for ${terms.length} unfound terms...`)
  const atomsByTerm = new Map()

  for (const term of terms) {
    const escaped = term.replace(/'/g, "''").replace(/"/g, '""')
    const sql = `SELECT a.id, a.text, a.text_lower, a.category_slug, a.source, a.source_app, a.collection_slug, a.status, a.harmonics, a.register
      FROM atoms a WHERE a.rowid IN (SELECT rowid FROM atoms_fts WHERE atoms_fts MATCH '"${escaped}"') AND a.status <> 'rejected' LIMIT 5`

    try {
      const rows = await queryD1(sql)
      if (rows.length > 0) {
        atomsByTerm.set(term, rows)
      }
    } catch (err) {
      // FTS can fail on special characters, skip silently
    }

    await sleep(100)
  }

  console.log(`[tier2] Found atoms for ${atomsByTerm.size} terms via FTS5`)
  return atomsByTerm
}

async function tier3VectorSearch(terms) {
  if (terms.length === 0) return new Map()
  console.log(`[tier3] Vector search for ${terms.length} unfound terms...`)
  const atomsByTerm = new Map()

  // Read service token from env.local
  let serviceToken = process.env.HOBBOT_SERVICE_TOKEN
  if (!serviceToken) {
    // Try extracting from env.local
    try {
      const envLocal = readFileSync(join(__dirname, '..', 'env.local'), 'utf-8')
      const match = envLocal.match(/HOBBOT_SERVICE_TOKEN=(.+)/)
      if (match) serviceToken = match[1].trim().split(':').pop()
    } catch {}
  }
  if (!serviceToken) {
    console.warn('  [tier3] No service token found, skipping vector search')
    return atomsByTerm
  }

  for (const term of terms) {
    try {
      const res = await fetch(`${WORKER_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({ query: term, limit: 5 }),
      })

      if (res.ok) {
        const data = await res.json()
        const results = data.results || data
        if (Array.isArray(results) && results.length > 0) {
          atomsByTerm.set(term, results.map(r => r.atom || r))
        }
      }
    } catch (err) {
      // Skip silently
    }

    await sleep(300)
  }

  console.log(`[tier3] Found atoms for ${atomsByTerm.size} terms via vector search`)
  return atomsByTerm
}

// ---------------------------------------------------------------------------
// Phase 3: Report Generation
// ---------------------------------------------------------------------------

function parseHarmonics(harmonicsStr) {
  if (!harmonicsStr || harmonicsStr === '{}') return null
  try {
    return typeof harmonicsStr === 'string' ? JSON.parse(harmonicsStr) : harmonicsStr
  } catch {
    return null
  }
}

function formatAtom(row) {
  return {
    id: row.id,
    category: row.category_slug,
    source: row.source,
    source_app: row.source_app || null,
    collection: row.collection_slug,
    harmonics: parseHarmonics(row.harmonics),
    register: row.register,
  }
}

function detectIssues(termType, atoms) {
  const issues = []

  // Duplicate detection
  if (atoms.length > 1) {
    issues.push({
      type: 'duplicate',
      detail: `${atoms.length} atoms with same text_lower across ${[...new Set(atoms.map(a => a.source || a.source_app))].join(', ')}`,
    })
  }

  // Type-aware classification inconsistency
  const expected = EXPECTED_CATEGORIES[termType]
  if (expected) {
    for (const atom of atoms) {
      const cat = atom.category || atom.category_slug
      if (cat && !expected.includes(cat)) {
        issues.push({
          type: 'classification_inconsistency',
          detail: `atom ${atom.id} categorized as ${cat}, expected ${expected.join(' or ')}`,
        })
      }
    }
  }

  return issues
}

function buildReport(images, terms, atomsByTerm) {
  const reportTerms = []
  const summary = {
    total_unique_terms: terms.size,
    found_clean: 0,
    found_with_issues: 0,
    not_found: 0,
    total_duplicates: 0,
    total_classification_inconsistencies: 0,
    skip_ingestion: 0,
  }
  const byType = {}
  const SKIP_TYPES = new Set(['film_stock', 'camera_body', 'quality_booster', 'rendering_engine'])

  for (const [term, info] of terms) {
    const { type, promptCount, imageSet } = info
    const isSkip = SKIP_TYPES.has(type)

    // Init type summary
    if (!byType[type]) {
      byType[type] = isSkip
        ? { skip: true, count: 0 }
        : { found: 0, found_with_issues: 0, not_found: 0 }
    }

    if (isSkip) {
      byType[type].count++
      summary.skip_ingestion++
      reportTerms.push({
        term, type,
        frequency: { prompt_count: promptCount, image_count: imageSet.size },
        grimoire_status: 'skip_ingestion',
        atoms: [],
        issues: [],
      })
      continue
    }

    const atoms = (atomsByTerm.get(term) || []).map(formatAtom)
    const issues = detectIssues(type, atoms)

    let status
    if (atoms.length === 0) {
      status = 'not_found'
      summary.not_found++
      byType[type].not_found++
    } else if (issues.length > 0) {
      status = 'found_with_issues'
      summary.found_with_issues++
      byType[type].found_with_issues++
    } else {
      status = 'found'
      summary.found_clean++
      byType[type].found++
    }

    // Count issue types
    for (const issue of issues) {
      if (issue.type === 'duplicate') summary.total_duplicates++
      if (issue.type === 'classification_inconsistency') summary.total_classification_inconsistencies++
    }

    reportTerms.push({
      term, type,
      frequency: { prompt_count: promptCount, image_count: imageSet.size },
      grimoire_status: status,
      atoms,
      issues,
    })
  }

  // Sort terms within type groups by image_count descending
  reportTerms.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    return b.frequency.image_count - a.frequency.image_count
  })

  // Count prompts
  let totalPrompts = 0
  for (const img of images) totalPrompts += img.length

  return {
    generated_at: new Date().toISOString(),
    source_file: 'midjourney describe prompts - all.txt',
    total_prompts: totalPrompts,
    total_source_images: images.length,
    extraction_summary: buildExtractionSummary(terms),
    terms: reportTerms,
    summary,
    by_type_summary: byType,
  }
}

function buildExtractionSummary(terms) {
  const counts = {}
  for (const [, info] of terms) {
    counts[info.type] = (counts[info.type] || 0) + 1
  }
  return {
    core_terms: counts.core || 0,
    punk_terms: counts.punk || 0,
    wave_terms: counts.wave || 0,
    artist_references: counts.artist || 0,
    film_stocks: counts.film_stock || 0,
    camera_bodies: counts.camera_body || 0,
    color_pairs: counts.color_pair || 0,
    quality_boosters: counts.quality_booster || 0,
    rendering_engines: counts.rendering_engine || 0,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== MJ Vocabulary Audit ===\n')

  // Phase 1: Extract
  console.log('[phase1] Reading prompts...')
  const images = readPrompts()
  console.log(`  ${images.length} source images, ${images.reduce((s, i) => s + i.length, 0)} prompts`)

  console.log('[phase1] Extracting terms...')
  const terms = extractTerms(images)
  const extractionSummary = buildExtractionSummary(terms)
  console.log('  Extraction summary:', JSON.stringify(extractionSummary, null, 2))

  if (EXTRACT_ONLY) {
    // Write extraction-only report
    const report = buildReport(images, terms, new Map())
    writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2))
    console.log(`\n[done] Extraction-only report written to ${OUTPUT_FILE}`)
    return
  }

  // Phase 2: Query Grimoire
  console.log('\n[phase2] Querying Grimoire...')

  // Collect queryable terms (exclude skip types)
  const SKIP_TYPES = new Set(['film_stock', 'camera_body', 'quality_booster', 'rendering_engine'])
  const queryableTerms = [...terms.entries()]
    .filter(([, info]) => !SKIP_TYPES.has(info.type))
    .map(([term]) => term)

  console.log(`  ${queryableTerms.length} queryable terms (${terms.size - queryableTerms.length} skipped)`)

  // Tier 1: Exact lookup
  const tier1Results = await tier1ExactLookup(queryableTerms)

  // Tier 2: FTS5 for unfound aesthetic terms only
  const aestheticTypes = new Set(['core', 'punk', 'wave'])
  const unfoundAesthetic = queryableTerms.filter(t =>
    !tier1Results.has(t) && aestheticTypes.has(terms.get(t).type)
  )
  const tier2Results = await tier2FtsLookup(unfoundAesthetic)

  // Tier 3: Vector search for remaining unfound (aesthetic + artist with high frequency)
  let tier3Results = new Map()
  if (!SKIP_VECTOR) {
    const unfoundAfterFts = queryableTerms.filter(t =>
      !tier1Results.has(t) && !tier2Results.has(t) && terms.get(t).imageSet.size >= 3
    )
    tier3Results = await tier3VectorSearch(unfoundAfterFts)
  }

  // Merge all results
  const allResults = new Map()
  for (const [term, atoms] of tier1Results) allResults.set(term, atoms)
  for (const [term, atoms] of tier2Results) {
    if (!allResults.has(term)) allResults.set(term, atoms)
  }
  for (const [term, atoms] of tier3Results) {
    if (!allResults.has(term)) allResults.set(term, atoms)
  }

  // Phase 3: Report
  console.log('\n[phase3] Generating report...')
  const report = buildReport(images, terms, allResults)

  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2))
  console.log(`\n[done] Report written to ${OUTPUT_FILE}`)
  console.log('Summary:', JSON.stringify(report.summary, null, 2))
  console.log('By type:', JSON.stringify(report.by_type_summary, null, 2))
}

main().catch(err => {
  console.error(`[fatal] ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
