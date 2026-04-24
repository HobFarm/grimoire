#!/usr/bin/env node
/**
 * Film Metadata Import Pipeline
 *
 * Imports filtered film records from Kaggle Global Movie Database CSV into
 * grimoire-db as source records (type='film'), with creator extraction
 * and optional Gemini-based visual vocabulary extraction.
 *
 * Usage:
 *   node scripts/film-import.mjs --filter <csv-path>     # Step 1: Filter CSV, write JSON
 *   node scripts/film-import.mjs --import                 # Step 2: Insert sources + creators
 *   node scripts/film-import.mjs --extract                # Step 3: Gemini visual extraction
 *   node scripts/film-import.mjs --audit                  # Step 4: Post-run audit
 *
 * Requires: CF_API_TOKEN or wrangler OAuth, GEMINI_API_KEY (for --extract)
 */

import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { sleep, getGeminiKey, GEMINI_URL } from './ingest/utils/env.mjs'
import { queryD1 } from './ingest/utils/d1.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FILTERED_FILE = join(__dirname, 'film-filtered.json')
const CHECKPOINT_FILE = join(__dirname, 'film-extract-checkpoint.json')

// Filter criteria
const GENRE_KEYWORDS = ['noir', 'sci-fi', 'science fiction', 'horror', 'fantasy', 'animation', 'mystery', 'thriller']
const PRE_1970 = 1970
const MIN_OVERVIEW_WORDS = 100
const MIN_BUDGET = 50_000_000
const MIN_REVENUE = 200_000_000

// ---------- CSV Parsing ----------

async function readCsv(csvPath) {
  const lines = []
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
    lines.push(row)
  }

  console.log(`[csv] Read ${lines.length} rows with ${headers.length} columns`)
  console.log(`[csv] Columns: ${headers.join(', ')}`)
  return lines
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

async function filterCsv(csvPath) {
  console.log(`[filter] Reading ${csvPath}`)
  const rows = await readCsv(csvPath)

  // Query existing director names from Grimoire for director filter
  let knownDirectors = new Set()
  try {
    const directorAtoms = await queryD1(
      "SELECT DISTINCT text_lower FROM atoms WHERE text_lower IN ('terry gilliam','david lynch','ridley scott','fritz lang','stanley kubrick','alfred hitchcock','akira kurosawa','ingmar bergman','federico fellini','andrei tarkovsky','wim wenders','wong kar-wai','jean-luc godard','francois truffaut','guillermo del toro','gaspar noe','nicolas winding refn','denis villeneuve','roger deakins')"
    )
    knownDirectors = new Set(directorAtoms.map(r => r.text_lower))
    console.log(`[filter] ${knownDirectors.size} known directors found in Grimoire`)
  } catch (e) {
    console.warn(`[filter] Could not query known directors: ${e.message}`)
  }

  const stats = { total: rows.length, genre: 0, year: 0, director: 0, overview: 0, budget: 0, passed: 0 }
  const filtered = []

  for (const row of rows) {
    const genres = (row.genres || '').toLowerCase()
    const year = parseInt(row.release_date?.split('-')[0] || '0')
    const overview = row.overview || ''
    const overviewWords = overview.split(/\s+/).length
    const budget = parseFloat(row.budget || '0')
    const revenue = parseFloat(row.revenue || '0')
    const director = (row.director || '').toLowerCase()

    let reason = null

    if (GENRE_KEYWORDS.some(g => genres.includes(g))) {
      stats.genre++
      reason = 'genre'
    }
    if (year > 0 && year < PRE_1970) {
      stats.year++
      reason = reason || 'year'
    }
    if (knownDirectors.has(director)) {
      stats.director++
      reason = reason || 'director'
    }
    if (overviewWords >= MIN_OVERVIEW_WORDS) {
      stats.overview++
    }
    if (budget >= MIN_BUDGET || revenue >= MIN_REVENUE) {
      stats.budget++
      reason = reason || 'budget_revenue'
    }

    if (!reason) continue

    filtered.push({
      id: randomUUID(),
      title: row.title || row.original_title || 'Unknown',
      year,
      genres: row.genres || '',
      overview,
      budget,
      revenue,
      runtime: parseInt(row.runtime || '0'),
      imdb_id: row.imdb_id || null,
      tmdb_id: row.id || null,
      original_language: row.original_language || null,
      vote_average: parseFloat(row.vote_average || '0'),
      vote_count: parseInt(row.vote_count || '0'),
      director: row.director || null,
      cast: row.cast || null,
      filter_reason: reason,
    })
  }

  stats.passed = filtered.length
  console.log(`[filter] Stats:`)
  console.log(`  Total rows: ${stats.total}`)
  console.log(`  Genre match: ${stats.genre}`)
  console.log(`  Pre-1970: ${stats.year}`)
  console.log(`  Known director: ${stats.director}`)
  console.log(`  Overview >= ${MIN_OVERVIEW_WORDS} words: ${stats.overview}`)
  console.log(`  Budget/revenue match: ${stats.budget}`)
  console.log(`  Final filtered: ${stats.passed}`)

  writeFileSync(FILTERED_FILE, JSON.stringify(filtered, null, 2))
  console.log(`[filter] Wrote ${FILTERED_FILE}`)
}

// ---------- Step 2: Import Sources + Creators ----------

async function importFilms() {
  if (!existsSync(FILTERED_FILE)) throw new Error(`${FILTERED_FILE} not found. Run --filter first.`)
  const films = JSON.parse(readFileSync(FILTERED_FILE, 'utf-8'))

  console.log(`[import] Importing ${films.length} films...`)

  // Check existing to avoid duplicates
  const existing = await queryD1("SELECT source_url FROM sources WHERE type = 'film'")
  const existingUrls = new Set(existing.map(r => r.source_url))

  let sourcesCreated = 0
  let creatorsCreated = 0
  let linksCreated = 0
  let skipped = 0

  // Batch insert sources
  for (let i = 0; i < films.length; i += 50) {
    const batch = films.slice(i, i + 50)

    for (const film of batch) {
      const url = film.imdb_id
        ? `https://www.imdb.com/title/${film.imdb_id}/`
        : film.tmdb_id
          ? `https://www.themoviedb.org/movie/${film.tmdb_id}`
          : null

      if (url && existingUrls.has(url)) {
        skipped++
        continue
      }

      const metadata = JSON.stringify({
        genre: film.genres,
        year: film.year,
        budget: film.budget,
        revenue: film.revenue,
        runtime: film.runtime,
        imdb_id: film.imdb_id,
        tmdb_id: film.tmdb_id,
        original_language: film.original_language,
        vote_average: film.vote_average,
        vote_count: film.vote_count,
        filter_reason: film.filter_reason,
      })

      const escapedTitle = film.title.replace(/'/g, "''")
      const escapedUrl = (url || '').replace(/'/g, "''")
      const escapedMeta = metadata.replace(/'/g, "''")

      try {
        await queryD1(
          `INSERT OR IGNORE INTO sources (id, type, source_url, metadata, created_at)
           VALUES ('${film.id}', 'film', '${escapedUrl}', '${escapedMeta}', datetime('now'))`
        )
        sourcesCreated++
      } catch (e) {
        if (!e.message.includes('UNIQUE')) {
          console.error(`  [source] Insert failed for "${film.title}": ${e.message.slice(0, 200)}`)
        }
      }

      // Extract director -> source_creators
      if (film.director) {
        try {
          const dirName = film.director.replace(/'/g, "''")
          await queryD1(
            `INSERT OR IGNORE INTO source_creators (name, role) VALUES ('${dirName}', 'director')`
          )

          const creatorRow = await queryD1(
            `SELECT id FROM source_creators WHERE name = '${dirName}' AND role = 'director'`
          )
          if (creatorRow.length > 0) {
            await queryD1(
              `INSERT OR IGNORE INTO source_creator_links (source_id, creator_id, role)
               VALUES ('${film.id}', ${creatorRow[0].id}, 'director')`
            )
            creatorsCreated++
            linksCreated++
          }
        } catch (e) {
          // Skip creator errors silently
        }
      }
    }

    console.log(`  batch ${Math.floor(i / 50) + 1}: sources=${sourcesCreated} creators=${creatorsCreated} links=${linksCreated} skipped=${skipped}`)
    await sleep(200)
  }

  console.log(`\n[import] Complete: sources=${sourcesCreated} creators=${creatorsCreated} links=${linksCreated} skipped=${skipped}`)
}

// ---------- Step 3: Visual Vocabulary Extraction ----------

function loadExtractCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { last_index: -1 }
  return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
}

function saveExtractCheckpoint(cp) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2))
}

async function extractVisualVocab() {
  if (!existsSync(FILTERED_FILE)) throw new Error(`${FILTERED_FILE} not found. Run --filter first.`)
  const films = JSON.parse(readFileSync(FILTERED_FILE, 'utf-8'))
  const geminiKey = getGeminiKey()
  const checkpoint = loadExtractCheckpoint()

  // Filter to films with sufficient overview text
  const eligible = films.filter(f => f.overview && f.overview.split(/\s+/).length >= 50)
  console.log(`[extract] ${eligible.length} films with overview >= 50 words, starting from index ${checkpoint.last_index + 1}`)

  let atomsCreated = 0
  let atomsExisting = 0
  let errors = 0

  for (let i = checkpoint.last_index + 1; i < eligible.length; i += 10) {
    const batch = eligible.slice(i, i + 10)

    for (const film of batch) {
      try {
        const res = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text:
              `Extract concrete visual and atmospheric terms from this film description. Return only terms that describe what something LOOKS like, not plot or character commentary. Each term should be 2-5 words.\n\nFilm: ${film.title} (${film.year})\nGenre: ${film.genres}\nOverview: ${film.overview}\n\nReturn as JSON: {"visual_terms": ["term1", "term2", ...]}`
            }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        })

        if (!res.ok) {
          console.error(`  [gemini] ${film.title}: ${res.status}`)
          errors++
          continue
        }

        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = { visual_terms: [] } }

        const terms = parsed.visual_terms || []
        if (terms.length === 0) continue

        // Insert atoms via Grimoire worker bulk endpoint
        for (const term of terms) {
          if (typeof term !== 'string' || term.length < 3 || term.length > 80) continue
          const escapedTerm = term.replace(/'/g, "''")
          try {
            const existing = await queryD1(
              `SELECT id FROM atoms WHERE text_lower = '${escapedTerm.toLowerCase()}'`
            )
            if (existing.length > 0) {
              // Link existing atom to this film source
              await queryD1(
                `INSERT OR IGNORE INTO source_atoms (source_id, atom_id, confidence, extraction_method)
                 VALUES ('${film.id}', '${existing[0].id}', 0.7, 'gemini_overview')`
              )
              atomsExisting++
            } else {
              const atomId = randomUUID()
              await queryD1(
                `INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, source, source_app, status, created_at, updated_at)
                 VALUES ('${atomId}', '${escapedTerm}', '${escapedTerm.toLowerCase()}', 'film-visual', 'ai', 'film-import', 'provisional', datetime('now'), datetime('now'))`
              )
              await queryD1(
                `INSERT OR IGNORE INTO source_atoms (source_id, atom_id, confidence, extraction_method)
                 VALUES ('${film.id}', '${atomId}', 0.7, 'gemini_overview')`
              )
              atomsCreated++
            }
          } catch (e) {
            // Skip individual atom errors
          }
        }

        console.log(`  ${film.title}: ${terms.length} terms extracted`)
      } catch (e) {
        console.error(`  [extract] ${film.title}: ${e.message}`)
        errors++
      }
    }

    checkpoint.last_index = Math.min(i + 9, eligible.length - 1)
    saveExtractCheckpoint(checkpoint)
    console.log(`  [checkpoint] index=${checkpoint.last_index} atoms_created=${atomsCreated} existing=${atomsExisting} errors=${errors}`)

    // Rate limit between batches
    if (i + 10 < eligible.length) {
      await sleep(5000)
    }
  }

  console.log(`\n[extract] Complete: created=${atomsCreated} linked_existing=${atomsExisting} errors=${errors}`)
}

// ---------- Step 4: Audit ----------

async function audit() {
  console.log('[audit] Querying post-import counts...')

  const filmSources = await queryD1("SELECT COUNT(*) as count FROM sources WHERE type = 'film'")
  const creators = await queryD1('SELECT COUNT(*) as count FROM source_creators')
  const links = await queryD1('SELECT COUNT(*) as count FROM source_creator_links')
  const filmAtomLinks = await queryD1(
    `SELECT COUNT(*) as count FROM source_atoms WHERE source_id IN (SELECT id FROM sources WHERE type = 'film')`
  )

  console.log(`  Film sources: ${filmSources[0].count}`)
  console.log(`  Creators: ${creators[0].count}`)
  console.log(`  Creator-film links: ${links[0].count}`)
  console.log(`  Film-atom links: ${filmAtomLinks[0].count}`)
}

// ---------- CLI ----------

const args = process.argv.slice(2)

try {
  if (args.includes('--filter')) {
    const csvPath = args[args.indexOf('--filter') + 1]
    if (!csvPath || csvPath.startsWith('--')) throw new Error('Provide CSV path: --filter <path>')
    await filterCsv(csvPath)
  } else if (args.includes('--import')) {
    await importFilms()
  } else if (args.includes('--extract')) {
    await extractVisualVocab()
  } else if (args.includes('--audit')) {
    await audit()
  } else {
    console.log('Usage:')
    console.log('  node scripts/film-import.mjs --filter <csv-path>  # Filter CSV')
    console.log('  node scripts/film-import.mjs --import             # Insert sources + creators')
    console.log('  node scripts/film-import.mjs --extract            # Gemini visual extraction')
    console.log('  node scripts/film-import.mjs --audit              # Post-run audit')
  }
} catch (err) {
  console.error(`[fatal] ${err.message}`)
  process.exit(1)
}
