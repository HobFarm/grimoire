#!/usr/bin/env node
// Phase 1 of the wildcard connectivity bootstrap.
// READ-ONLY: walks wildcards/, derives tags from filenames, parses YAMLs,
// resolves all unique terms via /api/v1/resolve, emits a manifest JSON.
// Does not write to D1. Manifest is reviewed before Phase 2.
//
// Usage:
//   node scripts/wildcard-bootstrap.mjs
//   node scripts/wildcard-bootstrap.mjs --limit-to body,clothing,attire,material
//
// Env:
//   GRIMOIRE_SERVICE_TOKEN  bearer token for /api/v1/resolve
//   GRIMOIRE_RESOLVER_URL   override resolver URL

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import process from 'node:process'

const WILDCARDS_DIR = process.env.WILDCARDS_DIR || 'C:/Users/xkxxk/grimoire/wildcards'
const RESOLVER_URL = process.env.GRIMOIRE_RESOLVER_URL || 'https://grimoire.damp-violet-bf89.workers.dev/api/v1/resolve'
const RESOLVER_TOKEN = process.env.GRIMOIRE_SERVICE_TOKEN || 'hf-svc-9k3mX7pRwL2nYdQ8vB4jF6'
const OUTPUT_DIR = 'scripts/output'

const RESOLVE_MAX_PHRASES = 100
const RESOLVE_MAX_TOKENS = 500
const RESOLVE_CONCURRENCY = 4
const RESOLVE_MIN_CONFIDENCE = 0.7
const COMEMBERSHIP_MAX_FILE_SIZE = 100
const COMEMBERSHIP_HARD_CAP_LINES = 1000  // any file >this lines is excluded regardless of filename rule
const TERM_MAX_LENGTH = 100

// Non-`ism` non-`_painters` art movements with explicit allow-list entries.
const NON_ISM_MOVEMENTS = new Set([
  'baroque','rococo','art_nouveau','art_deco','bauhaus',
  'pop-art','op-art','renaissance','realism','art_brut',
  'classicism','neo-classicism','romanticism',
])

const STOP_WORDS = new Set([
  'the','a','an','of','in','on','with','and','or','for','to','by','from','as','at','into',
])

// --- CLI args ---
const args = process.argv.slice(2)
const limitToIdx = args.indexOf('--limit-to')
const limitPrefixes = limitToIdx >= 0 ? args[limitToIdx + 1].split(',').map(s => s.trim().toLowerCase()) : null

// --- Filename pattern rules. Ordered, first match wins. ---
// kind:
//   'axis'                — axis pole file (body-heavy etc)
//   'tag'                 — content file with derivable filename tags
//   'skip-correspondences' — content file too large/wrong-shape for co-membership
const PATTERN_RULES = [
  // Axis files
  { match: /^body-heavy$/i, kind: 'axis', axis: 'body-mass', pole: 'high' },
  { match: /^body-light$/i, kind: 'axis', axis: 'body-mass', pole: 'low' },
  { match: /^body-fit$/i, kind: 'axis', axis: 'body-condition', pole: 'high' },
  { match: /^body-poor$/i, kind: 'axis', axis: 'body-condition', pole: 'low' },
  { match: /^body-tall$/i, kind: 'axis', axis: 'body-height', pole: 'high' },
  { match: /^body-short$/i, kind: 'axis', axis: 'body-height', pole: 'low' },
  // body-shape: categorical, treat as content with a tag
  { match: /^body-shape$/i, kind: 'tag', tags: ['attribute-type:body-shape'] },

  // Skip correspondences (still resolve + tag) for known-huge / wrong-shape files
  { match: /_combinations\b/i, kind: 'skip-correspondences' },
  { match: /^noun/i, kind: 'skip-correspondences' },        // noun.txt, noun_full.txt, noun-general.txt
  { match: /^verb/i, kind: 'skip-correspondences' },        // verb.txt, verbing.txt
  { match: /^e621-/i, kind: 'skip-correspondences' },
  { match: /^artist[-_]/i, kind: 'skip-correspondences' },
  { match: /^artist$/i, kind: 'skip-correspondences' },
  { match: /^artist-csv$/i, kind: 'skip-correspondences' },

  // Materials → material-class:<name>
  { match: /^material_(.+)$/i, kind: 'tag', tagsFromMatch: m => [`material-class:${m[1].toLowerCase()}`] },

  // Clothing
  { match: /^clothing_male_/i, kind: 'tag', tags: ['gender:male'] },
  { match: /^clothing_female_/i, kind: 'tag', tags: ['gender:female'] },
  { match: /^clothing_traditional$/i, kind: 'tag', tags: ['formality:traditional'] },
  { match: /^clothing_asia_/i, kind: 'tag', tags: ['cultural-origin:east-asian'] },

  // Attire — jewelry sub-files
  { match: /^attire_jewelry_and_accessories_head_and_face$/i, kind: 'tag', tags: ['body-region:head', 'attribute-type:jewelry'] },
  { match: /^attire_jewelry_and_accessories_limbs$/i, kind: 'tag', tags: ['body-region:limbs', 'attribute-type:jewelry'] },
  { match: /^attire_jewelry_and_accessories_neck_and_shoulders$/i, kind: 'tag', tags: ['body-region:neck', 'attribute-type:jewelry'] },
  { match: /^attire_jewelry_and_accessories_torso_and_misc$/i, kind: 'tag', tags: ['body-region:torso', 'attribute-type:jewelry'] },

  // Attire — body region
  { match: /^attire_headwear$/i, kind: 'tag', tags: ['body-region:head'] },
  { match: /^attire_shirts_/i, kind: 'tag', tags: ['body-region:upper-body'] },
  { match: /^attire_pants_/i, kind: 'tag', tags: ['body-region:lower-body'] },
  { match: /^attire_legs_and_feet$/i, kind: 'tag', tags: ['body-region:legs', 'body-region:feet'] },
  { match: /^attire_shoes_/i, kind: 'tag', tags: ['body-region:feet'] },
  { match: /^attire_swimsuits_/i, kind: 'tag', tags: ['formality:swimwear', 'attribute-type:garment'] },
  { match: /^attire_uniforms_/i, kind: 'tag', tags: ['formality:costume', 'attribute-type:garment'] },
  { match: /^attire_traditional_/i, kind: 'tag', tags: ['formality:traditional'] },
  { match: /^attire_styles_.*_patterns$/i, kind: 'tag', tags: ['attribute-type:pattern'] },
  { match: /^attire_styles_.*_prints$/i, kind: 'tag', tags: ['attribute-type:print'] },
  { match: /^attire_other$/i, kind: 'tag', tags: ['attribute-type:trim'] },

  // Movement files. Three detection paths:
  //   1. Filename ends with 'ism' (cubism, dadaism, abstract_expressionism, ...)
  //   2. Filename matches `_painters` (british_baroque_painters, ...)
  //   3. Explicit non-ism allow-list (NON_ISM_MOVEMENTS)
  // Slug = basename with '_' -> '-', lowercased.
  // Movement-name is also queued for resolution so Phase 2 Stage 5 can build artist-to-movement edges.
  { match: /ism$/i, kind: 'movement' },
  { match: /_painters$/i, kind: 'movement' },
  { match: /_painters_/i, kind: 'movement' },

  // Generic clothing/attire files: still useful, but no specific tag derivation.
  // Caught by "unmatched" bucket so user can decide whether to add rules.
]

function buildMovementInfo(baseNoExt) {
  const slug = baseNoExt.toLowerCase().replace(/_/g, '-')
  const name = baseNoExt.toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim()
  return { slug: `movement:${slug}`, movementName: name }
}

function classifyFile(name) {
  const baseNoExt = basename(name, '.txt')
  // Non-ism explicit movements take precedence so they aren't caught by other rules.
  if (NON_ISM_MOVEMENTS.has(baseNoExt.toLowerCase())) {
    const info = buildMovementInfo(baseNoExt)
    return { kind: 'movement', tags: [info.slug], movementSlug: info.slug, movementName: info.movementName, skipCoMembership: false }
  }
  for (const rule of PATTERN_RULES) {
    const m = baseNoExt.match(rule.match)
    if (!m) continue
    if (rule.kind === 'axis') return { kind: 'axis', axis: rule.axis, pole: rule.pole, tags: [] }
    if (rule.kind === 'skip-correspondences') return { kind: 'content', tags: [], skipCoMembership: true }
    if (rule.kind === 'tag') {
      const tags = rule.tags || (rule.tagsFromMatch ? rule.tagsFromMatch(m) : [])
      return { kind: 'content', tags, skipCoMembership: false }
    }
    if (rule.kind === 'movement') {
      const info = buildMovementInfo(baseNoExt)
      return { kind: 'movement', tags: [info.slug], movementSlug: info.slug, movementName: info.movementName, skipCoMembership: false }
    }
  }
  return { kind: 'unmatched', tags: [], skipCoMembership: false }
}

function cleanTerm(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#')) return null
  if (trimmed.startsWith('//')) return null
  if (/^[{<].*[>}]$/.test(trimmed)) return null
  if (trimmed.length > TERM_MAX_LENGTH) return null
  return trimmed
}

function countTokens(phrase) {
  const tokens = phrase.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean)
  return tokens.filter(t => !STOP_WORDS.has(t)).length
}

// --- YAML extractor: regex-based, specific to wildcards/*.yaml structure ---
function extractYamlEntries(text) {
  const entries = []
  const lines = text.split(/\r?\n/)
  let currentKey = null
  let inTags = false
  let currentTags = []

  function flush() {
    if (currentKey) entries.push({ key: currentKey, tags: currentTags })
    currentKey = null; currentTags = []; inTags = false
  }

  for (const raw of lines) {
    if (!raw.trim()) continue
    // Top-level key: no leading whitespace, ends with colon (possibly with junk after)
    if (!/^\s/.test(raw) && raw.includes(':')) {
      flush()
      let k = raw.replace(/:\s*$/, '').trim()
      if (k.startsWith("'") && k.endsWith("'")) k = k.slice(1, -1)
      if (k.startsWith('"') && k.endsWith('"')) k = k.slice(1, -1)
      currentKey = k
      continue
    }
    if (/^\s+Tags\s*:\s*$/.test(raw)) { inTags = true; continue }
    if (/^\s+Description\s*:/.test(raw)) { inTags = false; continue }
    if (inTags && /^\s+-\s+/.test(raw)) {
      const t = raw.replace(/^\s+-\s+/, '').trim()
      if (t) currentTags.push(t)
    }
  }
  flush()
  return entries
}

function isSimpleYamlKey(key) {
  return !/[{}<>|*]/.test(key) && !key.includes('  ') && key.length <= 80 && key.length > 0
}

function normalizeYamlTag(tag) {
  return tag.toLowerCase().trim().replace(/\s+/g, '-')
}

// --- Adaptive batcher: respects MAX_PHRASES AND MAX_TOKENS resolver limits ---
function buildBatches(terms) {
  const batches = []
  let current = []
  let tokens = 0
  for (const term of terms) {
    const t = countTokens(term) || 1
    if (current.length > 0 && (current.length >= RESOLVE_MAX_PHRASES || tokens + t > RESOLVE_MAX_TOKENS)) {
      batches.push(current); current = []; tokens = 0
    }
    current.push(term); tokens += t
  }
  if (current.length) batches.push(current)
  return batches
}

async function callResolver(phrases, attempt = 1) {
  const r = await fetch(RESOLVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESOLVER_TOKEN}` },
    body: JSON.stringify({ phrases, min_confidence: RESOLVE_MIN_CONFIDENCE }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    if (attempt < 3 && (r.status === 500 || r.status === 502 || r.status === 503)) {
      await new Promise(res => setTimeout(res, 500 * attempt))
      return callResolver(phrases, attempt + 1)
    }
    throw new Error(`resolver ${r.status}: ${text.slice(0, 200)}`)
  }
  return r.json()
}

async function resolveAll(terms) {
  const batches = buildBatches(terms)
  console.error(`  ${terms.length} unique terms in ${batches.length} batches (concurrency=${RESOLVE_CONCURRENCY})`)
  const results = new Map()
  let processed = 0
  let failedBatches = 0
  const queue = batches.slice()
  const startTime = Date.now()

  async function worker() {
    while (queue.length) {
      const batch = queue.shift()
      if (!batch) return
      try {
        const res = await callResolver(batch)
        res.results.forEach((r, i) => results.set(batch[i], r.atoms))
      } catch (err) {
        failedBatches++
        console.error(`  [batch fail] ${err.message}`)
        for (const t of batch) results.set(t, [])
      }
      processed += batch.length
      if (processed % 5000 < RESOLVE_MAX_PHRASES) {
        const pct = (processed / terms.length * 100).toFixed(1)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        console.error(`  ...${processed}/${terms.length} (${pct}%) in ${elapsed}s`)
      }
    }
  }

  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, worker))
  if (failedBatches > 0) console.error(`  WARNING: ${failedBatches} batches failed permanently`)
  return results
}

// --- Main ---
async function main() {
  console.error(`[1/4] Walking wildcards directory: ${WILDCARDS_DIR}`)
  const allEntries = await readdir(WILDCARDS_DIR, { withFileTypes: true })
  let txtFiles = allEntries.filter(e => e.isFile() && e.name.endsWith('.txt')).map(e => e.name)
  let yamlFiles = allEntries.filter(e => e.isFile() && /\.ya?ml$/i.test(e.name)).map(e => e.name)

  if (limitPrefixes) {
    const matches = (n) => limitPrefixes.some(p => n.toLowerCase().startsWith(p))
    txtFiles = txtFiles.filter(matches)
    yamlFiles = yamlFiles.filter(matches)
    console.error(`  --limit-to ${limitPrefixes.join(',')}: ${txtFiles.length} .txt + ${yamlFiles.length} .yaml`)
  } else {
    console.error(`  found ${txtFiles.length} .txt files, ${yamlFiles.length} .yaml files`)
  }

  console.error(`[2/4] Parsing files and deriving tags...`)
  const termIndex = new Map() // term → { files: string[], tagsFromFiles: Set, tagsFromYaml: Set, axesFromFiles: [{axis,pole,file}] }
  const fileResults = []
  // movement-slug -> { file, lineCount, movementName, movementAtomId?, movementMatchType? }
  const movementFiles = new Map()

  for (const f of txtFiles) {
    const cls = classifyFile(f)
    const text = await readFile(join(WILDCARDS_DIR, f), 'utf8')
    const lines = text.split(/\r?\n/).map(cleanTerm).filter(Boolean)
    const skipCo = cls.skipCoMembership || lines.length > COMEMBERSHIP_MAX_FILE_SIZE || lines.length > COMEMBERSHIP_HARD_CAP_LINES
    fileResults.push({
      file: f,
      kind: cls.kind,
      lineCount: lines.length,
      tags: cls.tags || [],
      axis: cls.axis ?? null,
      pole: cls.pole ?? null,
      movementSlug: cls.movementSlug ?? null,
      skipCoMembership: skipCo,
    })
    if (cls.kind === 'movement') {
      // First file wins per slug (collisions extremely unlikely given basename-based slugs)
      if (!movementFiles.has(cls.movementSlug)) {
        movementFiles.set(cls.movementSlug, {
          file: f, lineCount: lines.length, movementName: cls.movementName,
          movementAtomId: null, movementMatchType: null,
        })
      }
    }
    for (const term of lines) {
      let entry = termIndex.get(term)
      if (!entry) { entry = { files: [], tagsFromFiles: new Set(), tagsFromYaml: new Set(), axesFromFiles: [] }; termIndex.set(term, entry) }
      entry.files.push(f)
      for (const t of (cls.tags || [])) entry.tagsFromFiles.add(t)
      if (cls.kind === 'axis') entry.axesFromFiles.push({ axis: cls.axis, pole: cls.pole, file: f })
    }
  }

  for (const yf of yamlFiles) {
    const text = await readFile(join(WILDCARDS_DIR, yf), 'utf8')
    const entries = extractYamlEntries(text)
    const simple = entries.filter(e => isSimpleYamlKey(e.key))
    fileResults.push({
      file: yf, kind: 'yaml',
      entryCount: entries.length, simpleEntryCount: simple.length, complexEntryCount: entries.length - simple.length,
    })
    for (const { key, tags } of simple) {
      const term = key.trim()
      let entry = termIndex.get(term)
      if (!entry) { entry = { files: [], tagsFromFiles: new Set(), tagsFromYaml: new Set(), axesFromFiles: [] }; termIndex.set(term, entry) }
      entry.files.push(yf)
      for (const t of tags) entry.tagsFromYaml.add(`yaml:${normalizeYamlTag(t)}`)
    }
  }

  console.error(`  ${termIndex.size} unique terms across ${fileResults.length} files`)

  console.error(`[3/4] Resolving terms via ${RESOLVER_URL}`)
  const uniqueTerms = Array.from(termIndex.keys())
  const resolved = await resolveAll(uniqueTerms)

  // Resolve movement-name -> atom for each movement file (a separate small batch).
  // Tighten: require the resolved atom's text to exactly equal the movement name
  // (case-insensitive). Otherwise the resolver may return a token-level bigram
  // match (e.g. "american painters" for "american romantic painters") which would
  // pollute Stage 5 with wrong artist-to-movement edges.
  const movementNames = Array.from(new Set(Array.from(movementFiles.values()).map(m => m.movementName))).filter(Boolean)
  if (movementNames.length > 0) {
    console.error(`  resolving ${movementNames.length} movement names for Stage 5 correspondences...`)
    const movementResolved = await resolveAll(movementNames)
    for (const info of movementFiles.values()) {
      const atoms = movementResolved.get(info.movementName) ?? []
      const exact = atoms.find(a => (a.text || '').trim().toLowerCase() === info.movementName.toLowerCase())
      if (exact) {
        info.movementAtomId = exact.id
        info.movementMatchType = exact.match_type
      }
    }
  }

  console.error(`[4/4] Assembling manifest...`)
  const atomsSection = {}
  let resolvedCount = 0
  let unresolvedCount = 0
  const unresolvedSample = []
  const matchTypeCounts = { exact: 0, prefix: 0, semantic: 0 }

  for (const term of uniqueTerms) {
    const atoms = resolved.get(term) ?? []
    const entry = termIndex.get(term)
    if (atoms.length === 0) {
      unresolvedCount++
      if (unresolvedSample.length < 100) unresolvedSample.push(term)
      continue
    }
    resolvedCount++
    const best = atoms[0]
    matchTypeCounts[best.match_type] = (matchTypeCounts[best.match_type] || 0) + 1
    atomsSection[term] = {
      atom_id: best.id,
      atom_text: best.text,
      category_slug: best.category_slug,
      match_type: best.match_type,
      confidence: best.confidence,
      file_count: entry.files.length,
      files: entry.files.slice(0, 20),
      tags_from_files: Array.from(entry.tagsFromFiles),
      tags_from_yaml: Array.from(entry.tagsFromYaml),
      axes: entry.axesFromFiles,
    }
  }

  const tagsSection = {}
  for (const fr of fileResults) {
    if (!fr.tags || fr.tags.length === 0) continue
    for (const tag of fr.tags) {
      if (!tagsSection[tag]) tagsSection[tag] = []
      tagsSection[tag].push(fr.file)
    }
  }

  const axesSection = {}
  for (const fr of fileResults) {
    if (fr.kind !== 'axis') continue
    if (!axesSection[fr.axis]) axesSection[fr.axis] = {}
    axesSection[fr.axis][fr.pole] = { file: fr.file, line_count: fr.lineCount }
  }

  const unmatched = fileResults.filter(f => f.kind === 'unmatched').map(f => f.file)
  const skipCorr = fileResults.filter(f => f.skipCoMembership).map(f => f.file)

  // Build movement_files manifest section + stats
  const movementFilesSection = {}
  let movementResolvedCount = 0
  for (const [slug, info] of movementFiles) {
    movementFilesSection[slug] = info
    if (info.movementAtomId) movementResolvedCount++
  }

  const stats = {
    files_total: fileResults.length,
    files_txt: txtFiles.length,
    files_yaml: yamlFiles.length,
    files_axis: fileResults.filter(f => f.kind === 'axis').length,
    files_with_tags: fileResults.filter(f => f.kind === 'content' && f.tags.length > 0).length,
    files_movement: fileResults.filter(f => f.kind === 'movement').length,
    files_unmatched: unmatched.length,
    files_skip_correspondences: skipCorr.length,
    terms_unique: uniqueTerms.length,
    terms_resolved: resolvedCount,
    terms_unresolved: unresolvedCount,
    resolution_rate_pct: Number((resolvedCount / Math.max(1, uniqueTerms.length) * 100).toFixed(1)),
    match_type_counts: matchTypeCounts,
    tags_distinct: Object.keys(tagsSection).length,
    tag_categories: [...new Set(Object.keys(tagsSection).map(t => t.split(':')[0]))],
    axes_total: Object.keys(axesSection).length,
    movements_total: movementFiles.size,
    movements_resolved: movementResolvedCount,
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    phase: 1,
    schema_warnings_for_phase_2: [
      "atoms.id is TEXT not INTEGER. The proposed atom_tags table needs atom_id TEXT REFERENCES atoms(id), not INTEGER.",
      "dimension_memberships has NO `position` or `confidence` columns. Schema: (atom_id TEXT, axis_slug TEXT, pole TEXT CHECK IN ('low','high'), source TEXT, created_at TEXT) PRIMARY KEY (atom_id, axis_slug). The brief's plan to 'distribute positions 0.75-1.0' cannot run; pole is a discrete enum.",
      "Table is `correspondences` (not `atom_correspondences`). CHECK on provenance IN ('harmonic','semantic','exemplar','co_occurrence') — wildcard co-membership maps to provenance='co_occurrence'. There is NO `source` column; wildcard origin should go in `metadata` JSON.",
      "dimension_axes table exists. New axes (body-condition, body-height) need rows with: slug, label_low, label_high, harmonic_key, description, active. body-mass already exists.",
      "Last applied migration is 0032_dimensional_vocab.sql. Next migration would be 0033.",
      "Current dimension_memberships row counts: aesthetic-mass=127, body-mass=44 (171 total). Wildcard bootstrap should INSERT OR IGNORE to preserve these.",
    ],
    config: {
      wildcards_dir: WILDCARDS_DIR,
      resolver_url: RESOLVER_URL,
      min_confidence: RESOLVE_MIN_CONFIDENCE,
      comembership_max_file_size: COMEMBERSHIP_MAX_FILE_SIZE,
      limit_to: limitPrefixes,
    },
    stats,
    axes: axesSection,
    tags: tagsSection,
    movement_files: movementFilesSection,
    unmatched_files: unmatched,
    skip_correspondences_files: skipCorr,
    unresolved_sample: unresolvedSample,
    files: fileResults,
    atoms: atomsSection,
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const suffix = limitPrefixes ? `-${limitPrefixes.join('+')}` : ''
  const outPath = join(OUTPUT_DIR, `wildcard-bootstrap-${date}${suffix}.json`)
  await writeFile(outPath, JSON.stringify(manifest, null, 2))

  console.error('\n=== Phase 1 Manifest Summary ===')
  console.error(JSON.stringify(stats, null, 2))
  console.error(`\nAxes detected: ${Object.keys(axesSection).join(', ') || '(none)'}`)
  console.error(`Tag categories: ${stats.tag_categories.join(', ') || '(none)'}`)
  console.error(`Movements: ${stats.movements_total} files, ${stats.movements_resolved} with resolved movement-atom`)
  console.error(`Unmatched files: ${unmatched.length}`)
  if (unmatched.length > 0) console.error(`  first 15: ${unmatched.slice(0, 15).join(', ')}${unmatched.length > 15 ? ` ... (+${unmatched.length - 15} more)` : ''}`)
  console.error(`\nManifest: ${outPath}`)
  console.error(`\nReview before invoking Phase 2.`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
