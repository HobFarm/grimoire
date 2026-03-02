import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// --- Load .env ---
const envPath = resolve(PROJECT_ROOT, '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
} catch {
  console.error('Missing .env file. Create workers/grimoire-classifier/.env with GEMINI_API_KEY=your-key');
  process.exit(1);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in .env');
  process.exit(1);
}

const DB_ID = 'grimoire-db';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const BATCH_SIZE = 25;
const PAGE_SIZE = 5000;

// --- CLI args ---
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;
const modes = args.filter(a => !a.startsWith('--') && a !== String(limit));

// --- Valid categories (canonical list from workers/grimoire/src/constants.ts) ---
const VALID_CATEGORIES = [
  // Visual
  'camera.lens', 'camera.shot', 'color.palette', 'composition.rule',
  'covering.accessory', 'covering.clothing', 'covering.footwear',
  'covering.headwear', 'covering.material', 'covering.outfit',
  'effect.post',
  'environment.atmosphere', 'environment.natural', 'environment.prop', 'environment.setting',
  'lighting.source', 'negative.filter',
  'object.drink', 'object.held',
  'pose.interaction', 'pose.position',
  'style.era', 'style.genre', 'style.medium',
  'subject.animal', 'subject.expression', 'subject.face', 'subject.feature',
  'subject.form', 'subject.hair',
  // Narrative
  'narrative.action', 'narrative.archetype', 'narrative.concept',
  'narrative.mood', 'narrative.phrase', 'narrative.scene',
  // Reference
  'reference.character', 'reference.film', 'reference.game',
  'reference.location', 'reference.person', 'reference.technique',
  // Domain
  'domain.academia', 'domain.athletics', 'domain.aviation',
  'domain.chemistry', 'domain.cuisine', 'domain.folklore',
  'domain.law', 'domain.maritime', 'domain.medicine',
  'domain.military', 'domain.occult', 'domain.technology',
];

// --- Classification prompt (canonical copy from workers/grimoire/src/atom-classify.ts) ---
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

Respond with ONLY a JSON array. No markdown, no explanation. Each element:
{"id":"atom_id","cat":"category_slug","mod":"visual|narrative|both","h":{"hardness":"...","temperature":"...","weight":"...","formality":"...","era_affinity":"..."}}
`;

// --- D1 helpers ---

function d1Query(sql) {
  try {
const stdout = execSync(
  `npx wrangler d1 execute ${DB_ID} --remote --json --command "${sql.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, shell: 'powershell.exe' }
);
    const parsed = JSON.parse(stdout);
    return parsed[0]?.results || [];
  } catch (err) {
    console.error('D1 query failed:', err.stderr?.slice(0, 500) || err.message);
    return null;
  }
}

function d1Execute(sql) {
  const tmpFile = resolve(PROJECT_ROOT, '.tmp-batch.sql');
  try {
    writeFileSync(tmpFile, sql, 'utf-8');
    execSync(
      `npx wrangler d1 execute ${DB_ID} --remote --json --file .tmp-batch.sql`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd: PROJECT_ROOT }
    );
    return true;
  } catch (err) {
    console.error('D1 execute failed:', err.stderr?.slice(0, 500) || err.message);
    return false;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function paginatedQuery(baseSql, userLimit) {
  if (userLimit) {
    return d1Query(`${baseSql} LIMIT ${userLimit}`) || [];
  }

  const allRows = [];
  let offset = 0;
  while (true) {
    const rows = d1Query(`${baseSql} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
    if (!rows) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    console.log(`  Fetched ${allRows.length} rows so far...`);
  }
  return allRows;
}

// --- Gemini ---

let sleepMs = 2000;

async function callGemini(atomList) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: CLASSIFICATION_PROMPT + '\n\nATOMS TO CLASSIFY:\n' + atomList }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 16384,
    }
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body,
    });

    if (response.status === 429) {
      console.warn('  Rate limited (429). Sleeping 10s and retrying...');
      sleepMs = 5000;
      await sleep(10000);
      continue;
    }

    if (response.status >= 500) {
      console.warn(`  Gemini ${response.status}. Retry ${attempt + 1}/3...`);
      await sleep(3000);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty Gemini response');
    return text;
  }
  throw new Error('Gemini failed after 3 attempts');
}

// --- Canonical map (source of truth: workers/grimoire/src/taxonomy.ts) ---
const CATEGORY_TO_COLLECTION = {
  'subject.form': 'attributes', 'subject.expression': 'features-expression',
  'subject.face': 'features-face', 'subject.feature': 'features-body',
  'subject.hair': 'features-hair', 'subject.animal': 'animals',
  'environment.setting': 'environment', 'environment.atmosphere': 'environment-atmosphere',
  'environment.prop': 'environment-props', 'environment.natural': 'nature',
  'lighting.source': 'lighting', 'color.palette': 'colors',
  'composition.rule': 'composition',
  'covering.clothing': 'clothing', 'covering.material': 'clothing',
  'covering.accessory': 'clothing-accessories', 'covering.headwear': 'clothing',
  'covering.footwear': 'clothing-footwear', 'covering.outfit': 'clothing-full',
  'pose.position': 'poses', 'pose.interaction': 'poses',
  'object.held': 'props-held', 'object.drink': 'props-held-vessels',
  'style.genre': 'styles', 'style.era': 'styles', 'style.medium': 'style-medium',
  'camera.lens': 'photography', 'camera.shot': 'photography',
  'effect.post': 'effects', 'negative.filter': 'filters',
  'reference.film': 'references', 'reference.technique': 'references',
  'reference.person': 'references', 'reference.location': 'references',
  'reference.character': 'references', 'reference.game': 'references',
  'narrative.scene': 'scenes', 'narrative.mood': 'scenes',
  'narrative.action': 'uncategorized', 'narrative.archetype': 'uncategorized',
  'narrative.concept': 'uncategorized', 'narrative.phrase': 'uncategorized',
  'domain.academia': 'uncategorized', 'domain.athletics': 'uncategorized',
  'domain.aviation': 'uncategorized', 'domain.chemistry': 'uncategorized',
  'domain.cuisine': 'uncategorized', 'domain.folklore': 'uncategorized',
  'domain.law': 'uncategorized', 'domain.maritime': 'uncategorized',
  'domain.medicine': 'uncategorized', 'domain.military': 'uncategorized',
  'domain.occult': 'uncategorized', 'domain.technology': 'uncategorized',
};

const VALID_MODALITIES = ['visual', 'narrative', 'both'];

function collectionFromCategory(cat) {
  return CATEGORY_TO_COLLECTION[cat] || 'uncategorized';
}

// --- Validation ---

function validateResults(parsed, atoms) {
  const atomMap = new Map(atoms.map(a => [a.id, a]));

  return parsed
    .filter(r => VALID_CATEGORIES.includes(r.cat) && atomMap.has(r.id))
    .map(r => ({
      atom_id: r.id,
      text: atomMap.get(r.id)?.text_lower || '',
      category_slug: r.cat,
      collection_slug: collectionFromCategory(r.cat),
      modality: VALID_MODALITIES.includes(r.mod) ? r.mod : 'visual',
      harmonics: {
        hardness: ['hard', 'soft', 'neutral'].includes(r.h?.hardness) ? r.h.hardness : 'neutral',
        temperature: ['warm', 'cool', 'neutral'].includes(r.h?.temperature) ? r.h.temperature : 'neutral',
        weight: ['heavy', 'light', 'neutral'].includes(r.h?.weight) ? r.h.weight : 'neutral',
        formality: ['structured', 'organic', 'neutral'].includes(r.h?.formality) ? r.h.formality : 'neutral',
        era_affinity: ['archaic', 'industrial', 'modern', 'timeless'].includes(r.h?.era_affinity) ? r.h.era_affinity : 'timeless',
      }
    }));
}

function escSql(s) {
  return s.replace(/'/g, "''");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Classify mode ---

async function runClassify() {
  console.log('\n=== CLASSIFY: Assigning category_slug + harmonics to uncategorized atoms ===\n');

  const sql = 'SELECT id, text_lower FROM atoms WHERE category_slug IS NULL';
  console.log('Fetching uncategorized atoms...');
  const atoms = paginatedQuery(sql, limit);
  console.log(`Found ${atoms.length} uncategorized atoms\n`);

  if (atoms.length === 0) {
    console.log('Nothing to classify.');
    return;
  }

  const totalBatches = Math.ceil(atoms.length / BATCH_SIZE);
  let totalWritten = 0;
  let totalDropped = 0;
  const failedBatches = [];

  for (let i = 0; i < atoms.length; i += BATCH_SIZE) {
    const batch = atoms.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`Batch ${batchNum}/${totalBatches} (${batch.length} atoms)... `);

    try {
      const atomList = batch.map(a =>
        `- id:${a.id} text:"${a.text_lower}"`
      ).join('\n');

      const rawText = await callGemini(atomList);

      let parsed;
      try {
        let cleaned = rawText.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleaned);
} catch {
        console.warn('JSON parse failed. Raw text (first 500 chars):', rawText?.slice(0, 500));
        console.warn('Skipping batch.');
        failedBatches.push(batch.map(a => a.id));
        await sleep(sleepMs);
        continue;
      }

      const validated = validateResults(parsed, batch);
      const dropped = batch.length - validated.length;
      totalDropped += dropped;

      if (validated.length > 0) {
        const updates = validated.map(r =>
          `UPDATE atoms SET category_slug = '${escSql(r.category_slug)}', harmonics = '${escSql(JSON.stringify(r.harmonics))}', collection_slug = '${escSql(r.collection_slug)}', modality = '${escSql(r.modality)}' WHERE id = '${r.atom_id}'`
        ).join('; ');

        const ok = d1Execute(updates);
        if (ok) {
          totalWritten += validated.length;
        } else {
          // Retry once
          console.warn('  D1 write failed, retrying...');
          const ok2 = d1Execute(updates);
          if (ok2) {
            totalWritten += validated.length;
          } else {
            failedBatches.push(batch.map(a => a.id));
          }
        }
      }

      console.log(`written=${validated.length} dropped=${dropped}`);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      failedBatches.push(batch.map(a => a.id));
    }

    await sleep(sleepMs);
  }

  console.log(`\n--- Classify complete ---`);
  console.log(`Written: ${totalWritten}, Dropped: ${totalDropped}, Failed batches: ${failedBatches.length}`);
  if (failedBatches.length > 0) {
    console.log(`Failed atom IDs (first 20): ${failedBatches.flat().slice(0, 20).join(', ')}`);
  }
}

// --- Harmonize mode ---

async function runHarmonize() {
  console.log('\n=== HARMONIZE: Adding harmonic profiles to categorized atoms ===\n');

  const sql = "SELECT id, text_lower FROM atoms WHERE category_slug IS NOT NULL AND (harmonics = '{}' OR harmonics IS NULL)";
  console.log('Fetching atoms needing harmonics...');
  const atoms = paginatedQuery(sql, limit);
  console.log(`Found ${atoms.length} atoms needing harmonics\n`);

  if (atoms.length === 0) {
    console.log('All categorized atoms have harmonics.');
    return;
  }

  const totalBatches = Math.ceil(atoms.length / BATCH_SIZE);
  let totalWritten = 0;
  const failedBatches = [];

  for (let i = 0; i < atoms.length; i += BATCH_SIZE) {
    const batch = atoms.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`Batch ${batchNum}/${totalBatches} (${batch.length} atoms)... `);

    try {
      const atomList = batch.map(a =>
        `- id:${a.id} text:"${a.text_lower}"`
      ).join('\n');

      const rawText = await callGemini(atomList);

      let parsed;
      try {
        let cleaned = rawText.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleaned);
      } catch {
        console.warn('JSON parse failed. Skipping batch.');
        failedBatches.push(batch.map(a => a.id));
        await sleep(sleepMs);
        continue;
      }

      const validated = validateResults(parsed, batch);

      if (validated.length > 0) {
        // Harmonics-only update, preserve existing category_slug
        const updates = validated.map(r =>
          `UPDATE atoms SET harmonics = '${escSql(JSON.stringify(r.harmonics))}' WHERE id = '${r.atom_id}'`
        ).join('; ');

        const ok = d1Execute(updates);
        if (ok) {
          totalWritten += validated.length;
        } else {
          console.warn('  D1 write failed, retrying...');
          const ok2 = d1Execute(updates);
          if (ok2) {
            totalWritten += validated.length;
          } else {
            failedBatches.push(batch.map(a => a.id));
          }
        }
      }

      console.log(`harmonized=${validated.length}`);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      failedBatches.push(batch.map(a => a.id));
    }

    await sleep(sleepMs);
  }

  console.log(`\n--- Harmonize complete ---`);
  console.log(`Written: ${totalWritten}, Failed batches: ${failedBatches.length}`);
  if (failedBatches.length > 0) {
    console.log(`Failed atom IDs (first 20): ${failedBatches.flat().slice(0, 20).join(', ')}`);
  }
}

// --- Status check ---

function printStatus() {
  console.log('\n=== STATUS ===');
  const stats = d1Query(
    "SELECT COUNT(*) as total, SUM(CASE WHEN category_slug IS NOT NULL THEN 1 ELSE 0 END) as categorized, SUM(CASE WHEN harmonics != '{}' AND harmonics IS NOT NULL THEN 1 ELSE 0 END) as has_harmonics, SUM(CASE WHEN category_slug IS NULL THEN 1 ELSE 0 END) as uncategorized FROM atoms"
  );
  if (stats && stats[0]) {
    console.log(`Total: ${stats[0].total}`);
    console.log(`Categorized: ${stats[0].categorized}`);
    console.log(`Has harmonics: ${stats[0].has_harmonics}`);
    console.log(`Uncategorized: ${stats[0].uncategorized}`);
  }
}

// --- Main ---

const startTime = Date.now();

if (modes.includes('classify')) {
  await runClassify();
  printStatus();
} else if (modes.includes('harmonize')) {
  await runHarmonize();
  printStatus();
} else {
  // No mode specified: run both
  await runClassify();
  await runHarmonize();
  printStatus();
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s`);
