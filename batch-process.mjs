#!/usr/bin/env node
// batch-process.mjs - Local batch processing for Grimoire atoms
// Usage: node batch-process.mjs [classify|enrich] [--batch-size 25] [--limit 0] [--delay 2000] [--dry-run]
// Requires: GEMINI_API_KEY + CF_API_TOKEN env vars

import { writeFileSync } from 'node:fs';

// ─── Constants (from workers/grimoire/src/constants.ts) ───────────────────────

const VALID_CATEGORIES = [
  'camera.lens', 'camera.shot', 'color.palette', 'composition.rule',
  'covering.accessory', 'covering.clothing', 'covering.footwear', 'covering.headwear',
  'covering.material', 'covering.outfit',
  'domain.academia', 'domain.athletics', 'domain.aviation', 'domain.chemistry',
  'domain.cuisine', 'domain.folklore', 'domain.law', 'domain.maritime',
  'domain.medicine', 'domain.military', 'domain.occult', 'domain.technology',
  'effect.post', 'environment.atmosphere', 'environment.natural', 'environment.prop',
  'environment.setting', 'lighting.source',
  'narrative.action', 'narrative.archetype', 'narrative.concept', 'narrative.mood',
  'narrative.phrase', 'narrative.scene', 'negative.filter',
  'object.drink', 'object.held', 'pose.interaction', 'pose.position',
  'reference.character', 'reference.film', 'reference.game', 'reference.location',
  'reference.person', 'reference.technique',
  'style.era', 'style.genre', 'style.medium',
  'subject.animal', 'subject.expression', 'subject.face', 'subject.feature',
  'subject.form', 'subject.hair',
];

const VALID_HARMONICS = {
  hardness:    ['hard', 'soft', 'neutral'],
  temperature: ['warm', 'cool', 'neutral'],
  weight:      ['heavy', 'light', 'neutral'],
  formality:   ['structured', 'organic', 'neutral'],
  era_affinity: ['archaic', 'industrial', 'modern', 'timeless'],
};

const HARMONIC_DEFAULTS = {
  hardness:    'neutral',
  temperature: 'neutral',
  weight:      'neutral',
  formality:   'neutral',
  era_affinity: 'timeless',
};

const VALID_MODALITIES = ['visual', 'narrative', 'both'];

const CATEGORY_MODALITY = {
  // visual
  'camera.lens': 'visual', 'camera.shot': 'visual', 'color.palette': 'visual',
  'composition.rule': 'visual', 'covering.accessory': 'visual', 'covering.clothing': 'visual',
  'covering.footwear': 'visual', 'covering.headwear': 'visual', 'covering.material': 'visual',
  'covering.outfit': 'visual', 'effect.post': 'visual', 'lighting.source': 'visual',
  'negative.filter': 'visual', 'object.drink': 'visual', 'object.held': 'visual',
  'pose.interaction': 'visual', 'pose.position': 'visual', 'style.medium': 'visual',
  'subject.expression': 'visual', 'subject.face': 'visual', 'subject.feature': 'visual',
  'subject.form': 'visual', 'subject.hair': 'visual',
  // narrative
  'domain.academia': 'narrative', 'domain.athletics': 'narrative', 'domain.aviation': 'narrative',
  'domain.chemistry': 'narrative', 'domain.cuisine': 'narrative', 'domain.folklore': 'narrative',
  'domain.law': 'narrative', 'domain.maritime': 'narrative', 'domain.medicine': 'narrative',
  'domain.military': 'narrative', 'domain.occult': 'narrative', 'domain.technology': 'narrative',
  'narrative.action': 'narrative', 'narrative.archetype': 'narrative', 'narrative.concept': 'narrative',
  'narrative.phrase': 'narrative',
  // both
  'environment.atmosphere': 'both', 'environment.natural': 'both', 'environment.prop': 'both',
  'environment.setting': 'both', 'narrative.mood': 'both', 'narrative.scene': 'both',
  'reference.character': 'both', 'reference.film': 'both', 'reference.game': 'both',
  'reference.location': 'both', 'reference.person': 'both', 'reference.technique': 'both',
  'style.era': 'both', 'style.genre': 'both', 'subject.animal': 'both',
};

// ─── Prompts ──────────────────────────────────────────────────────────────────

// Copied verbatim from workers/grimoire/src/atom-classify.ts
const CLASSIFICATION_PROMPT = `You are classifying atoms for an AI creative system called the Grimoire. Atoms serve two purposes: visual image generation and narrative world-building. Your job is to assign each atom:

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

Think about what creative domain this term lives in. Commit to its tendency even if weak.

The atom's current collection provides context but may be wrong (that is why we are reclassifying).`;

const ENRICH_PROMPT_BASE = `You are assigning harmonic profiles to creative vocabulary atoms. Each atom already has a category. Assign exactly 5 harmonic dimensions and a modality.

HARMONIC DIMENSIONS (assign exactly one value per dimension):
- hardness: "hard" (rigid, angular, sharp, stiff, geometric) | "soft" (flowing, draped, rounded, gentle, plush) | "neutral" (RARE)
- temperature: "warm" (reds, oranges, golden, amber, fire, earth tones) | "cool" (blues, greens, silver, ice, steel, chrome) | "neutral" (RARE)
- weight: "heavy" (dense, thick, substantial, layered, massive, opaque) | "light" (thin, sheer, delicate, ethereal, airy, minimal) | "neutral" (RARE)
- formality: "structured" (geometric, precise, manufactured, tailored, symmetrical) | "organic" (natural, irregular, weathered, handmade, asymmetrical) | "neutral" (RARE)
- era_affinity: "archaic" (ancient, medieval, mythological, pre-industrial) | "industrial" (1880s-1960s, machine age, art deco, noir) | "modern" (contemporary, digital, futuristic, neon) | "timeless" (genuinely era-independent)

MODALITY: "visual" (renders in an image) | "narrative" (storytelling/world-building) | "both"

"neutral" and "timeless" are NOT defaults. They are rare exceptions. Most atoms carry clear bias.

Assign harmonics for these atoms:`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildClassifyPrompt(atoms) {
  const list = atoms
    .map((a, i) => `${i + 1}. "${a.text_lower}" (collection: ${a.collection_slug})`)
    .join('\n');
  return `${CLASSIFICATION_PROMPT}

Classify these atoms. Return a JSON array with one object per atom, in the same order:

${list}

Response format (JSON array only, no markdown):
[{"i":1,"cat":"category_slug","mod":"visual|narrative|both","h":{"hardness":"...","temperature":"...","weight":"...","formality":"...","era_affinity":"..."}},...]`;
}

function buildEnrichPrompt(atoms) {
  const list = atoms
    .map((a, i) => `${i + 1}. "${a.text_lower}" (category: ${a.category_slug})`)
    .join('\n');
  return `${ENRICH_PROMPT_BASE}

${list}

Return JSON array only, no markdown:
[{"i":1,"mod":"visual|narrative|both","h":{"hardness":"...","temperature":"...","weight":"...","formality":"...","era_affinity":"..."}},...]`;
}

// ─── Gemini API ───────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sanitize Gemini JSON responses that contain control characters
 * inside string literals. Gemini sporadically inserts literal
 * newlines/tabs inside JSON string values, breaking JSON.parse.
 * Also strips markdown fences, extracts JSON from text wrappers,
 * and fixes trailing commas.
 */
function sanitizeGeminiJson(raw) {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract JSON if wrapped in text explanation (e.g. "Here is the classification:\n[...]")
  if (!cleaned.startsWith('[') && !cleaned.startsWith('{')) {
    const firstBracket = cleaned.indexOf('[');
    const firstBrace = cleaned.indexOf('{');
    const start = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)
      ? firstBracket : firstBrace;
    if (start >= 0) {
      const closer = cleaned[start] === '[' ? ']' : '}';
      const end = cleaned.lastIndexOf(closer);
      if (end > start) {
        cleaned = cleaned.slice(start, end + 1);
      }
    }
  }

  // Fix trailing commas (common Gemini output issue)
  cleaned = cleaned.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

  // Remove control characters inside string literals
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const code = cleaned.charCodeAt(i);

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      result += char;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString && code < 0x20) {
      // Control character inside a string literal: replace with space
      result += ' ';
      continue;
    }

    result += char;
  }

  return result;
}

/**
 * Attempt to repair a truncated JSON array by finding the last
 * complete object and closing the array.
 */
function repairTruncatedArray(sanitized) {
  const trimmed = sanitized.trimEnd();
  if (trimmed.endsWith(']')) return null; // not truncated

  // Find the last closing brace that completes an object at depth 0 inside the array
  let lastCompleteObj = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 1 && ch === '}') lastCompleteObj = i;
    }
  }

  if (lastCompleteObj > 0) {
    console.log(`  [repair] Truncated array detected, salvaging up to position ${lastCompleteObj}`);
    return trimmed.slice(0, lastCompleteObj + 1) + ']';
  }

  return null;
}

/**
 * Fetch raw text from Gemini. Handles HTTP retries for 429/503/500.
 */
async function fetchGeminiRaw(prompt, apiKey, attempt = 1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  let response;
  try {
    response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 429 || response.status === 503 || response.status === 500) {
    if (attempt === 1) {
      const waitMs = response.status === 429 ? 60_000 : 30_000;
      process.stderr.write(`  Gemini ${response.status}, waiting ${waitMs / 1000}s then retrying...\n`);
      await sleep(waitMs);
      return fetchGeminiRaw(prompt, apiKey, 2);
    }
    const text = await response.text();
    throw new Error(`Gemini ${response.status} after retry: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    const finish = data.candidates?.[0]?.finishReason;
    throw new Error(`Empty Gemini response (finishReason: ${finish})`);
  }

  return raw;
}

/**
 * Call Gemini and parse the JSON response.
 * Pipeline: fetch -> sanitize -> parse -> (truncation repair) -> (retry on failure)
 */
async function callGemini(prompt, apiKey) {
  console.log(`  Calling Gemini with ${prompt.length} chars...`);

  const raw = await fetchGeminiRaw(prompt, apiKey);
  console.log('  DEBUG raw:', raw.slice(0, 200));

  const sanitized = sanitizeGeminiJson(raw);

  // Attempt 1: parse sanitized response
  try {
    return JSON.parse(sanitized);
  } catch (firstErr) {
    // Attempt 2: try truncation repair
    const repaired = repairTruncatedArray(sanitized);
    if (repaired) {
      try {
        const partial = JSON.parse(repaired);
        console.log(`  [repair] Recovered ${Array.isArray(partial) ? partial.length : '?'} items from truncated response`);
        return partial;
      } catch { /* repair didn't help */ }
    }

    // Attempt 3: retry the entire Gemini call
    console.log(`  [retry] JSON parse failed: ${firstErr.message.slice(0, 100)}, retrying Gemini call`);

    const retryRaw = await fetchGeminiRaw(prompt, apiKey);
    console.log('  DEBUG retry raw:', retryRaw.slice(0, 200));
    const retrySanitized = sanitizeGeminiJson(retryRaw);

    try {
      return JSON.parse(retrySanitized);
    } catch (retryErr) {
      // Last chance: truncation repair on retry response
      const retryRepaired = repairTruncatedArray(retrySanitized);
      if (retryRepaired) {
        try {
          const partial = JSON.parse(retryRepaired);
          console.log(`  [repair] Recovered ${Array.isArray(partial) ? partial.length : '?'} items from retry truncated response`);
          return partial;
        } catch { /* give up */ }
      }

      writeFileSync('gemini-debug.json', retryRaw);
      console.log('  Wrote raw Gemini response to gemini-debug.json');
      const pos = retryErr.message.match(/position (\d+)/)?.[1];
      if (pos) console.log('  DEBUG parse error at:', retrySanitized.slice(+pos - 50, +pos + 50));
      throw retryErr;
    }
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateHarmonics(h) {
  const harmonics = {};
  for (const [dim, validValues] of Object.entries(VALID_HARMONICS)) {
    const val = h?.[dim];
    harmonics[dim] = (typeof val === 'string' && validValues.includes(val))
      ? val
      : HARMONIC_DEFAULTS[dim];
  }
  return harmonics;
}

function validateModality(mod, categorySlug) {
  if (VALID_MODALITIES.includes(mod)) return mod;
  if (categorySlug && CATEGORY_MODALITY[categorySlug]) return CATEGORY_MODALITY[categorySlug];
  return 'visual';
}

function validateResult(item, atom, mode) {
  if (!item || typeof item !== 'object') return null;

  if (mode === 'classify') {
    const cat = item.cat;
    if (!cat || !VALID_CATEGORIES.includes(cat)) {
      process.stderr.write(`  Skip ${atom.id} ("${atom.text_lower}"): invalid category "${cat}"\n`);
      return null;
    }
    return {
      id: atom.id,
      category_slug: cat,
      harmonics: validateHarmonics(item.h),
      modality: validateModality(item.mod, cat),
    };
  } else {
    return {
      id: atom.id,
      harmonics: validateHarmonics(item.h),
      modality: validateModality(item.mod, atom.category_slug),
    };
  }
}

// ─── D1 HTTP API ──────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'e343cbfa70c5166f00d871e513ae352a';
const DATABASE_ID = '3cb1cdee-17af-477c-ab0a-5a18447948ef';
const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function queryD1(sql, cfToken) {
  const res = await fetch(D1_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors).slice(0, 300)}`);
  }

  return data.result[0].results;
}

function buildUpdateSQL(u, mode) {
  const harmonicsJson = JSON.stringify(u.harmonics).replace(/'/g, "''");
  if (mode === 'classify') {
    return `UPDATE atoms SET category_slug='${u.category_slug}', harmonics='${harmonicsJson}', modality='${u.modality}', updated_at=datetime('now') WHERE id='${u.id}'`;
  }
  return `UPDATE atoms SET harmonics='${harmonicsJson}', modality='${u.modality}', updated_at=datetime('now') WHERE id='${u.id}'`;
}

async function writeResults(updates, mode, dryRun, cfToken) {
  if (updates.length === 0) return 0;

  if (dryRun) {
    console.log(`  [dry-run] Would write ${updates.length} updates. Sample:`);
    console.log(' ', buildUpdateSQL(updates[0], mode));
    return 0;
  }

  let writeFailed = 0;

  for (const u of updates) {
    const sql = buildUpdateSQL(u, mode);
    let success = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(D1_API, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql }),
        });

        const text = await res.text();

        if (res.ok) {
          const data = JSON.parse(text);
          if (data.success) { success = true; break; }
        }

        // Permanent failure (4xx): give up immediately
        if (res.status < 500) break;

        // Transient (5xx): retry
        console.warn(`\n  D1 write ${u.id} attempt ${attempt}/3 failed: ${res.status} ${text.slice(0, 100)}`);
      } catch (err) {
        console.warn(`\n  D1 write ${u.id} attempt ${attempt}/3 error: ${err.message.slice(0, 100)}`);
      }

      if (attempt < 3) await sleep(attempt * 2000);
    }

    if (!success) {
      console.error(`\n  D1 write FAILED for ${u.id} after 3 attempts - skipping`);
      writeFailed++;
    }
  }

  return writeFailed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (mode !== 'classify' && mode !== 'enrich') {
    console.error('Usage: node batch-process.mjs [classify|enrich] [--batch-size 25] [--limit 0] [--delay 2000] [--dry-run]');
    process.exit(1);
  }

  const opts = { mode, batchSize: 25, limit: 0, delay: 2000, dryRun: false };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--batch-size') opts.batchSize = parseInt(args[++i], 10);
    else if (args[i] === '--limit')   opts.limit     = parseInt(args[++i], 10);
    else if (args[i] === '--delay')   opts.delay     = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') opts.dryRun    = true;
  }

  return opts;
}

function buildQuery(mode) {
  if (mode === 'classify') {
    return `SELECT id, text_lower, collection_slug FROM atoms WHERE category_slug IS NULL AND status != 'rejected' ORDER BY collection_slug, id LIMIT 500`;
  }
  return `SELECT id, text_lower, collection_slug, category_slug FROM atoms WHERE category_slug IS NOT NULL AND (harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2) AND status != 'rejected' ORDER BY category_slug, id LIMIT 500`;
}

function elapsed(startMs) {
  const sec = (Date.now() - startMs) / 1000;
  return sec < 60 ? `${sec.toFixed(1)}s` : `${(sec / 60).toFixed(1)}m`;
}

async function main() {
  const { mode, batchSize, limit, delay, dryRun } = parseArgs();

  const geminiKey = process.env.GEMINI_API_KEY;
  const cfToken = process.env.CF_API_TOKEN;

  if (!geminiKey) {
    console.error('Error: GEMINI_API_KEY not set');
    console.error('  PowerShell: $env:GEMINI_API_KEY = "your-key"');
    process.exit(1);
  }
  if (!cfToken) {
    console.error('Error: CF_API_TOKEN not set');
    console.error('  PowerShell: $env:CF_API_TOKEN = "your-token"');
    console.error('  Generate at: dash.cloudflare.com/profile/api-tokens (D1 edit permissions)');
    process.exit(1);
  }

  const label = `[${mode}]`;
  const startMs = Date.now();
  let totalProcessed = 0;
  let totalFailed = 0;
  let readRound = 0;
  const query = buildQuery(mode);

  console.log(`${label} Starting${dryRun ? ' (dry-run)' : ''}  batch-size=${batchSize}  limit=${limit || 'all'}  delay=${delay}ms`);

  while (true) {
    readRound++;
    process.stdout.write(`\n${label} Reading round ${readRound} from D1...`);

    let atoms;
    try {
      atoms = await queryD1(query, cfToken);
    } catch (err) {
      console.error(`\n${label} D1 read failed: ${err.message}`);
      process.exit(1);
    }

    if (atoms.length === 0) {
      console.log(` 0 atoms - done.`);
      break;
    }
    console.log(` ${atoms.length} atoms.`);

    const chunks = [];
    for (let i = 0; i < atoms.length; i += batchSize) {
      chunks.push(atoms.slice(i, i + batchSize));
    }

    let roundValid = 0;
    let roundFailed = 0;

    for (let ci = 0; ci < chunks.length; ci++) {
      if (limit > 0 && totalProcessed + roundValid >= limit) break;

      const chunk = chunks[ci];
      const chunkLabel = `${label} Gemini ${ci + 1}/${chunks.length}:`;
      const t0 = Date.now();

      const prompt = mode === 'classify'
        ? buildClassifyPrompt(chunk)
        : buildEnrichPrompt(chunk);

      let geminiResults;
      try {
        geminiResults = await callGemini(prompt, geminiKey);
      } catch (err) {
        console.log(`${chunkLabel} ERROR - ${err.message.slice(0, 120)} | skipping batch`);
        roundFailed += chunk.length;
        if (delay > 0 && ci < chunks.length - 1) await sleep(delay);
        continue;
      }

      if (!Array.isArray(geminiResults)) {
        console.log(`${chunkLabel} response not an array | skipping batch`);
        roundFailed += chunk.length;
        if (delay > 0 && ci < chunks.length - 1) await sleep(delay);
        continue;
      }

      const updates = [];
      const seen = new Set();
      for (const item of geminiResults) {
        const idx = item?.i;
        if (typeof idx !== 'number' || idx < 1 || idx > chunk.length || seen.has(idx)) continue;
        seen.add(idx);
        const atom = chunk[idx - 1];
        const update = validateResult(item, atom, mode);
        if (update) {
          updates.push(update);
        } else {
          roundFailed++;
        }
      }

      const ms = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${chunkLabel} ${chunk.length} atoms -> ${updates.length} valid, ${chunk.length - updates.length} skipped (${ms}s)`);

      if (updates.length > 0) {
        process.stdout.write(`${label} Writing ${updates.length} updates to D1...`);
        const wf = await writeResults(updates, mode, dryRun, cfToken);
        roundFailed += wf;
        if (!dryRun) console.log(wf > 0 ? ` done (${wf} write failures).` : ' done.');
      }

      roundValid += updates.length;

      if (delay > 0 && ci < chunks.length - 1) await sleep(delay);
    }

    totalProcessed += roundValid;
    totalFailed += roundFailed;

    console.log(`${label} Round ${readRound}: ${roundValid} valid, ${roundFailed} failed | total: ${totalProcessed} | elapsed: ${elapsed(startMs)}`);

    if (atoms.length < 500) {
      console.log(`${label} Fetched < 500 atoms - corpus exhausted.`);
      break;
    }

    if (limit > 0 && totalProcessed >= limit) {
      console.log(`${label} Reached limit of ${limit}.`);
      break;
    }
  }

  console.log(`\n${label} Done: ${totalProcessed} processed, ${totalFailed} failed | ${elapsed(startMs)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
