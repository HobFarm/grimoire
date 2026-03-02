#!/usr/bin/env node
/**
 * Grimoire Transform Pipeline
 * 
 * Reads the triage manifest, finds files tagged as "transform",
 * sends character/entity names to Gemini for visual description
 * generation, and outputs clean files ready for direct ingestion.
 * 
 * Usage:
 *   node transform.mjs --manifest triage-manifest.json --key "GEMINI_KEY"
 *   node transform.mjs --manifest triage-manifest.json --key "GEMINI_KEY" --output-dir transformed
 * 
 * Output: One .txt file per input file in the output directory,
 * with format "original_name | visual_description" per line.
 * Also outputs a transform-report.json summarizing results.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

const MANIFEST_PATH = getArg('manifest') || 'triage-manifest.json'
const API_KEY = getArg('key')
const OUTPUT_DIR = getArg('output-dir') || 'transformed'
const BATCH_SIZE = parseInt(getArg('batch-size') || '20', 10)
const CONCURRENCY = parseInt(getArg('concurrency') || '2', 10)

if (!API_KEY) {
  console.error('Usage: node transform.mjs --manifest <path> --key <gemini-key> [--output-dir <dir>] [--batch-size <n>]')
  process.exit(1)
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'

// ---------------------------------------------------------------------------
// Gemini visual description generator
// ---------------------------------------------------------------------------
const TRANSFORM_PROMPT = `You are a visual description specialist for an AI image generation knowledge base called the Grimoire.

You will receive a batch of character names, entity names, or references from games, anime, film, or other media. For each name, generate a concise visual description focusing ONLY on observable physical and design characteristics.

RULES:
- Describe what the character LOOKS LIKE, not their personality or story
- Focus on: silhouette, color palette, distinctive costume elements, material textures, hair style, notable accessories, design motifs
- Use precise visual vocabulary: "angular", "flowing", "matte black", "chrome accents", "asymmetrical", not vague terms like "cool" or "badass"
- If you don't know the character, describe what the NAME visually suggests (the aesthetic it evokes)
- Keep each description to 1-2 sentences, 15-40 words
- For artist/painter names: describe their visual STYLE, not biography
- For art movement names: describe the visual characteristics of the movement

OUTPUT FORMAT:
Return a JSON array of objects:
[
  {"name": "original name", "description": "visual description", "collection": "suggested_collection_slug"},
  ...
]

Valid collection slugs:
- reference.character: fictional characters with known visual designs
- reference.person: real people (artists, photographers, directors)
- style.genre: art movements, aesthetic categories
- subject.form: creature types, entity structures
- covering.outfit: distinctive costume/outfit descriptions
- style.era: period-specific visual references`

async function transformBatch(names, context, retries = 2) {
  const userPrompt = `Context: These names come from a file categorized as "${context}".

Transform these ${names.length} names into visual descriptions:

${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${GEMINI_URL}?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: TRANSFORM_PROMPT + '\n\n' + userPrompt }] }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 4096,
          },
        }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`Gemini ${response.status}: ${errText.slice(0, 200)}`)
      }

      const data = await response.json()
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!raw) throw new Error('Empty Gemini response')

      const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
      const parsed = JSON.parse(cleaned)

      if (!Array.isArray(parsed)) throw new Error('Expected array response')
      return parsed
    } catch (err) {
      if (attempt === retries) {
        console.error(`  BATCH FAILED: ${err.message}`)
        // Return partial results marking failures
        return names.map(n => ({
          name: n,
          description: `[FAILED: ${err.message.slice(0, 50)}]`,
          collection: 'unknown',
        }))
      }
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

// ---------------------------------------------------------------------------
// File processor
// ---------------------------------------------------------------------------
async function processFile(fileEntry, sourceDir) {
  const filePath = join(sourceDir, fileEntry.path)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)

  // Dedupe
  const unique = [...new Set(lines)]
  console.log(`  ${unique.length} unique entries (${lines.length} total)`)

  // Build context string from manifest data
  const context = `${fileEntry.folder} folder, ${fileEntry.type}, quality notes: ${fileEntry.quality_notes || 'none'}`

  // Process in batches
  const allResults = []
  const totalBatches = Math.ceil(unique.length / BATCH_SIZE)

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    process.stdout.write(`\r  Batch ${batchNum}/${totalBatches}`)

    const results = await transformBatch(batch, context)
    allResults.push(...results)

    // Rate limit pause
    if (i + BATCH_SIZE < unique.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  console.log(`\r  Processed ${allResults.length} entries across ${totalBatches} batches`)
  return allResults
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------
function writeIngestFile(results, outputPath) {
  // Group by collection
  const byCollection = {}
  for (const r of results) {
    const col = r.collection || 'unknown'
    if (!byCollection[col]) byCollection[col] = []
    byCollection[col].push(r)
  }

  // Write one file per collection group, format: "description" (one per line)
  // The original name is preserved as a comment for reference
  const lines = results
    .filter(r => !r.description.startsWith('[FAILED'))
    .map(r => r.description)

  return lines.join('\n')
}

function writeDetailedFile(results, outputPath) {
  // Full detail format: name | collection | description
  const lines = results.map(r => `${r.name}\t${r.collection || 'unknown'}\t${r.description}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\nGrimoire Transform Pipeline')
  console.log(`Manifest: ${MANIFEST_PATH}`)
  console.log(`Output: ${OUTPUT_DIR}/\n`)

  // Read manifest
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
  const sourceDir = manifest.source_directory

  // Filter for transform files
  const transformFiles = manifest.files.filter(f => f.ingest_strategy === 'transform')
  console.log(`Found ${transformFiles.length} files needing transformation\n`)

  if (transformFiles.length === 0) {
    console.log('No files to transform.')
    process.exit(0)
  }

  // Create output directory
  await mkdir(OUTPUT_DIR, { recursive: true })
  await mkdir(join(OUTPUT_DIR, 'ingest'), { recursive: true })
  await mkdir(join(OUTPUT_DIR, 'detailed'), { recursive: true })

  const report = {
    generated: new Date().toISOString(),
    files: [],
    totals: { processed: 0, succeeded: 0, failed: 0 },
  }

  for (let i = 0; i < transformFiles.length; i++) {
    const entry = transformFiles[i]
    console.log(`[${i + 1}/${transformFiles.length}] ${entry.path}`)

    try {
      const results = await processFile(entry, sourceDir)

      const succeeded = results.filter(r => !r.description.startsWith('[FAILED')).length
      const failed = results.length - succeeded

      // Write ingest-ready file (just descriptions, one per line)
      const ingestContent = writeIngestFile(results, '')
      const ingestPath = join(OUTPUT_DIR, 'ingest', basename(entry.file))
      await writeFile(ingestPath, ingestContent, 'utf-8')

      // Write detailed file (name + collection + description)
      const detailedContent = writeDetailedFile(results, '')
      const detailedPath = join(OUTPUT_DIR, 'detailed', basename(entry.file))
      await writeFile(detailedPath, detailedContent, 'utf-8')

      report.files.push({
        source: entry.path,
        entries: results.length,
        succeeded,
        failed,
        ingest_file: `ingest/${basename(entry.file)}`,
        detailed_file: `detailed/${basename(entry.file)}`,
      })

      report.totals.processed += results.length
      report.totals.succeeded += succeeded
      report.totals.failed += failed

      console.log(`  Output: ${succeeded} succeeded, ${failed} failed\n`)
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`)
      report.files.push({
        source: entry.path,
        error: err.message,
        entries: 0,
        succeeded: 0,
        failed: 0,
      })
    }
  }

  // Write report
  const reportPath = join(OUTPUT_DIR, 'transform-report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8')

  console.log('\n--- TRANSFORM COMPLETE ---')
  console.log(`Files processed: ${report.files.length}`)
  console.log(`Total entries: ${report.totals.processed}`)
  console.log(`Succeeded: ${report.totals.succeeded}`)
  console.log(`Failed: ${report.totals.failed}`)
  console.log(`Report: ${reportPath}`)
  console.log(`Ingest-ready files: ${OUTPUT_DIR}/ingest/`)
  console.log(`Detailed reference: ${OUTPUT_DIR}/detailed/`)
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`)
  process.exit(1)
})
