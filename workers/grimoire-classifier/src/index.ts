/**
 * Grimoire Batch Classifier
 * 
 * Assigns category_slug and harmonics to uncategorized atoms via Gemini.
 * Run as: POST /classify?batch_size=50&collection=style
 * Or run all: POST /classify?batch_size=50
 * 
 * Designed for manual triggering, not cron. Run it, watch the logs,
 * iterate on prompt if classification quality needs tuning.
 */

interface Env {
  GRIMOIRE_DB: D1Database
  AI_GATEWAY_URL: string  // gateway.ai.cloudflare.com/v1/{account}/hobfarm
  GEMINI_API_KEY: string
}

// The five cymatics dimensions
type Hardness = 'hard' | 'soft' | 'neutral'
type Temperature = 'warm' | 'cool' | 'neutral'
type Weight = 'heavy' | 'light' | 'neutral'
type Formality = 'structured' | 'organic' | 'neutral'
type EraAffinity = 'archaic' | 'industrial' | 'modern' | 'timeless'

interface HarmonicProfile {
  hardness: Hardness
  temperature: Temperature
  weight: Weight
  formality: Formality
  era_affinity: EraAffinity
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

// Valid category slugs for Gemini to choose from
const VALID_CATEGORIES = [
  'camera.lens', 'camera.shot', 'color.palette',
  'covering.accessory', 'covering.clothing', 'covering.footwear',
  'covering.headwear', 'covering.material', 'covering.outfit',
  'environment.atmosphere', 'environment.prop', 'environment.setting',
  'lighting.source', 'negative.filter',
  'object.drink', 'object.held',
  'pose.interaction', 'pose.position',
  'style.era', 'style.genre', 'style.medium',
  'subject.expression', 'subject.face', 'subject.feature',
  'subject.form', 'subject.hair'
]

const CLASSIFICATION_PROMPT = `You are classifying visual prompt atoms for an AI image generation system called the Grimoire.

Each atom is a short text term (1-5 words) that describes a visual element used in image composition prompts. Your job is to assign each atom:

1. A category_slug from the valid list below
2. A harmonic profile with exactly 5 dimensions

VALID CATEGORIES:
${VALID_CATEGORIES.map(c => `- ${c}`).join('\n')}

Category descriptions:
- camera.lens: Focal length, depth of field, distortion, bokeh. Technical camera properties.
- camera.shot: Camera framing and angle. Close-up, medium, wide, bird-eye, worm-eye.
- color.palette: Color terms, hex values, color harmony, tint, saturation, hue references.
- covering.accessory: Jewelry, belts, watches, cuffs, bracelets, earrings. Removable body accessories.
- covering.clothing: Garments worn on the body. Dresses, suits, shirts, pants, robes, armor.
- covering.footwear: Shoes, boots, sandals, stockings, legwear.
- covering.headwear: Hats, helmets, crowns, tiaras, headbands, veils, hoods.
- covering.material: Fabrics, textures, surface treatments on clothing. Leather, silk, lace, velvet, denim. Also prints/patterns.
- covering.outfit: Complete themed ensembles. Cottagecore, steampunk, gothic. Coordinated looks.
- environment.atmosphere: Physical atmospheric conditions ONLY. Smoke, fog, rain, dust, particles, mist.
- environment.prop: Objects in scene NOT worn or held. Furniture, vehicles, architectural elements.
- environment.setting: Where the scene takes place. Locations, venues, landscapes.
- lighting.source: Where light comes from and its quality. Key light, fill, rim, neon, candles.
- negative.filter: Terms to STRIP from prompts. Interpretation words (young, happy, mysterious), mood words.
- object.drink: Beverage vessels and components. Glass type, liquid, garnish, ice.
- object.held: Things the subject holds. Weapons, drinks, tools, cigarettes.
- pose.interaction: How subject physically interacts with objects or self. Holding, gripping, touching.
- pose.position: Body arrangement and posture. Standing, sitting, kneeling, leaning.
- style.era: Time period context. 1920s, Victorian, Medieval, Futuristic.
- style.genre: Aesthetic category. Noir, cyberpunk, steampunk, art deco, gothic.
- style.medium: Rendering approach. Photography, oil painting, watercolor, 3D render.
- subject.expression: Facial muscle positions and eye state. Physical configuration, NOT mood.
- subject.face: Specific facial features. Eye color, skin texture, cosmetics.
- subject.feature: Distinguishing marks. Tattoos, scars, piercings, bioluminescence.
- subject.form: What the subject IS structurally. Figure type, body proportions.
- subject.hair: Hair style, length, texture, color. Includes facial hair.

HARMONIC DIMENSIONS (assign exactly one value per dimension):
- hardness: "hard" (rigid, angular, sharp edges, stiff, armor-like, geometric) | "soft" (flowing, draped, rounded, gentle, yielding, plush) | "neutral" (RARE: only when truly ambiguous)
- temperature: "warm" (reds, oranges, golden, amber, fire, candlelight, earth tones, copper, brass) | "cool" (blues, greens, silver, ice, steel, chrome, moonlight, slate) | "neutral" (RARE: only for colorless or truly achromatic terms)
- weight: "heavy" (dense, thick, substantial, layered, grounded, massive, opaque) | "light" (thin, sheer, delicate, ethereal, airy, transparent, minimal) | "neutral" (RARE: only when visual mass is truly indeterminate)
- formality: "structured" (geometric, precise, manufactured, tailored, engineered, symmetrical) | "organic" (natural, irregular, weathered, grown, handmade, asymmetrical) | "neutral" (RARE: only when neither applies)
- era_affinity: "archaic" (ancient, medieval, mythological, primitive, pre-industrial) | "industrial" (1880s-1960s, machine age, art deco, noir, riveted, welded) | "modern" (contemporary, digital, futuristic, synthetic, neon) | "timeless" (genuinely era-independent basics like "sleeve" or "button")

CRITICAL: "neutral" and "timeless" are NOT defaults. They are rare exceptions for genuinely ambiguous atoms. Most visual terms carry bias. Examples:
- "long sleeves" -> formality:structured (constructed garment), weight:neutral, era_affinity:timeless
- "fingerless design" -> formality:structured (deliberate cutaway), era_affinity:modern (punk/tactical association)
- "black fabric" -> temperature:cool (black reads cool), weight:heavy (dark = visual weight)
- "loose cloak" -> formality:organic (draping), weight:heavy (full coverage), era_affinity:archaic
- "neon glow" -> temperature:cool, hardness:hard (sharp light edges), era_affinity:modern
- "leather" -> hardness:hard, temperature:warm (earth material), formality:structured, era_affinity:industrial
- "lace" -> hardness:soft, weight:light, formality:organic (handcraft pattern)

Think about what this term LOOKS LIKE in an image. Commit to its visual tendency even if weak. A slight lean is better than neutral.

The atom's current collection provides context but may be wrong (that is why we are reclassifying).

Respond with ONLY a JSON array. No markdown, no explanation. Each element:
{"id":"atom_id","cat":"category_slug","h":{"hardness":"...","temperature":"...","weight":"...","formality":"...","era_affinity":"..."}}
`

async function classifyBatch(
  atoms: AtomRow[],
  env: Env
): Promise<ClassificationResult[]> {
  const atomList = atoms.map(a => 
    `- id:${a.id} text:"${a.text_lower}" collection:${a.collection_slug}`
  ).join('\n')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: CLASSIFICATION_PROMPT + '\n\nATOMS TO CLASSIFY:\n' + atomList
          }]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192,
        }
      })
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${err}`)
  }

  const data = await response.json() as any
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty Gemini response')

  const parsed: Array<{id: string, cat: string, h: HarmonicProfile}> = JSON.parse(text)

  // Validate and transform
  return parsed
    .filter(r => VALID_CATEGORIES.includes(r.cat))
    .map(r => ({
      atom_id: r.id,
      text: atoms.find(a => a.id === r.id)?.text_lower || '',
      category_slug: r.cat,
      harmonics: {
        hardness: (['hard','soft','neutral'].includes(r.h.hardness) ? r.h.hardness : 'neutral') as Hardness,
        temperature: (['warm','cool','neutral'].includes(r.h.temperature) ? r.h.temperature : 'neutral') as Temperature,
        weight: (['heavy','light','neutral'].includes(r.h.weight) ? r.h.weight : 'neutral') as Weight,
        formality: (['structured','organic','neutral'].includes(r.h.formality) ? r.h.formality : 'neutral') as Formality,
        era_affinity: (['archaic','industrial','modern','timeless'].includes(r.h.era_affinity) ? r.h.era_affinity : 'timeless') as EraAffinity,
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

      // Classify with Gemini
      const classified = await classifyBatch(atoms, env)

      if (dryRun) {
        return Response.json({
          dry_run: true,
          input_count: atoms.length,
          classified_count: classified.length,
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
      
      const { results: atoms } = await env.GRIMOIRE_DB.prepare(`
        SELECT id, text_lower, collection_slug FROM atoms 
        WHERE category_slug IS NOT NULL AND (harmonics = '{}' OR harmonics IS NULL)
        LIMIT ?
      `).bind(Math.min(batchSize, 100)).all<AtomRow>()

      if (!atoms || atoms.length === 0) {
        return Response.json({ message: 'All categorized atoms have harmonics' })
      }

      const classified = await classifyBatch(atoms, env)
      
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
