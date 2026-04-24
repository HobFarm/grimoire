/**
 * Grimoire Batch Classifier
 *
 * Assigns category_slug and harmonics to uncategorized atoms.
 * Workers AI (Nemotron) primary, Gemini fallback, circuit breaker.
 * Run as: POST /classify?batch_size=50&collection=style
 * Or run all: POST /classify?batch_size=50
 *
 * Designed for manual triggering, not cron. Run it, watch the logs,
 * iterate on prompt if classification quality needs tuning.
 *
 * Categories are fetched from GRIMOIRE_DB at runtime, not hardcoded.
 */

import { callClassifier } from './ai'

interface Env {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  AI: Ai
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_NAME: string
  GEMINI_API_KEY: string
  AI_GATEWAY_TOKEN: string
  PROVIDER_HEALTH: KVNamespace
}

// The five cymatics dimensions (all numeric 0.0-1.0)
interface HarmonicProfile {
  hardness: number      // 0.0 (soft) to 1.0 (hard)
  temperature: number   // 0.0 (cool) to 1.0 (warm)
  weight: number        // 0.0 (light) to 1.0 (heavy)
  formality: number     // 0.0 (organic) to 1.0 (structured)
  era_affinity: number  // 0.0 (ancient) to 1.0 (futuristic)
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (isNaN(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

interface ClassificationResult {
  atom_id: string
  text: string
  category_slug: string
  harmonics: HarmonicProfile
}

interface AtomRow {
  id: string
  text_lower: string
  collection_slug: string
}

interface CategoryMetadata {
  slug: string
  description: string
  default_modality: string
}

async function getCategoryMetadata(db: D1Database): Promise<CategoryMetadata[]> {
  const res = await db.prepare(
    'SELECT slug, description, default_modality FROM categories ORDER BY slug'
  ).all<CategoryMetadata>()
  return res.results
}

/**
 * Build classification prompt from DB-sourced categories.
 * Groups by default_modality to match the model's expected format.
 */
function buildClassifierPrompt(categories: CategoryMetadata[]): string {
  const visual = categories.filter(c => c.default_modality === 'visual')
  const narrative = categories.filter(c => c.default_modality === 'narrative')
  const both = categories.filter(c => c.default_modality === 'both')

  const formatCat = (c: CategoryMetadata) => `- ${c.slug}: ${c.description}`

  return `You are classifying visual prompt atoms for an AI image generation system called the Grimoire.

Each atom is a short text term (1-5 words) that describes a visual element used in image composition prompts. Your job is to assign each atom:

1. A category_slug from the valid list below
2. A harmonic profile with exactly 5 dimensions

VALID CATEGORIES:

VISUAL CATEGORIES:
${visual.map(formatCat).join('\n')}

NARRATIVE CATEGORIES:
${narrative.map(formatCat).join('\n')}

DUAL-MODE CATEGORIES:
${both.map(formatCat).join('\n')}

HARMONIC DIMENSIONS (assign a float value 0.0 to 1.0 for each):
- hardness: 0.0 = soft, flowing, draped, rounded, gentle, yielding, plush. 1.0 = hard, rigid, angular, sharp edges, stiff, armor-like, geometric. 0.5 = genuinely ambiguous (RARE).
- temperature: 0.0 = cool, blues, greens, silver, ice, steel, chrome, moonlight, slate. 1.0 = warm, reds, oranges, golden, amber, fire, candlelight, earth tones, copper, brass. 0.5 = genuinely achromatic (RARE).
- weight: 0.0 = light, thin, sheer, delicate, ethereal, airy, transparent, minimal. 1.0 = heavy, dense, thick, substantial, layered, grounded, massive, opaque. 0.5 = genuinely indeterminate (RARE).
- formality: 0.0 = organic, natural, irregular, weathered, grown, handmade, asymmetrical. 1.0 = structured, geometric, precise, manufactured, tailored, engineered, symmetrical. 0.5 = genuinely neither (RARE).
- era_affinity: 0.0 = ancient, medieval, mythological, primitive, pre-industrial. 0.4 = industrial, 1880s-1960s, machine age, art deco, noir. 0.8 = modern, contemporary, digital, futuristic, synthetic, neon. 0.5 = genuinely era-independent (RARE, like "sleeve" or "button").

CRITICAL: 0.5 is NOT a default. It is a rare exception for genuinely ambiguous atoms. Most visual terms carry directional bias. Commit to a lean even if slight. A value of 0.35 or 0.65 is better than 0.5.

Examples:
- "long sleeves" -> formality:0.7 (constructed garment), weight:0.5, era_affinity:0.5
- "fingerless design" -> formality:0.75 (deliberate cutaway), era_affinity:0.8 (punk/tactical)
- "black fabric" -> temperature:0.2 (black reads cool), weight:0.75 (dark = visual weight)
- "loose cloak" -> formality:0.15 (draping), weight:0.8 (full coverage), era_affinity:0.1
- "neon glow" -> temperature:0.15, hardness:0.85 (sharp light edges), era_affinity:0.9
- "leather" -> hardness:0.8, temperature:0.7 (earth material), formality:0.8, era_affinity:0.4
- "lace" -> hardness:0.15, weight:0.2, formality:0.2 (handcraft pattern)

Think about what this term LOOKS LIKE in an image. A slight lean is better than center.

The atom's current collection provides context but may be wrong (that is why we are reclassifying).

Respond with ONLY a JSON array. No markdown, no explanation. Each element:
{"id":"atom_id","cat":"category_slug","h":{"hardness":0.0,"temperature":0.0,"weight":0.0,"formality":0.0,"era_affinity":0.0}}
`
}

async function classifyBatch(
  atoms: AtomRow[],
  env: Env,
  categories: CategoryMetadata[]
): Promise<ClassificationResult[]> {
  const validSlugs = new Set(categories.map(c => c.slug))
  const prompt = buildClassifierPrompt(categories)

  const atomList = atoms.map(a =>
    `- id:${a.id} text:"${a.text_lower}" collection:${a.collection_slug}`
  ).join('\n')

  const result = await callClassifier(env, prompt, 'ATOMS TO CLASSIFY:\n' + atomList)

  // Strip markdown fences if present, parse JSON
  let cleaned = result.text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  const parsed = JSON.parse(cleaned)

  // Handle bare array or wrapped object (e.g. { results: [...] })
  const raw: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed.results ?? parsed.classifications ?? [])

  // Normalize keys: accept both short (cat, h) and full (category_slug, harmonics) formats
  const normalized = raw.map((r: any) => ({
    id: r.id,
    cat: r.cat ?? r.category_slug ?? r.category,
    h: r.h ?? r.harmonic_profile ?? r.harmonics,
  }))

  console.log(`[classify] ${atoms.length} atoms by ${result.provider}/${result.model} (${result.durationMs}ms)`)

  // Validate against DB-sourced category set
  return normalized
    .filter(r => validSlugs.has(r.cat))
    .map(r => ({
      atom_id: r.id,
      text: atoms.find(a => a.id === r.id)?.text_lower || '',
      category_slug: r.cat,
      harmonics: {
        hardness: clampScore(r.h?.hardness),
        temperature: clampScore(r.h?.temperature),
        weight: clampScore(r.h?.weight),
        formality: clampScore(r.h?.formality),
        era_affinity: clampScore(r.h?.era_affinity),
      }
    }))
}

async function writeResults(
  results: ClassificationResult[],
  db: D1Database
): Promise<number> {
  let written = 0
  // D1 batch limit is 100 statements
  const chunks = []
  for (let i = 0; i < results.length; i += 50) {
    chunks.push(results.slice(i, i + 50))
  }

  for (const chunk of chunks) {
    const stmts = chunk.map(r =>
      db.prepare(
        'UPDATE atoms SET category_slug = ?, harmonics = ? WHERE id = ?'
      ).bind(r.category_slug, JSON.stringify(r.harmonics), r.atom_id)
    )
    await db.batch(stmts)
    written += chunk.length
  }
  return written
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/status') {
      const stats = await env.GRIMOIRE_DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN category_slug IS NOT NULL THEN 1 ELSE 0 END) as categorized,
          SUM(CASE WHEN harmonics != '{}' AND harmonics IS NOT NULL THEN 1 ELSE 0 END) as has_harmonics,
          SUM(CASE WHEN category_slug IS NULL THEN 1 ELSE 0 END) as uncategorized
        FROM atoms
      `).first()

      const byCollection = await env.GRIMOIRE_DB.prepare(`
        SELECT collection_slug, COUNT(*) as cnt
        FROM atoms WHERE category_slug IS NULL
        GROUP BY collection_slug ORDER BY cnt DESC
      `).all()

      return Response.json({ stats, uncategorized_by_collection: byCollection.results })
    }

    if (url.pathname === '/classify' && request.method === 'POST') {
      const batchSize = parseInt(url.searchParams.get('batch_size') || '50')
      const collection = url.searchParams.get('collection')
      const dryRun = url.searchParams.get('dry_run') === 'true'

      // Fetch categories from DB at runtime
      const categories = await getCategoryMetadata(env.GRIMOIRE_DB)

      // Pull uncategorized atoms
      let query = 'SELECT id, text_lower, collection_slug FROM atoms WHERE category_slug IS NULL'
      const params: string[] = []
      if (collection) {
        query += ' AND collection_slug = ?'
        params.push(collection)
      }
      query += ` LIMIT ${Math.min(batchSize, 100)}`

      const stmt = collection
        ? env.GRIMOIRE_DB.prepare(query).bind(collection)
        : env.GRIMOIRE_DB.prepare(query)

      const { results: atoms } = await stmt.all<AtomRow>()

      if (!atoms || atoms.length === 0) {
        return Response.json({ message: 'No uncategorized atoms found', collection })
      }

      // Classify with AI (categories from DB)
      const classified = await classifyBatch(atoms, env, categories)

      if (dryRun) {
        return Response.json({
          dry_run: true,
          input_count: atoms.length,
          classified_count: classified.length,
          categories_available: categories.length,
          sample: classified.slice(0, 10),
          dropped: atoms.length - classified.length
        })
      }

      // Write to D1
      const written = await writeResults(classified, env.GRIMOIRE_DB)

      return Response.json({
        input_count: atoms.length,
        classified_count: classified.length,
        written_count: written,
        dropped: atoms.length - classified.length,
        sample: classified.slice(0, 5)
      })
    }

    // Harmonics-only pass for already-categorized atoms
    if (url.pathname === '/harmonize' && request.method === 'POST') {
      const batchSize = parseInt(url.searchParams.get('batch_size') || '50')

      // Fetch categories from DB at runtime
      const categories = await getCategoryMetadata(env.GRIMOIRE_DB)

      const { results: atoms } = await env.GRIMOIRE_DB.prepare(`
        SELECT id, text_lower, collection_slug FROM atoms
        WHERE category_slug IS NOT NULL AND (harmonics = '{}' OR harmonics IS NULL)
        LIMIT ?
      `).bind(Math.min(batchSize, 100)).all<AtomRow>()

      if (!atoms || atoms.length === 0) {
        return Response.json({ message: 'All categorized atoms have harmonics' })
      }

      const classified = await classifyBatch(atoms, env, categories)

      // Only update harmonics, keep existing category_slug
      const stmts = classified.map(r =>
        env.GRIMOIRE_DB.prepare(
          'UPDATE atoms SET harmonics = ? WHERE id = ?'
        ).bind(JSON.stringify(r.harmonics), r.atom_id)
      )

      // Batch in chunks of 50
      for (let i = 0; i < stmts.length; i += 50) {
        await env.GRIMOIRE_DB.batch(stmts.slice(i, i + 50))
      }

      return Response.json({
        input_count: atoms.length,
        harmonized_count: classified.length,
        sample: classified.slice(0, 5)
      })
    }

    return Response.json({
      endpoints: {
        'GET /status': 'Classification progress',
        'POST /classify?batch_size=50&collection=style': 'Classify uncategorized atoms',
        'POST /classify?batch_size=50&dry_run=true': 'Preview without writing',
        'POST /harmonize?batch_size=50': 'Add harmonics to already-categorized atoms',
      }
    })
  }
}
