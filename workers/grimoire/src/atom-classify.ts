import { VALID_CATEGORIES, VALID_HARMONICS, HARMONIC_DEFAULTS, VALID_MODALITIES, CATEGORY_MODALITY } from './constants'

const GEMINI_URL_LITE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'
const GEMINI_URL_FULL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

export const CLASSIFICATION_PROMPT = `You are classifying atoms for an AI creative system called the Grimoire. Atoms serve two purposes: visual image generation and narrative world-building. Your job is to assign each atom:

1. A category_slug from the valid list below
2. A modality: "visual", "narrative", or "both"
3. A harmonic profile with exactly 5 dimensions

VALID CATEGORIES:

VISUAL CATEGORIES (modality = "visual"):
- camera.lens: Focal length, depth of field, distortion, bokeh. Technical camera properties.
- camera.shot: Camera framing and angle. Close-up, medium, wide, bird-eye, worm-eye.
- color.palette: Color terms, hex values, color harmony, tint, saturation, hue references.
- composition.rule: Compositional principles and framing rules. Rule of thirds, leading lines, negative space, symmetry. NOT general adjectives.
- covering.accessory: Jewelry, belts, watches, cuffs, bracelets, earrings. Removable body accessories.
- covering.clothing: Garments worn on the body. Dresses, suits, shirts, pants, robes, armor.
- covering.footwear: Shoes, boots, sandals, stockings, legwear.
- covering.headwear: Hats, helmets, crowns, tiaras, headbands, veils, hoods.
- covering.material: Fabrics, textures, surface treatments on clothing. Leather, silk, lace, velvet, denim. Also prints/patterns. NOT architectural features.
- covering.outfit: Complete themed ensembles. Cottagecore, steampunk, gothic. Coordinated looks.
- effect.post: Post-processing and optical effects. Film grain, chromatic aberration, bloom, vignette, lens flare, color grading.
- lighting.source: Where light comes from and its quality. Key light, fill, rim, neon, candles.
- negative.filter: Terms to STRIP from prompts. Interpretation words (young, happy, mysterious), mood words, abstract nouns with no visual or narrative value.
- object.drink: Beverage vessels and components. Glass type, liquid, garnish, ice.
- object.held: Things the subject holds. Weapons, drinks, tools, cigarettes.
- pose.interaction: How subject physically interacts with objects or self. Holding, gripping, touching.
- pose.position: Body arrangement and posture. Standing, sitting, kneeling, leaning. NOT abstract nouns like "structure" or "transition".
- style.medium: Rendering approach. Photography, oil painting, watercolor, 3D render.
- subject.expression: Facial muscle positions and eye state ONLY. Physical configuration of the face: smiling, frowning, squinting, wide-eyed, pursed lips, raised eyebrows. NOT general beauty adjectives (those go to narrative.mood). NOT aesthetic quality words like elegant, glamorous, attractive.
- subject.face: Specific facial features. Eye color, skin texture, cosmetics.
- subject.feature: Distinguishing marks. Tattoos, scars, piercings, bioluminescence.
- subject.form: What the subject IS structurally. Figure type, body proportions.
- subject.hair: Hair style, length, texture, color. Includes facial hair.

NARRATIVE CATEGORIES (modality = "narrative"):
- domain.academia: Academic and scholarly vocabulary. Thesis, curriculum, tenure, dissertation, pedagogy.
- domain.athletics: Sports and physical competition terms. Sprint, parry, bout, endurance, relay.
- domain.aviation: Aviation and flight vocabulary. Aileron, fuselage, turbulence, hangar, sortie.
- domain.chemistry: Chemical and alchemical vocabulary. Reagent, catalyst, distillation, precipitate, compound.
- domain.cuisine: Culinary and food vocabulary. Braise, julienne, reduction, umami, mise en place.
- domain.folklore: Myth, legend, and folk tradition vocabulary. Trickster, changeling, omen, ward, pact.
- domain.law: Legal and judicial vocabulary. Precedent, arraignment, statute, testimony, clemency.
- domain.maritime: Nautical and ocean vocabulary. Starboard, bilge, keel, rigging, squall.
- domain.medicine: Medical and anatomical vocabulary. Triage, suture, prognosis, auscultation, lesion.
- domain.military: Military and strategic vocabulary. Flank, sortie, garrison, conscript, siege.
- domain.occult: Occult, mystical, and esoteric vocabulary. Sigil, incantation, familiar, scrying, grimoire.
- domain.technology: Technical and digital vocabulary. Algorithm, bandwidth, encryption, protocol, firmware.
- narrative.archetype: Character archetypes and roles. Detective, merchant, exile, oracle, sentinel, herald.
- narrative.concept: Abstract narrative concepts and themes. Betrayal, ambition, isolation, dread, redemption, hubris.
- narrative.action: Verbs driving narrative momentum. Pursue, negotiate, unravel, bargain, confront, deceive.
- narrative.phrase: Compressed atmospheric descriptions. Multi-word phrases that set narrative tone but are too long to be single visual atoms.

DUAL-MODE CATEGORIES (modality = "both"):
- environment.atmosphere: Physical atmospheric conditions. Smoke, fog, rain, dust, particles, mist. NOT adjectives describing general mood or quality.
- environment.natural: Natural features and phenomena. Mountains, rivers, forests, weather, seasons, geological formations.
- environment.prop: Objects in scene NOT worn or held. Furniture, vehicles, architectural elements like columns, arches, doorways.
- environment.setting: Where the scene takes place. Locations, venues, landscapes. NOT architectural styles (those are style.genre).
- narrative.mood: Deliberate atmospheric intent as a compositional directive. Also includes general aesthetic quality descriptors: beautiful, elegant, glamorous, alluring, exquisite, etc.
- narrative.scene: Scene descriptions combining multiple visual elements into a compositional concept. Phrases describing a moment or spatial relationship.
- reference.character: Fictional characters with known visual designs. Names paired with visual descriptions.
- reference.film: Film titles, director names, cinematographer names. Cultural and cinematic source references.
- reference.game: Game systems, mechanics, settings, item types.
- reference.location: Named places, heritage sites, landmarks, architectural locations.
- reference.person: Real people. Photographers, artists, directors, cinematographers. Names serving as style references.
- reference.technique: Cinematographic and photographic techniques. Rack focus, chiaroscuro, cross-processing, long exposure.
- style.era: Time period context. 1920s, Victorian, Medieval, Futuristic. Also historical periods used as style references.
- style.genre: Aesthetic category AND architectural styles. Noir, cyberpunk, steampunk, art deco, gothic. ALL named architectural styles go here.
- subject.animal: Animals, birds, insects, marine life. Physical description and species identification.

MODALITY RULES:
- "visual": The term contributes to generating an image. It describes something you can see, render, or photograph.
- "narrative": The term contributes to storytelling, world-building, or domain-specific vocabulary. It has no direct visual rendering.
- "both": The term works in both contexts. It has visual presence AND narrative/world-building value.
- The category groupings above indicate the default modality, but override if the specific atom clearly belongs to a different modality.

CRITICAL CLASSIFICATION RULES:
1. ALL architectural styles -> style.genre. This includes: baroque, gothic, renaissance, rococo, tudor, colonial, victorian, art deco, brutalist, neoclassical, moorish, prairie, mission, queen-anne, edwardian, georgian, palladian, and ALL regional architecture.
2. General beauty/quality adjectives -> narrative.mood. Words like: adorable, alluring, attractive, beautiful, charming, cute, elegant, glamorous, gorgeous, stunning, etc.
3. subject.expression is ONLY for physical facial configurations: smiling, frowning, grimacing, squinting, winking, sneering, pouting. If you cannot act it out with your face muscles, it is NOT an expression.
4. Single abstract words that don't describe anything visually specific AND have no narrative value (structure, transition, resemble, effusive, diminutive) -> negative.filter.
5. Japanese architectural elements (engawa, fusuma, genkan, shoji, tatami) -> environment.prop.
6. Historical periods used as style context (Meiji period, Showa period, Renaissance, Baroque era) -> style.era.
7. Domain vocabulary: if a term belongs to a specialized field (medicine, law, military, etc.), classify it under the matching domain.* category even if it has loose visual associations.
8. Specific camera models, lenses, and photography equipment (Canon EOS, Fujifilm FinePix, Nikon D-series, Leica M, Hasselblad, Vivitar, Casio Exilim, etc.) -> reference.technique. Modality: visual. These inform rendering style via sensor characteristics and lens rendering.

HARMONIC DIMENSIONS (assign exactly one value per dimension):
- hardness: "hard" (rigid, angular, sharp edges, stiff, armor-like, geometric) | "soft" (flowing, draped, rounded, gentle, yielding, plush) | "neutral" (RARE: only when truly ambiguous)
- temperature: "warm" (reds, oranges, golden, amber, fire, candlelight, earth tones, copper, brass) | "cool" (blues, greens, silver, ice, steel, chrome, moonlight, slate) | "neutral" (RARE: only for colorless or truly achromatic terms)
- weight: "heavy" (dense, thick, substantial, layered, grounded, massive, opaque) | "light" (thin, sheer, delicate, ethereal, airy, transparent, minimal) | "neutral" (RARE: only when visual mass is truly indeterminate)
- formality: "structured" (geometric, precise, manufactured, tailored, engineered, symmetrical) | "organic" (natural, irregular, weathered, grown, handmade, asymmetrical) | "neutral" (RARE: only when neither applies)
- era_affinity: "archaic" (ancient, medieval, mythological, primitive, pre-industrial) | "industrial" (1880s-1960s, machine age, art deco, noir, riveted, welded) | "modern" (contemporary, digital, futuristic, synthetic, neon) | "timeless" (genuinely era-independent basics like "sleeve" or "button")

CRITICAL: "neutral" and "timeless" are NOT defaults. They are rare exceptions for genuinely ambiguous atoms. Most terms carry bias.

EXAMPLES:
- "gothic architecture" -> style.genre, mod: both
- "renaissance architecture" -> style.genre, mod: both
- "elegant" -> narrative.mood, mod: both
- "smiling" -> subject.expression, mod: visual
- "engawa" -> environment.prop, mod: both
- "tatami" -> environment.prop, mod: both
- "Meiji period" -> style.era, mod: both
- "structure" -> negative.filter, mod: visual
- "rain-slicked highway reflecting sodium vapor lights" -> narrative.scene, mod: both
- "great crested grebe" -> subject.animal, mod: both
- "Roger Deakins" -> reference.person, mod: both
- "reagent" -> domain.chemistry, mod: narrative
- "triage" -> domain.medicine, mod: narrative
- "starboard" -> domain.maritime, mod: narrative
- "betrayal" -> narrative.concept, mod: narrative
- "pursue" -> narrative.action, mod: narrative
- "the detective" -> narrative.archetype, mod: narrative
- "fog creeping through broken stained glass" -> narrative.phrase, mod: narrative
- "sigil" -> domain.occult, mod: narrative
- "julienne" -> domain.cuisine, mod: narrative

Think about what creative domain this term lives in. Commit to its tendency even if weak.`

export interface AtomClassification {
  category_slug: string
  modality: string
  harmonics: Record<string, string>
}

/**
 * Sanitize Gemini JSON responses that contain control characters
 * inside string literals. Gemini sporadically inserts literal
 * newlines/tabs inside JSON string values, breaking JSON.parse.
 * Also strips markdown fences and repairs truncated objects.
 */
function sanitizeGeminiJson(raw: string): string {
  let cleaned = raw.trim()

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  // Extract JSON object if Gemini wrapped it in text explanation
  // e.g. "Here is the classification:\n{...}"
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    }
  }

  // Repair truncation: if response doesn't end with }, find last complete object
  if (!cleaned.trimEnd().endsWith('}')) {
    const lastBrace = cleaned.lastIndexOf('}')
    if (lastBrace > 0) {
      console.log(`[classify] Truncated response detected, repairing at position ${lastBrace}`)
      cleaned = cleaned.slice(0, lastBrace + 1)
    }
  }

  // Remove control characters inside string literals
  let inString = false
  let escaped = false
  let result = ''

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]
    const code = cleaned.charCodeAt(i)

    if (escaped) {
      result += char
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      result += char
      continue
    }

    if (char === '"') {
      inString = !inString
      result += char
      continue
    }

    if (inString && code < 0x20) {
      // Control character inside a string literal: replace with space
      result += ' '
      continue
    }

    result += char
  }

  return result
}

/**
 * Fetch raw text from a Gemini model. Returns the text string or null.
 */
async function fetchGeminiText(
  prompt: string,
  apiKey: string,
  url: string
): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 256,
        },
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    console.log(`[classify] Gemini HTTP ${response.status}: ${await response.text().catch(() => 'no body')}`)
    return null
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    console.log(`[classify] Empty Gemini response: ${JSON.stringify(data).slice(0, 300)}`)
  }
  return text ?? null
}

/**
 * Call a specific Gemini model to classify an atom.
 * Returns null on any failure (network, parse, validation). Never throws.
 */
async function classifyWithModel(
  text_lower: string,
  apiKey: string,
  url: string
): Promise<AtomClassification | null> {
  try {
    const prompt = CLASSIFICATION_PROMPT + `

Classify this single atom:
- text: "${text_lower}"

Respond with ONLY a JSON object (not array):
{"cat":"category_slug","mod":"visual|narrative|both","h":{"hardness":"...","temperature":"...","weight":"...","formality":"...","era_affinity":"..."}}`

    const raw = await fetchGeminiText(prompt, apiKey, url)
    if (!raw) {
      console.log(`[classify] No response from Gemini for "${text_lower.slice(0, 40)}"`)
      return null
    }

    // Sanitize + parse, with one retry on failure
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(sanitizeGeminiJson(raw))
    } catch (e) {
      console.log(`[classify] JSON parse failed for "${text_lower.slice(0, 40)}": ${e instanceof Error ? e.message : e} | raw: ${raw.slice(0, 200)}`)
      const retryRaw = await fetchGeminiText(prompt, apiKey, url)
      if (!retryRaw) return null
      parsed = JSON.parse(sanitizeGeminiJson(retryRaw))
    }

    // Validate category
    if (!parsed.cat || !(VALID_CATEGORIES as readonly string[]).includes(parsed.cat as string)) return null

    // Validate modality: use Gemini's response, fall back to CATEGORY_MODALITY map, then 'visual'
    let modality = 'visual'
    if (parsed.mod && (VALID_MODALITIES as readonly string[]).includes(parsed.mod as string)) {
      modality = parsed.mod as string
    } else if ((parsed.cat as string) in CATEGORY_MODALITY) {
      modality = CATEGORY_MODALITY[parsed.cat as string]
    }

    // Validate and normalize harmonics
    const h = parsed.h as Record<string, unknown> | undefined
    if (!h || typeof h !== 'object') return null

    const harmonics: Record<string, string> = {}
    for (const [dim, validValues] of Object.entries(VALID_HARMONICS)) {
      const val = h[dim]
      if (typeof val === 'string' && (validValues as readonly string[]).includes(val)) {
        harmonics[dim] = val
      } else {
        harmonics[dim] = HARMONIC_DEFAULTS[dim]
      }
    }

    return {
      category_slug: parsed.cat as string,
      modality,
      harmonics,
    }
  } catch {
    return null
  }
}

/**
 * Classify a single atom. Tries flash-lite first, falls back to full flash.
 */
export async function classifyAtom(
  text_lower: string,
  apiKey: string
): Promise<AtomClassification | null> {
  const result = await classifyWithModel(text_lower, apiKey, GEMINI_URL_LITE)
  if (result) return result
  return classifyWithModel(text_lower, apiKey, GEMINI_URL_FULL)
}

// ── Register Dimension Classification ─────────────────

const REGISTER_PROMPT = `You are scoring a creative vocabulary atom on the "register" dimension: a continuous scale from ethereal (0.0) to visceral (1.0).

SCALE ANCHORS:
- 0.0-0.2 ETHEREAL: angelic wings, celestial glow, ethereal mist, gossamer, divine light, spectral shimmer
- 0.2-0.4 DELICATE: soft focus, dreamy, pastel haze, morning dew, whisper, translucent
- 0.4-0.6 NEUTRAL: most technical/equipment atoms, generic poses, standard lighting setups, compositional rules
- 0.6-0.8 GROUNDED: weathered leather, rust, concrete, gritty, industrial steel, calloused hands, worn denim
- 0.8-1.0 VISCERAL: human skull, viscera, raw meat, decay, exposed bone, blood, putrefaction, carrion

RULES:
1. Score based on the sensory/physical intensity the term evokes, not its literal meaning.
2. Abstract or technical terms with no ethereal/visceral lean score 0.5.
3. Camera gear, lens names, composition rules: score 0.5.
4. Natural elements score based on their feel: "morning mist" ~0.2, "mudslide" ~0.7.
5. Clothing/materials: "silk chiffon" ~0.25, "cracked leather" ~0.7.
6. Domain vocabulary: score based on the visceral weight of the domain (medicine ~0.65, folklore ~0.35, military ~0.7).

Return ONLY a JSON object: {"register": <float 0.0-1.0>}`

export type RegisterResult = { register: number } | { error: string }

/**
 * Classify a single atom's register dimension.
 * Returns { register: float } on success, { error: string } on failure.
 */
export async function classifyRegister(
  text_lower: string,
  category_slug: string,
  apiKey: string
): Promise<RegisterResult> {
  try {
    const prompt = REGISTER_PROMPT + `

Atom: "${text_lower}"
Category: ${category_slug}`

    // Use flash-lite: simpler task than 52-category classification, and
    // gemini-2.5-flash thinking tokens eat maxOutputTokens budget causing truncation
    const raw = await fetchGeminiText(prompt, apiKey, GEMINI_URL_LITE)
    if (!raw) return { error: 'gemini_empty' }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(sanitizeGeminiJson(raw))
    } catch {
      // One retry with full flash as fallback
      const retryRaw = await fetchGeminiText(prompt, apiKey, GEMINI_URL_FULL)
      if (!retryRaw) return { error: 'gemini_retry_empty' }
      try {
        parsed = JSON.parse(sanitizeGeminiJson(retryRaw))
      } catch {
        return { error: 'parse_failed' }
      }
    }

    const val = Number(parsed.register)
    if (isNaN(val)) return { error: 'nan_value' }

    // Clamp to [0.0, 1.0]
    return { register: Math.max(0.0, Math.min(1.0, Math.round(val * 100) / 100)) }
  } catch (e) {
    return { error: `exception: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── Batch Classification ─────────────────

/**
 * Classify a batch of unclassified atoms. Fetches atoms with NULL or empty
 * category_slug, classifies in concurrent pairs with 1s delay between chunks.
 * Used by both the cron handler and the /admin/classify-batch REST endpoint.
 */
export async function classifyBatchProcess(
  db: D1Database,
  apiKey: string,
  opts: { limit: number }
): Promise<{ classified: number; failed: number; geminiCalls: number }> {
  const { results } = await db.prepare(
    "SELECT id, text_lower, collection_slug FROM atoms WHERE (category_slug IS NULL OR category_slug = '') LIMIT ?"
  ).bind(opts.limit).all()

  if (results.length === 0) return { classified: 0, failed: 0, geminiCalls: 0 }

  let classified = 0
  let failed = 0
  let geminiCalls = 0

  for (let i = 0; i < results.length; i += 2) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000))
    const chunk = results.slice(i, i + 2)
    geminiCalls += chunk.length * 2

    const settled = await Promise.allSettled(
      chunk.map(async (atom) => {
        const classification = await classifyAtom(atom.text_lower as string, apiKey)
        if (!classification) return false
        await db.prepare(
          'UPDATE atoms SET category_slug = ?, harmonics = ?, modality = ? WHERE id = ?'
        ).bind(classification.category_slug, JSON.stringify(classification.harmonics), classification.modality, atom.id).run()
        return true
      })
    )

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) classified++
      else failed++
    }
  }

  return { classified, failed, geminiCalls }
}
