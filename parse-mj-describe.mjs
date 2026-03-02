// parse-mj-describe.mjs
// Parses Midjourney /describe prompts into scene + style atoms
// and ingests them via /admin/ingest-batch.
//
// Usage:
//   node parse-mj-describe.mjs --dry-run
//   node parse-mj-describe.mjs
//   node parse-mj-describe.mjs --file "other-prompts.txt" --batch-size 300

import { readFile } from 'node:fs/promises'
import { normalizeText } from './normalize.mjs'

const args = process.argv.slice(2)
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] ? args[i + 1] : null }
const hasFlag = (name) => args.includes(`--${name}`)

const FILE_PATH = getArg('file') || 'midjourney describe prompts - all.txt'
const WORKER_URL = getArg('worker-url') || 'https://grimoire.damp-violet-bf89.workers.dev'
const BATCH_SIZE = parseInt(getArg('batch-size') || '500', 10)
const DRY_RUN = hasFlag('dry-run')

const DELIMITER = ', in the style of '
const MIN_SCENE_LEN = 3
const MIN_STYLE_LEN = 2

// --- Text cleanup ---

function cleanText(s) {
  let t = s.trim()
  t = t.replace(/\.$/, '').trim()
  t = t.replace(/\s+/g, ' ')
  return t || null
}

// --- Parse a single line into atom objects ---

function parseLine(line) {
  const cleaned = line.replace(/\r/g, '').trim()
  if (!cleaned) return null
  if (/^image$/i.test(cleaned)) return null

  const atoms = []
  const delimIdx = cleaned.indexOf(DELIMITER)

  if (delimIdx === -1) {
    // No delimiter: whole line is a scene atom
    const scene = cleanText(cleaned)
    if (scene && scene.length >= MIN_SCENE_LEN) {
      atoms.push({ text: scene, collection_slug: 'mj-scenes', category_slug: null })
    }
  } else {
    // Left side: scene
    const scene = cleanText(cleaned.substring(0, delimIdx))
    if (scene && scene.length >= MIN_SCENE_LEN) {
      atoms.push({ text: scene, collection_slug: 'mj-scenes', category_slug: null })
    }

    // Right side: comma-separated style terms
    const styleSection = cleaned.substring(delimIdx + DELIMITER.length)
    for (const term of styleSection.split(',')) {
      const style = cleanText(term)
      if (!style || style.length < MIN_STYLE_LEN) continue
      if (/^\d+$/.test(style)) continue
      atoms.push({ text: style, collection_slug: 'mj-styles', category_slug: null })
    }
  }

  return atoms.length > 0 ? atoms : null
}

// --- API ---

async function sendBatch(atoms) {
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
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --- Ingest ---

async function ingestAtoms(atoms) {
  const totalBatches = Math.ceil(atoms.length / BATCH_SIZE)
  console.log(`\nPhase 3: Ingesting ${atoms.length} atoms (${totalBatches} batches of ${BATCH_SIZE})...`)

  let totalInserted = 0
  let totalSkipped = 0
  let totalErrors = 0
  const startTime = Date.now()

  for (let i = 0; i < atoms.length; i += BATCH_SIZE) {
    const batch = atoms.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    try {
      const result = await sendBatch(batch)
      totalInserted += result.inserted || 0
      totalSkipped += result.skipped || 0
    } catch (err) {
      console.log(`\n  Batch ${batchNum} failed: ${err.message.slice(0, 80)}. Retrying in 5s...`)
      await sleep(5000)
      try {
        const result = await sendBatch(batch)
        totalInserted += result.inserted || 0
        totalSkipped += result.skipped || 0
      } catch (err2) {
        totalErrors += batch.length
        console.log(`\n  Batch ${batchNum} FAILED after retry: ${err2.message.slice(0, 80)}`)
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
    const pct = Math.floor((batchNum / totalBatches) * 100)
    process.stdout.write(`\r  [${pct}%] ${batchNum}/${totalBatches} - inserted: ${totalInserted}, skipped: ${totalSkipped}, errors: ${totalErrors} (${elapsed}s)`)
  }

  console.log('\n\n--- COMPLETE ---')
  console.log(`Total: ${atoms.length}`)
  console.log(`Inserted: ${totalInserted}`)
  console.log(`Skipped (dupes): ${totalSkipped}`)
  console.log(`Errors: ${totalErrors}`)
  console.log('\nNext: classify via /admin/classify-batch, then vectorize via /admin/vectorize-batch')
}

// --- Main ---

async function main() {
  console.log('\nMidjourney Describe Parser')
  console.log(`File: ${FILE_PATH}`)
  console.log(`Worker: ${WORKER_URL}`)
  console.log(`Batch size: ${BATCH_SIZE}`)
  if (DRY_RUN) console.log('*** DRY RUN ***')

  // Phase 1: Read + parse
  console.log('\nPhase 1: Reading file...')
  const raw = await readFile(FILE_PATH, 'utf-8')
  const lines = raw.split('\n')

  const allAtoms = []
  let contentLines = 0
  let skippedEmpty = 0
  let skippedImage = 0

  for (const line of lines) {
    const stripped = line.replace(/\r/g, '').trim()
    if (!stripped) { skippedEmpty++; continue }
    if (/^image$/i.test(stripped)) { skippedImage++; continue }
    contentLines++
    const atoms = parseLine(line)
    if (atoms) allAtoms.push(...atoms)
  }

  console.log(`  Lines: ${lines.length} total, ${contentLines} content, ${skippedEmpty} empty, ${skippedImage} "Image"`)
  console.log(`  Raw atoms: ${allAtoms.length}`)

  // Phase 2: Normalize + dedup
  console.log('\nPhase 2: Normalize + dedup...')
  const seen = new Set()
  const unique = []
  let normSkipped = 0
  let dupes = 0

  for (const atom of allAtoms) {
    const normalized = normalizeText(atom.text)
    if (!normalized) { normSkipped++; continue }

    // Enforce min scene length (normalizeText already enforces >= 2)
    if (atom.collection_slug === 'mj-scenes' && normalized.length < MIN_SCENE_LEN) {
      normSkipped++
      continue
    }

    const key = normalized.toLowerCase()
    if (seen.has(key)) { dupes++; continue }
    seen.add(key)
    unique.push({ ...atom, text: normalized })
  }

  const scenes = unique.filter(a => a.collection_slug === 'mj-scenes')
  const styles = unique.filter(a => a.collection_slug === 'mj-styles')

  console.log(`  Normalized: ${normSkipped} filtered, ${dupes} deduped`)
  console.log(`  Unique atoms: ${unique.length} (${scenes.length} scenes, ${styles.length} styles)`)

  if (DRY_RUN) {
    console.log('\n*** DRY RUN COMPLETE ***')
    console.log('\nSample scenes (first 5):')
    scenes.slice(0, 5).forEach(a => console.log(`  ${a.text}`))
    console.log('\nSample styles (first 10):')
    styles.slice(0, 10).forEach(a => console.log(`  ${a.text}`))
    return
  }

  // Phase 3: Ingest
  await ingestAtoms(unique)
}

main().catch(err => { console.error(`\nFatal: ${err.message}`); process.exit(1) })
