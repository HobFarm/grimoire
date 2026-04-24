#!/usr/bin/env node
/**
 * Phase 3: Create New Arrangements for Cultural Fusion
 *
 * Inserts 6 new arrangements with numeric harmonic profiles and generates
 * 13 category contexts for each via Gemini Flash.
 *
 * Usage:
 *   node scripts/ingest/create-arrangements.mjs [--dry-run]
 */

import { sleep } from './utils/env.mjs';
import { queryD1 } from './utils/d1.mjs';
import { callGemini } from './utils/gemini.mjs';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const DRY_RUN = hasFlag('dry-run');

// New arrangements: numeric harmonics (0.0-1.0)
const NEW_ARRANGEMENTS = [
  {
    slug: 'mesoamerican',
    name: 'Mesoamerican Revival',
    harmonics: { hardness: 0.8, temperature: 0.7, weight: 0.8, formality: 0.8, era_affinity: 0.1 },
    register: 0.55,
    category_weights: {
      'environment.setting': 2.0, 'environment.prop': 1.8, 'style.genre': 1.5,
      'covering.material': 1.5, 'color.palette': 1.3, 'lighting.source': 1.2,
    },
    description_hint: 'Stepped pyramids, jade mosaics, obsidian tools, feathered serpent motifs, stucco relief, corbel arches, codex iconography.',
  },
  {
    slug: 'afrofuturist',
    name: 'Afrofuturist',
    harmonics: { hardness: 0.5, temperature: 0.7, weight: 0.5, formality: 0.4, era_affinity: 0.8 },
    register: 0.50,
    category_weights: {
      'style.genre': 2.0, 'covering.clothing': 1.8, 'covering.material': 1.5,
      'covering.accessory': 1.5, 'color.palette': 1.3, 'environment.setting': 1.2,
    },
    description_hint: 'African diaspora aesthetics projected into speculative futures. Beadwork meets holographic surfaces, Kente geometry in circuit patterns, Yoruba orisha motifs on powered armor.',
  },
  {
    slug: 'botanical-plate',
    name: 'Botanical Plate',
    harmonics: { hardness: 0.3, temperature: 0.3, weight: 0.2, formality: 0.8, era_affinity: 0.2 },
    register: 0.60,
    category_weights: {
      'style.medium': 2.0, 'style.genre': 1.5, 'color.palette': 1.5,
      'environment.natural': 1.5, 'composition.rule': 1.3, 'lighting.source': 1.2,
    },
    description_hint: 'Scientific illustration tradition. Copperplate etching, stipple shading, hand-tinted lithography, vellum surfaces, pressed specimens, dissection views, taxonomic plate layouts.',
  },
  {
    slug: 'kustom-kulture',
    name: 'Kustom Kulture',
    harmonics: { hardness: 0.8, temperature: 0.8, weight: 0.8, formality: 0.3, era_affinity: 0.5 },
    register: 0.40,
    category_weights: {
      'style.genre': 2.0, 'covering.material': 1.8, 'color.palette': 1.5,
      'environment.prop': 1.5, 'style.medium': 1.3, 'environment.setting': 1.2,
    },
    description_hint: 'Hot rod and lowrider visual culture. Candy apple paint, metal flake, pinstripe scrollwork, flame jobs, chopped and channeled bodywork, tuck-and-roll upholstery, chrome everything.',
  },
  {
    slug: 'psychedelic',
    name: 'Psychedelic',
    harmonics: { hardness: 0.2, temperature: 0.8, weight: 0.2, formality: 0.2, era_affinity: 0.7 },
    register: 0.35,
    category_weights: {
      'color.palette': 2.0, 'style.genre': 1.8, 'style.medium': 1.5,
      'composition.rule': 1.3, 'environment.atmosphere': 1.3, 'lighting.source': 1.2,
    },
    description_hint: 'Vibrating color fields, bubble lettering, Art Nouveau curves, day-glo palettes, split fountain ink, kaleidoscope symmetry, Fillmore poster style, moire patterns.',
  },
  {
    slug: 'prelinger-americana',
    name: 'Prelinger Americana',
    harmonics: { hardness: 0.5, temperature: 0.7, weight: 0.5, formality: 0.7, era_affinity: 0.5 },
    register: 0.45,
    category_weights: {
      'environment.setting': 2.0, 'environment.prop': 1.8, 'style.era': 1.5,
      'color.palette': 1.3, 'covering.clothing': 1.3, 'lighting.source': 1.2,
    },
    description_hint: 'Mid-century American visual culture. Googie architecture, streamline moderne, atomic age optimism, diner chrome, drive-in theaters, boomerang formica, Sputnik chandeliers.',
  },
];

// Categories to generate contexts for
const TARGET_CATEGORIES = [
  'style.genre', 'lighting.source', 'environment.setting',
  'environment.atmosphere', 'covering.clothing', 'covering.material',
  'covering.accessory', 'subject.hair', 'subject.expression',
  'camera.shot', 'pose.position', 'color.palette', 'style.medium',
];

async function main() {
  console.log('=== Phase 3: Create New Arrangements ===\n');

  // Check which arrangements already exist
  const existingRows = await queryD1(`SELECT slug FROM arrangements`);
  const existingSlugs = new Set(existingRows.map(r => r.slug));
  console.log(`Existing arrangements: ${existingSlugs.size}`);

  const toCreate = NEW_ARRANGEMENTS.filter(a => !existingSlugs.has(a.slug));
  if (toCreate.length === 0) {
    console.log('All new arrangements already exist. Nothing to do.');
    return;
  }
  console.log(`New arrangements to create: ${toCreate.length}`);

  // Get category info for context generation prompt
  const catSlugs = TARGET_CATEGORIES.map(s => `'${s}'`).join(',');
  const catRows = await queryD1(
    `SELECT slug, label, description FROM categories WHERE slug IN (${catSlugs})`
  );
  const catInfo = new Map();
  for (const row of catRows) {
    catInfo.set(row.slug, { label: row.label, description: row.description });
  }

  // Get example contexts
  const examples = [];
  const examplePairs = [
    ['noir', 'lighting.source'],
    ['atomic-noir', 'style.genre'],
    ['cyberpunk', 'covering.material'],
  ];
  for (const [ctx, cat] of examplePairs) {
    try {
      const rows = await queryD1(
        `SELECT guidance FROM category_contexts WHERE context = '${ctx}' AND category_slug = '${cat}'`
      );
      if (rows.length > 0) examples.push({ context: ctx, category: cat, guidance: rows[0].guidance });
    } catch { /* non-fatal */ }
  }

  for (const arr of toCreate) {
    console.log(`\n--- Creating: ${arr.name} (${arr.slug}) ---`);

    const harmonicsJson = JSON.stringify(arr.harmonics).replace(/'/g, "''");
    const weightsJson = JSON.stringify(arr.category_weights).replace(/'/g, "''");

    if (DRY_RUN) {
      console.log(`  [dry] Would INSERT: slug=${arr.slug}, register=${arr.register}`);
      console.log(`  [dry] Harmonics: ${harmonicsJson}`);
    } else {
      // Insert arrangement
      const sql = `INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register)
        VALUES ('${arr.slug}', '${arr.name.replace(/'/g, "''")}', '${harmonicsJson}', '${weightsJson}', '${arr.slug}', ${arr.register})`;

      try {
        await queryD1(sql);
        console.log(`  Inserted arrangement`);
      } catch (err) {
        console.error(`  INSERT failed: ${err.message.slice(0, 200)}`);
        continue;
      }
    }

    // Generate 13 category contexts
    console.log(`  Generating ${TARGET_CATEGORIES.length} category contexts...`);

    const categoryBlock = TARGET_CATEGORIES.map(slug => {
      const info = catInfo.get(slug);
      return `- ${slug}: ${info?.label || slug} - ${info?.description || ''}`;
    }).join('\n');

    const exampleBlock = examples.map(ex =>
      `- ${ex.context} / ${ex.category}: "${ex.guidance}"`
    ).join('\n');

    const prompt = `You are writing visual composition guidance for an AI image generation system called Grimoire.

ARRANGEMENT: ${arr.name}
AESTHETIC: ${arr.description_hint}
HARMONICS: ${harmonicsJson}
CATEGORY WEIGHTS: ${weightsJson}

Generate specific, visual, actionable guidance for each category below. This guidance tells the system HOW to handle each visual category within this arrangement's aesthetic.

Rules:
- Be concrete and visual: "Hard directional key light from a desk lamp" not "moody atmospheric lighting"
- Specify materials, techniques, objects, colors by name
- State what makes THIS arrangement unique
- 2-4 sentences per category

CATEGORIES:
${categoryBlock}

EXAMPLES OF HIGH-QUALITY GUIDANCE:
${exampleBlock}

Return a JSON object mapping category_slug to guidance string:
{${TARGET_CATEGORIES.map(s => `"${s}": "..."`).join(', ')}}

Return ONLY the JSON object. No markdown, no code fences.`;

    try {
      const response = await callGemini(prompt);

      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        console.error(`  Bad response type: ${typeof response}`);
        continue;
      }

      let generated = 0;
      for (const cat of TARGET_CATEGORIES) {
        const guidance = response[cat];
        if (typeof guidance !== 'string' || guidance.length < 20) {
          console.log(`  [warn] ${cat}: missing or too short`);
          continue;
        }

        if (DRY_RUN) {
          console.log(`  [dry] ${cat}: ${guidance.slice(0, 80)}...`);
          generated++;
          continue;
        }

        const guidanceEsc = guidance.replace(/'/g, "''");
        const ctxSql = `INSERT OR REPLACE INTO category_contexts (category_slug, context, guidance)
          VALUES ('${cat}', '${arr.slug}', '${guidanceEsc}')`;

        try {
          await queryD1(ctxSql);
          generated++;
        } catch (err) {
          console.error(`  Context INSERT failed (${cat}): ${err.message.slice(0, 100)}`);
        }
      }

      console.log(`  Generated ${generated}/${TARGET_CATEGORIES.length} contexts`);
    } catch (err) {
      console.error(`  Gemini ERROR: ${err.message.slice(0, 200)}`);
    }

    await sleep(6000);
  }

  // Verify
  console.log('\n--- Verification ---');
  const verifyRows = await queryD1(`SELECT COUNT(*) as cnt FROM arrangements`);
  console.log(`Total arrangements: ${verifyRows[0]?.cnt}`);

  for (const arr of toCreate) {
    const ctxRows = await queryD1(
      `SELECT COUNT(*) as cnt FROM category_contexts WHERE context = '${arr.slug}'`
    );
    console.log(`  ${arr.slug}: ${ctxRows[0]?.cnt || 0} contexts`);
  }
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
