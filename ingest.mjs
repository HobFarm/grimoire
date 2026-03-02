#!/usr/bin/env node
/**
 * Grimoire Bulk Ingest v2
 * 
 * Reads triage manifest + transformed files, deduplicates globally,
 * batch-classifies via Gemini (50 atoms per call), and inserts into
 * Grimoire with accurate category and collection metadata.
 * 
 * Usage:
 *   node ingest.mjs --manifest triage-manifest.json --key "GEMINI_KEY" --dry-run
 *   node ingest.mjs --manifest triage-manifest.json --key "GEMINI_KEY"
 *   node ingest.mjs --manifest triage-manifest.json --key "GEMINI_KEY" --transformed-dir transformed\detailed
 *   node ingest.mjs --manifest triage-manifest.json --key "GEMINI_KEY" --concurrency 5 --batch-size 50
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { normalizeAtoms } from './normalize.mjs'
import { withRetry } from './retry.mjs'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i+1] ? args[i+1] : null }
const hasFlag = (name) => args.includes(`--${name}`)

const MANIFEST_PATH = getArg('manifest') || 'triage-manifest.json'
const API_KEY = getArg('key')
const WORKER_URL = getArg('worker-url') || 'https://grimoire.damp-violet-bf89.workers.dev'
const TRANSFORMED_DIR = getArg('transformed-dir') || 'transformed\\detailed'
const CLASSIFY_BATCH = parseInt(getArg('batch-size') || '25', 10)
const INSERT_BATCH = parseInt(getArg('insert-batch') || '50', 10)
const INSERT_CONCURRENCY = parseInt(getArg('insert-concurrency') || '3', 10)
const CONCURRENCY = parseInt(getArg('concurrency') || '3', 10)
const DRY_RUN = hasFlag('dry-run')
const SKIP_CLASSIFY = hasFlag('skip-classify')
const INSERT_ONLY = getArg('insert-only')
const STRATEGIES = (getArg('strategies') || 'direct,dedupe_and_ingest').split(',')

if (!API_KEY && !DRY_RUN && !SKIP_CLASSIFY && !INSERT_ONLY) {
  console.error('Usage: node ingest.mjs --manifest <path> --key <gemini-key> [options]')
  console.error('  --dry-run              Report only, no API calls')
  console.error('  --skip-classify        Insert without classifying')
  console.error('  --insert-only <file>   Skip phases 1-3.5, insert from classified JSON file')
  console.error('  --concurrency N        Parallel Gemini calls (default 3)')
  console.error('  --batch-size N         Atoms per Gemini call (default 25)')
  console.error('  --insert-batch N       Atoms per Worker insert call (default 50)')
  console.error('  --insert-concurrency N Parallel Worker insert calls (default 3)')
  console.error('  --transformed-dir      Path to transformed/detailed folder')
  console.error('  --strategies           Comma-separated strategies (default: direct,dedupe_and_ingest)')
  process.exit(1)
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'

// ---------------------------------------------------------------------------
// Category -> Collection derivation
// ---------------------------------------------------------------------------
// Canonical map. Source of truth: workers/grimoire/src/taxonomy.ts
const CATEGORY_TO_COLLECTION = {
  // Subject
  'subject.form': 'attributes',
  'subject.expression': 'features-expression',
  'subject.face': 'features-face',
  'subject.feature': 'features-body',
  'subject.hair': 'features-hair',
  'subject.animal': 'animals',
  // Environment
  'environment.setting': 'environment',
  'environment.atmosphere': 'environment-atmosphere',
  'environment.prop': 'environment-props',
  'environment.natural': 'nature',
  // Lighting
  'lighting.source': 'lighting',
  // Color
  'color.palette': 'colors',
  // Composition
  'composition.rule': 'composition',
  // Covering
  'covering.clothing': 'clothing',
  'covering.material': 'clothing',
  'covering.accessory': 'clothing-accessories',
  'covering.headwear': 'clothing',
  'covering.footwear': 'clothing-footwear',
  'covering.outfit': 'clothing-full',
  // Pose
  'pose.position': 'poses',
  'pose.interaction': 'poses',
  // Object
  'object.held': 'props-held',
  'object.drink': 'props-held-vessels',
  // Style
  'style.genre': 'styles',
  'style.era': 'styles',
  'style.medium': 'style-medium',
  // Camera
  'camera.lens': 'photography',
  'camera.shot': 'photography',
  // Effect
  'effect.post': 'effects',
  // Negative
  'negative.filter': 'filters',
  // Reference
  'reference.film': 'references',
  'reference.technique': 'references',
  'reference.person': 'references',
  'reference.location': 'references',
  'reference.character': 'references',
  'reference.game': 'references',
  // Narrative (visual collections)
  'narrative.scene': 'scenes',
  'narrative.mood': 'scenes',
  // Narrative (no visual collection)
  'narrative.action': 'uncategorized',
  'narrative.archetype': 'uncategorized',
  'narrative.concept': 'uncategorized',
  'narrative.phrase': 'uncategorized',
  // Domain (narrative-only)
  'domain.academia': 'uncategorized',
  'domain.athletics': 'uncategorized',
  'domain.aviation': 'uncategorized',
  'domain.chemistry': 'uncategorized',
  'domain.cuisine': 'uncategorized',
  'domain.folklore': 'uncategorized',
  'domain.law': 'uncategorized',
  'domain.maritime': 'uncategorized',
  'domain.medicine': 'uncategorized',
  'domain.military': 'uncategorized',
  'domain.occult': 'uncategorized',
  'domain.technology': 'uncategorized',
}

function collectionFromCategory(cat) {
  return CATEGORY_TO_COLLECTION[cat] || 'uncategorized'
}

// ---------------------------------------------------------------------------
// Gemini batch classification
// ---------------------------------------------------------------------------
const VALID_CATEGORIES = Object.keys(CATEGORY_TO_COLLECTION)

const CLASSIFY_PROMPT = `Classify each atom into exactly one category from the list below. Return a JSON array with one entry per atom.

CATEGORIES:
- camera.lens: Focal length, depth of field, bokeh. Technical camera properties.
- camera.shot: Camera framing/angle. Close-up, medium, wide, bird-eye.
- color.palette: Color terms, hex values, color harmony, hue references.
- composition.rule: Compositional principles. Rule of thirds, leading lines, symmetry.
- covering.accessory: Jewelry, belts, watches, bracelets. Removable accessories.
- covering.clothing: Garments. Dresses, suits, shirts, pants, robes, armor.
- covering.footwear: Shoes, boots, sandals, legwear.
- covering.headwear: Hats, helmets, crowns, tiaras, hoods.
- covering.material: Fabrics, textures. Leather, silk, lace, velvet. NOT architecture.
- covering.outfit: Complete themed ensembles. Cottagecore, steampunk outfits.
- effect.post: Post-processing effects. Film grain, chromatic aberration, vignette, bloom.
- environment.atmosphere: Physical atmospheric conditions ONLY. Smoke, fog, rain, dust, mist.
- environment.natural: Natural features. Mountains, rivers, forests, seasons, geology.
- environment.prop: Scene objects NOT worn/held. Furniture, vehicles, architectural ELEMENTS (columns, arches, screens, verandas).
- environment.setting: Where a scene takes place. Locations, venues, landscapes.
- lighting.source: Light sources and quality. Key light, fill, rim, neon, candles.
- narrative.mood: Aesthetic quality descriptors AND atmospheric intent. Beautiful, elegant, glamorous, alluring, charming, cute, exquisite, adorable, stunning, etc. General beauty/quality adjectives go HERE.
- narrative.scene: Multi-element scene descriptions. Phrases describing spatial relationships.
- negative.filter: Abstract words useless in image prompts. Structure, transition, resemble, effusive, diminutive.
- object.drink: Beverage vessels. Glass type, liquid, garnish.
- object.held: Held objects. Weapons, tools, cigarettes.
- pose.interaction: Physical interactions. Holding, gripping, touching.
- pose.position: Body posture. Standing, sitting, kneeling, leaning.
- reference.character: Fictional characters with known visual designs.
- reference.film: Film/director/cinematographer names as style references.
- reference.game: Game systems, mechanics, settings.
- reference.location: Named real-world places, landmarks.
- reference.person: Real people (artists, photographers, directors) as style references.
- reference.technique: Photo/cinematographic techniques. Rack focus, chiaroscuro, long exposure.
- style.era: Time periods. 1920s, Victorian, Medieval, Meiji period, Renaissance era.
- style.genre: Aesthetic categories AND ALL ARCHITECTURAL STYLES. Noir, cyberpunk, art deco, gothic, brutalist. ALL terms ending in "architecture" or naming an architectural movement go here: baroque, renaissance, rococo, tudor, colonial, neoclassical, moorish, prairie, queen-anne, queenslander, etc.
- style.medium: Rendering approach. Photography, oil painting, watercolor, 3D render.
- subject.animal: Animals, birds, insects, marine life.
- subject.expression: Facial MUSCLE positions ONLY. Smiling, frowning, squinting, winking. NOT beauty adjectives.
- subject.face: Facial features. Eye color, skin texture, cosmetics.
- subject.feature: Distinguishing marks. Tattoos, scars, piercings.
- subject.form: Subject structure. Figure type, body proportions.
- subject.hair: Hair style, length, texture, color. Facial hair.

CRITICAL RULES:
1. ALL architectural styles -> style.genre. "baroque architecture", "gothic architecture", "renaissance architecture", "rococo", "tudor", "colonial", "moorish", "prairie", "queenslander" = style.genre. ALWAYS.
2. Beauty/quality adjectives -> narrative.mood. "elegant", "glamorous", "adorable", "cute", "charming", "attractive", "gorgeous", "stunning" = narrative.mood. NOT subject.expression.
3. subject.expression = facial muscles ONLY: smiling, frowning, grimacing, pouting, sneering, winking.
4. Abstract/meaningless terms -> negative.filter. "structure", "transition", "resemble", "effusive" = negative.filter.
5. Japanese architectural elements (engawa, fusuma, genkan, shoji, tatami) -> environment.prop.
6. Historical periods (Meiji period, Showa period, Heisei period) -> style.era.

Return ONLY a JSON array: [{"i":0,"c":"category.slug"},{"i":1,"c":"category.slug"},...]
i = index (0-based), c = category slug from list above.
No markdown fences. No explanation. Just the JSON array.`

async function classifyBatch(atoms) {
  const userContent = atoms.map((a, i) => `${i}. ${a.text}`).join('\n')

  const res = await fetch(`${GEMINI_URL}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: CLASSIFY_PROMPT + '\n\n' + userContent }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 100)}`)
  }

  const data = await res.json()
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!raw) throw Object.assign(new Error('Empty response'), { retryable: false })

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw Object.assign(new Error(`JSON parse failed: ${cleaned.slice(0, 100)}`), { retryable: false })
  }
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error(`Not array: ${cleaned.slice(0, 100)}`), { retryable: false })
  }

  const catSet = new Set(VALID_CATEGORIES)
  for (const item of parsed) {
    const idx = item.i
    const cat = item.c
    if (idx >= 0 && idx < atoms.length && catSet.has(cat)) {
      atoms[idx].category_slug = cat
      atoms[idx].collection_slug = collectionFromCategory(cat)
    }
  }
  return atoms
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------
async function runConcurrent(tasks, concurrency) {
  const results = []
  let idx = 0
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()))
  return results
}

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------
function cleanLine(line) {
  return line.trim().replace(/^\\+|\\+$/g, '').replace(/^\uFEFF/, '').trim()
}

async function readDirectFile(filePath) {
  const content = await readFile(filePath, 'utf-8')
  return content.split(/\r?\n/).map(cleanLine).filter(l => l.length > 0 && l.length < 500)
}

async function readTransformedFile(filePath) {
  const content = await readFile(filePath, 'utf-8')
  return content.split(/\r?\n/)
    .map(l => l.trim()).filter(l => l.length > 0)
    .map(l => {
      const [name, collection, ...descParts] = l.split('\t')
      const desc = descParts.join('\t').trim()
      if (!desc || desc.startsWith('[FAILED')) return null
      return { text: desc, transformCategory: collection?.trim() }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Worker insert
// ---------------------------------------------------------------------------
async function insertBatch(atoms, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/admin/ingest-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atoms }),
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`${res.status}: ${txt.slice(0, 200)}`)
      }
      return await res.json()
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Insert into Grimoire (extracted for reuse with --insert-only)
// ---------------------------------------------------------------------------
async function runInsertPhase(atoms) {
  const totalBatches = Math.ceil(atoms.length / INSERT_BATCH)
  console.log(`\nPhase 4: Inserting ${atoms.length} atoms (${totalBatches} batches of ${INSERT_BATCH}, ${INSERT_CONCURRENCY} concurrent)...`)
  let totalInserted = 0, totalSkipped = 0, totalErrors = 0

  // Build all batch payloads
  const batches = []
  for (let i = 0; i < atoms.length; i += INSERT_BATCH) {
    batches.push(atoms.slice(i, i + INSERT_BATCH).map(a => ({
      text: a.text,
      collection_slug: a.collection_slug || 'uncategorized',
      category_slug: a.category_slug || null,
    })))
  }

  // Process with concurrency
  let nextIdx = 0
  const startTime = Date.now()

  async function worker() {
    while (nextIdx < batches.length) {
      const idx = nextIdx++
      const batch = batches[idx]
      try {
        const result = await insertBatch(batch)
        totalInserted += result.inserted || 0
        totalSkipped += result.skipped || 0
      } catch (err) {
        totalErrors += batch.length
        if (totalErrors <= 150) {  // only log first few errors
          process.stdout.write(`\n  Batch ${idx + 1}/${totalBatches} ERROR: ${err.message.slice(0, 80)}`)
        }
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      const pct = Math.floor(((idx + 1) / totalBatches) * 100)
      process.stdout.write(`\r  [${pct}%] ${idx + 1}/${totalBatches} - inserted: ${totalInserted}, skipped: ${totalSkipped}, errors: ${totalErrors} (${elapsed}s)`)
    }
  }

  const workers = Array.from({ length: INSERT_CONCURRENCY }, () => worker())
  await Promise.all(workers)

  console.log(`\n\n--- INGEST COMPLETE ---`)
  console.log(`Total atoms: ${atoms.length}`)
  console.log(`Inserted: ${totalInserted}`)
  console.log(`Skipped (dupes): ${totalSkipped}`)
  console.log(`Errors: ${totalErrors}`)
  if (totalErrors > 0) {
    console.log(`\nTo retry failed inserts, re-run with: --insert-only classified-atoms.json`)
    console.log(`INSERT OR IGNORE will skip already-inserted atoms.`)
  }
  console.log(`\nNext: vectorize new atoms via /admin/vectorize-batch`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\nGrimoire Bulk Ingest v2')
  console.log(`Worker: ${WORKER_URL}`)

  // =========================================================================
  // INSERT-ONLY MODE: skip phases 1-3.5, read classified atoms from file
  // =========================================================================
  if (INSERT_ONLY) {
    console.log(`Insert-only mode: reading ${INSERT_ONLY}`)
    const raw = JSON.parse(await readFile(INSERT_ONLY, 'utf-8'))
    const unique = Array.isArray(raw) ? raw : raw.atoms || []
    console.log(`  ${unique.length} atoms to insert (batch=${INSERT_BATCH}, concurrency=${INSERT_CONCURRENCY})`)
    await runInsertPhase(unique)
    return
  }

  console.log(`Manifest: ${MANIFEST_PATH}`)
  console.log(`Classify: ${CLASSIFY_BATCH} atoms/call, ${CONCURRENCY} concurrent`)
  if (DRY_RUN) console.log('*** DRY RUN ***')
  if (SKIP_CLASSIFY) console.log('*** SKIP CLASSIFY ***')
  console.log()

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
  const sourceDir = manifest.source_directory

  // =========================================================================
  // PHASE 1: Read all files
  // =========================================================================
  console.log('Phase 1: Reading files...')
  const allAtoms = []
  let filesRead = 0

  const mFiles = manifest.files.filter(f => STRATEGIES.includes(f.ingest_strategy))
  for (const entry of mFiles) {
    try {
      const lines = await readDirectFile(join(sourceDir, entry.path))
      for (const line of lines) allAtoms.push({ text: line })
      filesRead++
    } catch { /* skip */ }
  }
  console.log(`  ${filesRead} manifest files -> ${allAtoms.length} lines`)

  let tCount = 0
  try {
    const tFiles = (await readdir(TRANSFORMED_DIR)).filter(f => extname(f) === '.txt')
    for (const f of tFiles) {
      const entries = await readTransformedFile(join(TRANSFORMED_DIR, f))
      allAtoms.push(...entries)
      tCount += entries.length
    }
    console.log(`  Transformed -> ${tCount} entries`)
  } catch { console.log('  No transformed directory') }

  console.log(`  Total raw: ${allAtoms.length}`)

  // =========================================================================
  // PHASE 1.5: Normalize
  // =========================================================================
  console.log(`  Sample entry: ${typeof allAtoms[0]} ${JSON.stringify(allAtoms[0]).slice(0, 200)}`)

  console.log('\nPhase 1.5: Normalizing...')
  const rawTexts = allAtoms.map(a => typeof a === 'string' ? a : a.text)
  const { atoms: normalizedTexts, stats: normStats } = normalizeAtoms(rawTexts)
  console.log(`  ${normStats.input} in, ${normStats.output} out, ${normStats.skipped} skipped, ${normStats.deduped} deduped`)

  // Rebuild entry array: keep only entries whose text survived normalization
  const survivorSet = new Set(normalizedTexts.map(t => t.toLowerCase()))
  const normalizedAtoms = allAtoms.filter(a => {
    const text = typeof a === 'string' ? a : a.text
    return survivorSet.has(text.toLowerCase())
  })

  // =========================================================================
  // PHASE 2: Deduplicate
  // =========================================================================
  console.log('\nPhase 2: Deduplicating...')
  const seen = new Set()
  const unique = []
  for (const atom of normalizedAtoms) {
    const key = atom.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(atom)
  }
  console.log(`  Unique: ${unique.length} (removed ${normalizedAtoms.length - unique.length} dupes)`)

  if (DRY_RUN && !API_KEY) {
    console.log('\n*** DRY RUN COMPLETE (no key) ***')
    console.log(`Would process ${unique.length} unique atoms`)
    return
  }

  // =========================================================================
  // PHASE 3: Batch classify via Gemini
  // =========================================================================
  if (!SKIP_CLASSIFY) {
    console.log(`\nPhase 3: Classifying ${unique.length} atoms...`)

    // Trust pre-classified transform categories
    const catSet = new Set(VALID_CATEGORIES)
    let preClassified = 0
    for (const atom of unique) {
      if (atom.transformCategory && catSet.has(atom.transformCategory)) {
        atom.category_slug = atom.transformCategory
        atom.collection_slug = collectionFromCategory(atom.transformCategory)
        preClassified++
      }
    }
    if (preClassified > 0) console.log(`  ${preClassified} pre-classified from transforms`)

    const needClassify = unique.filter(a => !a.category_slug)
    console.log(`  ${needClassify.length} atoms need Gemini classification`)

    let classified = 0, failed = 0
    const startTime = Date.now()

    const tasks = []
    for (let i = 0; i < needClassify.length; i += CLASSIFY_BATCH) {
      const batch = needClassify.slice(i, i + CLASSIFY_BATCH)
      tasks.push(async () => {
        try {
          await withRetry(() => classifyBatch(batch), { maxRetries: 3, baseDelay: 2000 })
        } catch (err) {
          console.error(`\n  CLASSIFY BATCH FAILED: ${err.message?.slice(0, 100)}`)
          for (const a of batch) {
            if (!a.category_slug) {
              a.category_slug = null
              a.collection_slug = 'uncategorized'
            }
          }
        }
        const done = batch.filter(a => a.category_slug).length
        classified += done
        failed += (batch.length - done)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const pct = Math.round(((classified + failed) / needClassify.length) * 100)
        process.stdout.write(`\r  [${pct}%] ${classified + failed}/${needClassify.length} (${failed} failed) ${elapsed}s`)
        await new Promise(r => setTimeout(r, 200))
      })
    }

    await runConcurrent(tasks, CONCURRENCY)
    console.log(`\n  Done: ${classified} classified, ${failed} failed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

    // Summary
    const byColl = {}
    for (const a of unique) {
      byColl[a.collection_slug || 'uncategorized'] = (byColl[a.collection_slug || 'uncategorized'] || 0) + 1
    }
    console.log('\n  Collections:')
    Object.entries(byColl).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k}: ${v}`))
  } else {
    for (const a of unique) { a.collection_slug = 'uncategorized'; a.category_slug = null }
  }

  if (DRY_RUN) {
    console.log('\n*** DRY RUN COMPLETE ***')
    const preview = unique.slice(0, 200).map(a => ({ text: a.text, category: a.category_slug, collection: a.collection_slug }))
    await writeFile('ingest-preview.json', JSON.stringify(preview, null, 2))
    console.log(`Would insert ${unique.length} atoms. Preview: ingest-preview.json`)

    const negatives = unique.filter(a => a.collection_slug === 'render-negative')
    const negativeSample = negatives.sort(() => Math.random() - 0.5).slice(0, 50).map(a => ({ text: a.text, category: a.category_slug }))
    await writeFile('render-negative-sample.json', JSON.stringify(negativeSample, null, 2))
    console.log(`Render-negative sample: ${negativeSample.length} of ${negatives.length} -> render-negative-sample.json`)
    return
  }

  // =========================================================================
  // PHASE 3.5: Filter render-negative, write samples
  // =========================================================================
  const negatives = unique.filter(a => a.collection_slug === 'render-negative')
  await writeFile('render-negative-excluded.json', JSON.stringify(negatives.map(a => ({ text: a.text, category: a.category_slug })), null, 2))
  console.log(`\nPhase 3.5: Excluded ${negatives.length} render-negative atoms -> render-negative-excluded.json`)
  for (let i = unique.length - 1; i >= 0; i--) {
    if (unique[i].collection_slug === 'render-negative') unique.splice(i, 1)
  }

  const animals = unique.filter(a => a.collection_slug === 'animals')
  const animalSample = animals.sort(() => Math.random() - 0.5).slice(0, 50).map(a => ({ text: a.text, category: a.category_slug, collection: a.collection_slug }))
  await writeFile('animals-sample.json', JSON.stringify(animalSample, null, 2))
  console.log(`Animals sample: ${animalSample.length} of ${animals.length} -> animals-sample.json`)

  // Save classified atoms for insert-only reruns
  const classifiedForInsert = unique.map(a => ({
    text: a.text,
    collection_slug: a.collection_slug || 'uncategorized',
    category_slug: a.category_slug || null,
  }))
  await writeFile('classified-atoms.json', JSON.stringify(classifiedForInsert))
  console.log(`Saved ${classifiedForInsert.length} classified atoms -> classified-atoms.json`)

  await runInsertPhase(unique)
}

main().catch(err => { console.error(`\nFatal: ${err.message}`); process.exit(1) })
