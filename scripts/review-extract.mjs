#!/usr/bin/env node
/**
 * Film Reviews Visual Vocabulary Extraction
 *
 * Extracts visual/atmospheric language from film reviews via Gemini.
 * Only processes reviews for films already in the sources table.
 * Includes quality gates and negative keyword filtering.
 *
 * Prerequisites: Task 4 (film-import.mjs --import) must be complete.
 *
 * Usage:
 *   node scripts/review-extract.mjs --filter <reviews-csv>  # Step 1: Filter eligible reviews
 *   node scripts/review-extract.mjs --extract               # Step 2: Gemini extraction
 *   node scripts/review-extract.mjs --audit                 # Step 3: Quality audit
 */

import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { sleep, getGeminiKey, GEMINI_URL } from './ingest/utils/env.mjs'
import { queryD1 } from './ingest/utils/d1.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ELIGIBLE_FILE = join(__dirname, 'review-eligible.json')
const CHECKPOINT_FILE = join(__dirname, 'review-extract-checkpoint.json')

const MIN_REVIEW_LENGTH = 100 // chars
const MAX_REVIEWS_PER_FILM = 5

// Negative keywords: if an extracted atom contains these, it's likely a plot term, not visual
const PLOT_TERMS = [
  'predictable', 'boring', 'twist', 'ending', 'plot hole', 'chemistry',
  'overacted', 'underrated', 'disappointing', 'masterpiece', 'sequel',
  'overrated', 'cliche', 'formulaic', 'remake', 'prequel', 'backstory',
  'character development', 'acting', 'dialogue', 'script', 'screenplay',
]

const EXTRACTION_PROMPT = `Extract ONLY visual and atmospheric language from these film reviews.
Keep: descriptions of lighting, color, framing, composition, texture,
mood conveyed through visuals, costume/set descriptions, camera work.
Discard: plot commentary, acting quality, dialogue quotes, pacing,
narrative structure, character development, emotional reactions not
tied to visuals.
Return as JSON: { "visual_terms": ["term1", "term2"], "discarded_count": N }

Each term should be 2-5 words describing what something LOOKS like.`

// ---------- CSV Parsing ----------

async function readReviewsCsv(csvPath) {
  const reviews = []
  const rl = createInterface({
    input: createReadStream(csvPath, 'utf-8'),
    crlfDelay: Infinity,
  })

  let headers = null
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line)
      continue
    }
    const values = parseCsvLine(line)
    if (values.length !== headers.length) continue
    const row = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i]
    }
    reviews.push(row)
  }

  console.log(`[csv] Read ${reviews.length} reviews`)
  return reviews
}

function parseCsvLine(line) {
  const values = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  values.push(current.trim())
  return values
}

// ---------- Step 1: Filter ----------

async function filterReviews(csvPath) {
  console.log(`[filter] Reading reviews from ${csvPath}`)
  const reviews = await readReviewsCsv(csvPath)

  // Get film IDs and their IMDB/TMDB IDs from sources table
  console.log('[filter] Querying existing film sources...')
  const filmSources = await queryD1(
    "SELECT id, metadata FROM sources WHERE type = 'film'"
  )

  // Build lookup: tmdb_id -> source_id
  const tmdbToSource = new Map()
  const imdbToSource = new Map()
  for (const s of filmSources) {
    try {
      const meta = JSON.parse(s.metadata || '{}')
      if (meta.tmdb_id) tmdbToSource.set(String(meta.tmdb_id), s.id)
      if (meta.imdb_id) imdbToSource.set(meta.imdb_id, s.id)
    } catch {}
  }

  console.log(`[filter] ${filmSources.length} film sources, ${tmdbToSource.size} TMDB IDs, ${imdbToSource.size} IMDB IDs`)

  // Filter reviews to eligible ones
  const filmReviews = new Map() // source_id -> reviews[]
  let filtered = 0
  let tooShort = 0
  let noFilm = 0

  for (const review of reviews) {
    const reviewText = review.content || review.review || review.text || ''
    if (reviewText.length < MIN_REVIEW_LENGTH) {
      tooShort++
      continue
    }

    // Match review to a film source
    const filmId = review.movie_id || review.tmdb_id || review.id
    const sourceId = tmdbToSource.get(String(filmId)) || imdbToSource.get(review.imdb_id)
    if (!sourceId) {
      noFilm++
      continue
    }

    if (!filmReviews.has(sourceId)) filmReviews.set(sourceId, [])
    const arr = filmReviews.get(sourceId)
    if (arr.length >= MAX_REVIEWS_PER_FILM) continue

    arr.push({
      source_id: sourceId,
      text: reviewText.slice(0, 2000), // cap length for Gemini
    })
    filtered++
  }

  // Flatten to batches grouped by film
  const eligible = []
  for (const [sourceId, revs] of filmReviews) {
    eligible.push({ source_id: sourceId, reviews: revs })
  }

  console.log(`[filter] Results:`)
  console.log(`  Total reviews: ${reviews.length}`)
  console.log(`  Too short (< ${MIN_REVIEW_LENGTH} chars): ${tooShort}`)
  console.log(`  No matching film source: ${noFilm}`)
  console.log(`  Eligible reviews: ${filtered}`)
  console.log(`  Films with reviews: ${eligible.length}`)

  writeFileSync(ELIGIBLE_FILE, JSON.stringify(eligible, null, 2))
  console.log(`[filter] Wrote ${ELIGIBLE_FILE}`)
}

// ---------- Step 2: Extract ----------

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { last_index: -1, atoms_created: 0, atoms_flagged: 0 }
  return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
}

function saveCheckpoint(cp) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2))
}

function isPlotTerm(term) {
  const lower = term.toLowerCase()
  return PLOT_TERMS.some(pt => lower.includes(pt))
}

async function extractVisual() {
  if (!existsSync(ELIGIBLE_FILE)) throw new Error(`${ELIGIBLE_FILE} not found. Run --filter first.`)
  const batches = JSON.parse(readFileSync(ELIGIBLE_FILE, 'utf-8'))
  const geminiKey = getGeminiKey()
  const checkpoint = loadCheckpoint()

  console.log(`[extract] ${batches.length} film batches, starting from ${checkpoint.last_index + 1}`)

  let atomsCreated = checkpoint.atoms_created || 0
  let atomsFlagged = checkpoint.atoms_flagged || 0
  let atomsLinked = 0
  let errors = 0

  // Quality gate: pause after first 50 for inspection
  const QUALITY_GATE = 50

  for (let i = checkpoint.last_index + 1; i < batches.length; i++) {
    const batch = batches[i]
    const reviewTexts = batch.reviews.map((r, idx) => `Review ${idx + 1}: ${r.text}`).join('\n\n')

    try {
      const res = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${EXTRACTION_PROMPT}\n\n${reviewTexts}` }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      })

      if (!res.ok) {
        console.error(`  [gemini] batch ${i}: ${res.status}`)
        errors++
        continue
      }

      const data = await res.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
      let parsed
      try { parsed = JSON.parse(text) } catch { parsed = { visual_terms: [] } }

      const terms = parsed.visual_terms || []

      for (const term of terms) {
        if (typeof term !== 'string' || term.length < 3 || term.length > 80) continue

        // Negative keyword filter
        if (isPlotTerm(term)) {
          atomsFlagged++
          continue
        }

        const escapedTerm = term.replace(/'/g, "''")
        try {
          const existing = await queryD1(
            `SELECT id FROM atoms WHERE text_lower = '${escapedTerm.toLowerCase()}'`
          )
          if (existing.length > 0) {
            await queryD1(
              `INSERT OR IGNORE INTO source_atoms (source_id, atom_id, confidence, extraction_method)
               VALUES ('${batch.source_id}', '${existing[0].id}', 0.6, 'gemini_review')`
            )
            atomsLinked++
          } else {
            const atomId = randomUUID()
            await queryD1(
              `INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, source, source_app, status, created_at, updated_at)
               VALUES ('${atomId}', '${escapedTerm}', '${escapedTerm.toLowerCase()}', 'film-visual', 'ai', 'review-extract', 'provisional', datetime('now'), datetime('now'))`
            )
            await queryD1(
              `INSERT OR IGNORE INTO source_atoms (source_id, atom_id, confidence, extraction_method)
               VALUES ('${batch.source_id}', '${atomId}', 0.6, 'gemini_review')`
            )
            atomsCreated++
          }
        } catch {}
      }
    } catch (e) {
      console.error(`  [extract] batch ${i}: ${e.message}`)
      errors++
    }

    checkpoint.last_index = i
    checkpoint.atoms_created = atomsCreated
    checkpoint.atoms_flagged = atomsFlagged
    saveCheckpoint(checkpoint)

    if ((i + 1) % 10 === 0) {
      console.log(`  [progress] ${i + 1}/${batches.length} created=${atomsCreated} linked=${atomsLinked} flagged=${atomsFlagged} errors=${errors}`)
    }

    // Quality gate
    if (i === QUALITY_GATE - 1) {
      console.log(`\n[quality-gate] Processed ${QUALITY_GATE} films. Review atoms before continuing.`)
      console.log(`  Run: node scripts/review-extract.mjs --audit`)
      console.log(`  Then resume: node scripts/review-extract.mjs --extract`)
      break
    }

    // Rate limit: 5 batches per minute = 12s between batches
    if (i < batches.length - 1) {
      await sleep(12000)
    }
  }

  console.log(`\n[extract] Complete: created=${atomsCreated} linked=${atomsLinked} flagged=${atomsFlagged} errors=${errors}`)
}

// ---------- Step 3: Audit ----------

async function audit() {
  console.log('[audit] Sampling review-extracted atoms...')

  const sample = await queryD1(
    `SELECT text, collection_slug FROM atoms
     WHERE source_app = 'review-extract' AND status = 'provisional'
     ORDER BY RANDOM() LIMIT 50`
  )

  console.log(`\n  Sample of ${sample.length} review-extracted atoms:`)
  for (const atom of sample) {
    const flagged = isPlotTerm(atom.text) ? ' [FLAGGED]' : ''
    console.log(`    "${atom.text}"${flagged}`)
  }

  const total = await queryD1(
    "SELECT COUNT(*) as count FROM atoms WHERE source_app = 'review-extract'"
  )
  const filmLinks = await queryD1(
    `SELECT COUNT(*) as count FROM source_atoms WHERE extraction_method = 'gemini_review'`
  )

  console.log(`\n  Total review-extracted atoms: ${total[0].count}`)
  console.log(`  Film-atom links (review): ${filmLinks[0].count}`)
}

// ---------- CLI ----------

const args = process.argv.slice(2)

try {
  if (args.includes('--filter')) {
    const csvPath = args[args.indexOf('--filter') + 1]
    if (!csvPath || csvPath.startsWith('--')) throw new Error('Provide CSV path: --filter <path>')
    await filterReviews(csvPath)
  } else if (args.includes('--extract')) {
    await extractVisual()
  } else if (args.includes('--audit')) {
    await audit()
  } else {
    console.log('Usage:')
    console.log('  node scripts/review-extract.mjs --filter <csv>  # Filter eligible reviews')
    console.log('  node scripts/review-extract.mjs --extract       # Gemini extraction')
    console.log('  node scripts/review-extract.mjs --audit         # Quality audit')
  }
} catch (err) {
  console.error(`[fatal] ${err.message}`)
  process.exit(1)
}
