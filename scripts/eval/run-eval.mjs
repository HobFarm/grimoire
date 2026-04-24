#!/usr/bin/env node
/**
 * Eval Runner: Processes an eval set through the grader and produces aggregate results.
 *
 * Usage:
 *   node scripts/eval/run-eval.mjs --input scripts/eval/test-eval-set.json
 *   node scripts/eval/run-eval.mjs --input eval-set.json --no-artists
 *   node scripts/eval/run-eval.mjs --input eval-set.json --output scripts/eval/results/
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreImagePair } from './grader.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return undefined
  return args[idx + 1]
}

const inputPath = getArg('input')
const outputDir = getArg('output') || join(__dirname, 'results')
const noArtists = args.includes('--no-artists')

if (!inputPath) {
  console.error('Usage: node run-eval.mjs --input <eval-set.json> [--no-artists] [--output <dir>]')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Statistics Helpers
// ---------------------------------------------------------------------------

function computeStats(values) {
  if (values.length === 0) return { mean: 0, median: 0, stddev: 0, min: 0, max: 0 }

  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const median = values.length % 2 === 0
    ? (sorted[values.length / 2 - 1] + sorted[values.length / 2]) / 2
    : sorted[Math.floor(values.length / 2)]
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  const stddev = Math.sqrt(variance)

  return {
    mean: Math.round(mean * 1000) / 1000,
    median: Math.round(median * 1000) / 1000,
    stddev: Math.round(stddev * 1000) / 1000,
    min: Math.round(Math.min(...values) * 1000) / 1000,
    max: Math.round(Math.max(...values) * 1000) / 1000,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('=== MJ Eval Runner ===\n')

  // Read eval set
  const raw = readFileSync(inputPath, 'utf-8')
  const evalData = JSON.parse(raw)
  const evalSet = evalData.eval_set

  if (!evalSet || evalSet.length === 0) {
    console.error('No eval_set entries found in input file')
    process.exit(1)
  }

  // Build config
  const config = {
    includeArtists: noArtists ? false : (evalData.config?.includeArtists ?? false),
    weights: evalData.config?.weights ?? { vocabulary: 0.5, length: 0.25, structure: 0.25 },
  }

  console.log(`Eval set: ${evalSet.length} image pairs`)
  console.log(`Config: includeArtists=${config.includeArtists}, weights=${JSON.stringify(config.weights)}`)
  console.log()

  // Score each image pair
  const perImage = []
  const allVocabScores = []
  const allLengthRatios = []
  const allStructureScores = []
  const allCombined = []
  const missedTermCounts = new Map() // term -> { count, images }

  for (const entry of evalSet) {
    const result = scoreImagePair(entry.sf_prompt, entry.mj_prompts, config)

    perImage.push({
      image_id: entry.image_id,
      scores: result.scores,
      detail: result.detail,
      divergences: result.divergences,
    })

    allVocabScores.push(result.scores.vocabulary_overlap)
    allLengthRatios.push(result.scores.length_ratio)
    allStructureScores.push(result.scores.structure_score)
    allCombined.push(result.scores.combined)

    // Track missed terms
    for (const div of result.divergences) {
      if (div.type === 'vocabulary_miss' && div.mj_term) {
        const key = div.mj_term
        if (!missedTermCounts.has(key)) missedTermCounts.set(key, { count: 0, images: [] })
        const entry2 = missedTermCounts.get(key)
        entry2.count++
        entry2.images.push(entry.image_id)
      }
    }

    console.log(`  ${entry.image_id}: vocab=${result.scores.vocabulary_overlap} len=${result.scores.length_ratio} struct=${result.scores.structure_score} combined=${result.scores.combined}`)
  }

  // Top missed terms
  const topMissed = [...missedTermCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([term, data]) => ({
      term,
      missed_in: data.count,
      of: evalSet.length,
    }))

  // Axial summary (divergence type counts)
  const axialSummary = {}
  for (const img of perImage) {
    for (const div of img.divergences) {
      const key = `${div.type}_count`
      axialSummary[key] = (axialSummary[key] || 0) + 1
    }
  }

  // Build report
  const report = {
    run_date: new Date().toISOString(),
    eval_set_size: evalSet.length,
    config,
    per_image: perImage,
    aggregate: {
      vocabulary_overlap: computeStats(allVocabScores),
      length_ratio: computeStats(allLengthRatios),
      structure_score: computeStats(allStructureScores),
      combined: computeStats(allCombined),
    },
    top_missed_terms: topMissed,
    axial_summary: axialSummary,
  }

  // Write output
  mkdirSync(outputDir, { recursive: true })
  const date = new Date().toISOString().split('T')[0]
  const outputPath = join(outputDir, `eval-${date}.json`)
  writeFileSync(outputPath, JSON.stringify(report, null, 2))

  console.log()
  console.log('Aggregate:')
  console.log(`  Vocabulary: mean=${report.aggregate.vocabulary_overlap.mean} median=${report.aggregate.vocabulary_overlap.median}`)
  console.log(`  Length:     mean=${report.aggregate.length_ratio.mean} median=${report.aggregate.length_ratio.median}`)
  console.log(`  Structure:  mean=${report.aggregate.structure_score.mean} median=${report.aggregate.structure_score.median}`)
  console.log(`  Combined:   mean=${report.aggregate.combined.mean} median=${report.aggregate.combined.median}`)

  if (topMissed.length > 0) {
    console.log()
    console.log('Top missed terms:')
    for (const t of topMissed.slice(0, 10)) {
      console.log(`  "${t.term}" missed in ${t.missed_in}/${t.of} images`)
    }
  }

  console.log()
  console.log(`Report written to ${outputPath}`)
}

main()
