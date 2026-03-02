#!/usr/bin/env node
/**
 * Grimoire File Triage Agent
 * 
 * Walks a directory of wildcard/prompt files, samples each one,
 * sends samples to Gemini 2.0 Flash for classification, and
 * outputs a triage-manifest.json with ingestion recommendations.
 * 
 * Usage:
 *   node triage.mjs --dir "C:\path\to\data" --key "GEMINI_API_KEY"
 *   node triage.mjs --dir "C:\path\to\data" --key "GEMINI_API_KEY" --output custom-manifest.json
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, extname, basename, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

const DIR = getArg('dir')
const API_KEY = getArg('key')
const OUTPUT = getArg('output') || 'triage-manifest.json'
const CONCURRENCY = parseInt(getArg('concurrency') || '3', 10)

if (!DIR || !API_KEY) {
  console.error('Usage: node triage.mjs --dir <path> --key <gemini-api-key> [--output <file>] [--concurrency <n>]')
  process.exit(1)
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
async function walkDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    // Skip hidden/meta folders
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

    if (entry.isDirectory()) {
      const subFiles = await walkDir(fullPath)
      files.push(...subFiles)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (['.txt', '.json'].includes(ext)) {
        files.push(fullPath)
      }
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// File sampling
// ---------------------------------------------------------------------------
async function sampleFile(filePath) {
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0)
  const fileStats = await stat(filePath)

  // Unique line count (hash-based for speed)
  const uniqueSet = new Set(lines.map(l => l.trim().toLowerCase()))

  // Sample: first 10, last 5, 5 random from middle
  const first10 = lines.slice(0, 10)
  const last5 = lines.slice(-5)
  const middle = lines.slice(10, -5)
  const randomMiddle = []
  if (middle.length > 0) {
    const step = Math.max(1, Math.floor(middle.length / 5))
    for (let i = 0; i < Math.min(5, middle.length); i++) {
      randomMiddle.push(middle[Math.min(i * step, middle.length - 1)])
    }
  }

  return {
    filePath,
    fileName: basename(filePath),
    folder: basename(dirname(filePath)),
    relativePath: relative(DIR, filePath),
    totalLines: lines.length,
    uniqueLines: uniqueSet.size,
    duplicateRatio: lines.length > 0 ? parseFloat((1 - uniqueSet.size / lines.length).toFixed(3)) : 0,
    sizeKb: Math.round(fileStats.size / 1024),
    sampleFirst: first10,
    sampleLast: last5,
    sampleMiddle: randomMiddle,
    avgLineLength: lines.length > 0
      ? Math.round(lines.reduce((sum, l) => sum + l.length, 0) / lines.length)
      : 0,
  }
}

// ---------------------------------------------------------------------------
// Gemini classification
// ---------------------------------------------------------------------------
const TRIAGE_PROMPT = `You are a file triage agent for the Grimoire, a visual vocabulary and prompt engineering knowledge base.

Analyze the provided file sample and classify it for ingestion into the Grimoire system.

The Grimoire stores:
- ATOMS: Individual visual terms, names, descriptors (1 word to 1 sentence). These get classified into categories and vectorized for semantic search.
- SCHEMAS: Structural templates that define how atoms compose into complete prompts. Combination files with consistent positional slot structures.
- EXEMPLARS: Complete filled schemas serving as reference examples.

VALID INGESTION STRATEGIES:
- "direct": One line = one atom. Clean term lists, name lists, location lists. Ready to ingest as-is.
- "schema_extract": File contains combination templates with consistent positional structure (comma-separated attributes). Extract the schema pattern and store as schema + exemplars.
- "dedupe_and_ingest": File has valuable content but heavy duplication. Deduplicate first, then ingest uniques as atoms.
- "transform": File contains concepts that need AI enrichment before ingestion. Raw character names, franchise references, or data that lacks visual descriptors.
- "decompose": Lines contain mixed content types (scene descriptions with appended lighting/composition terms). Split into component parts before ingesting.
- "skip": File is too low quality, too repetitive, or contains content unsuitable for visual vocabulary.

VALID COLLECTION SUGGESTIONS (map to Grimoire categories):
subject.animal, subject.expression, subject.face, subject.feature, subject.form, subject.hair,
covering.accessory, covering.clothing, covering.footwear, covering.headwear, covering.material, covering.outfit,
environment.atmosphere, environment.prop, environment.setting, environment.natural,
lighting.source, camera.lens, camera.shot, color.palette,
style.era, style.genre, style.medium,
pose.interaction, pose.position,
object.drink, object.held,
negative.filter,
reference.film, reference.technique,
narrative.scene, narrative.mood,
composition.rule, effect.post,
reference.person (photographers, artists, directors),
reference.location (places, heritage sites, landmarks),
reference.character (fictional characters needing transformation),
reference.game (game systems, mechanics, settings)

Respond with ONLY a JSON object:
{
  "type": "term_list | combination_template | scene_description | name_list | location_list | character_reference | game_data | mixed | unknown",
  "ingest_strategy": "direct | schema_extract | dedupe_and_ingest | transform | decompose | skip",
  "collection_suggestion": "primary collection slug for the content",
  "secondary_collections": ["other relevant collections if content spans multiple"],
  "estimated_atom_yield": number,
  "quality_notes": "Brief assessment of content quality and what processing is needed",
  "priority": "high | medium | low | skip",
  "slot_structure": "If combination_template, describe the positional slot pattern. null otherwise."
}`

async function classifyFile(sample, retries = 2) {
  const userPrompt = `File: ${sample.fileName}
Folder: ${sample.folder}
Path: ${sample.relativePath}
Total lines: ${sample.totalLines}
Unique lines: ${sample.uniqueLines}
Duplicate ratio: ${sample.duplicateRatio}
Size: ${sample.sizeKb} KB
Avg line length: ${sample.avgLineLength} chars

FIRST 10 LINES:
${sample.sampleFirst.map((l, i) => `${i + 1}. ${l}`).join('\n')}

MIDDLE SAMPLE (5 random):
${sample.sampleMiddle.map((l, i) => `M${i + 1}. ${l}`).join('\n')}

LAST 5 LINES:
${sample.sampleLast.map((l, i) => `L${i + 1}. ${l}`).join('\n')}

Classify this file for Grimoire ingestion.`

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${GEMINI_URL}?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: TRIAGE_PROMPT + '\n\n' + userPrompt }] }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 512,
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
      return JSON.parse(cleaned)
    } catch (err) {
      if (attempt === retries) {
        console.error(`  FAILED after ${retries + 1} attempts: ${err.message}`)
        return {
          type: 'unknown',
          ingest_strategy: 'skip',
          collection_suggestion: null,
          secondary_collections: [],
          estimated_atom_yield: 0,
          quality_notes: `Classification failed: ${err.message}`,
          priority: 'skip',
          slot_structure: null,
        }
      }
      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------
async function processWithConcurrency(items, fn, limit) {
  const results = []
  let index = 0

  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i], i)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nGrimoire File Triage Agent`)
  console.log(`Directory: ${DIR}`)
  console.log(`Concurrency: ${CONCURRENCY}\n`)

  // Discover files
  console.log('Scanning directory...')
  const files = await walkDir(DIR)
  console.log(`Found ${files.length} files\n`)

  if (files.length === 0) {
    console.log('No .txt or .json files found.')
    process.exit(0)
  }

  // Sample all files first (fast, local I/O)
  console.log('Sampling files...')
  const samples = []
  for (const f of files) {
    try {
      samples.push(await sampleFile(f))
    } catch (err) {
      console.error(`  Skip ${f}: ${err.message}`)
    }
  }
  console.log(`Sampled ${samples.length} files\n`)

  // Classify via Gemini (rate-limited concurrency)
  console.log(`Classifying via Gemini (${CONCURRENCY} concurrent)...`)
  const startTime = Date.now()

  const classifications = await processWithConcurrency(
    samples,
    async (sample, idx) => {
      const pct = Math.round(((idx + 1) / samples.length) * 100)
      process.stdout.write(`\r  [${pct}%] ${idx + 1}/${samples.length} - ${sample.relativePath}`)

      const classification = await classifyFile(sample)

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 300))

      return {
        file: sample.fileName,
        folder: sample.folder,
        path: sample.relativePath,
        lines: sample.totalLines,
        unique_lines: sample.uniqueLines,
        duplicate_ratio: sample.duplicateRatio,
        size_kb: sample.sizeKb,
        avg_line_length: sample.avgLineLength,
        ...classification,
      }
    },
    CONCURRENCY
  )

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n\nClassified ${classifications.length} files in ${elapsed}s`)

  // Build manifest with summary stats
  const manifest = {
    generated: new Date().toISOString(),
    source_directory: DIR,
    total_files: classifications.length,
    summary: {
      by_strategy: {},
      by_priority: {},
      by_type: {},
      total_estimated_atoms: 0,
    },
    files: classifications,
  }

  // Compute summaries
  for (const c of classifications) {
    manifest.summary.by_strategy[c.ingest_strategy] = (manifest.summary.by_strategy[c.ingest_strategy] || 0) + 1
    manifest.summary.by_priority[c.priority] = (manifest.summary.by_priority[c.priority] || 0) + 1
    manifest.summary.by_type[c.type] = (manifest.summary.by_type[c.type] || 0) + 1
    manifest.summary.total_estimated_atoms += (c.estimated_atom_yield || 0)
  }

  // Write manifest
  await writeFile(OUTPUT, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`\nManifest written to: ${OUTPUT}`)

  // Print summary
  console.log('\n--- SUMMARY ---')
  console.log(`Total files: ${manifest.total_files}`)
  console.log(`Estimated total atom yield: ${manifest.summary.total_estimated_atoms.toLocaleString()}`)
  console.log('\nBy strategy:')
  for (const [k, v] of Object.entries(manifest.summary.by_strategy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`)
  }
  console.log('\nBy priority:')
  for (const [k, v] of Object.entries(manifest.summary.by_priority).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`)
  }
  console.log('\nBy type:')
  for (const [k, v] of Object.entries(manifest.summary.by_type).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`)
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`)
  process.exit(1)
})
