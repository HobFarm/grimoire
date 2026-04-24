#!/usr/bin/env node
/**
 * Create Pixel Art Arrangements: 8 arrangements + 15 category contexts each
 *
 * Inserts arrangements (if not already present) and generates per-category
 * guidance via Gemini Flash. Follows the same pattern as create-arrangements.mjs.
 *
 * Usage:
 *   node scripts/ingest/create-pixel-arrangements.mjs [--dry-run]
 */

import { sleep } from './utils/env.mjs';
import { queryD1 } from './utils/d1.mjs';
import { callGemini } from './utils/gemini.mjs';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const DRY_RUN = hasFlag('dry-run');

const PIXEL_ARRANGEMENTS = [
  {
    slug: 'pixel-art',
    name: 'Pixel Art',
    harmonics: { hardness: 0.9, temperature: 0.3, weight: 0.4, formality: 0.6, era_affinity: 0.4 },
    register: 0.45,
    category_weights: {
      'style.medium': 2.5, 'color.palette': 2.0, 'composition.rule': 1.5,
      'style.genre': 1.5, 'lighting.source': 1.0, 'subject.expression': 0.8,
    },
    description_hint: 'Grid-locked raster graphics where every pixel is deliberate. Anti-aliasing through manual dithering, limited palettes, tile-based construction. Spans NES to modern indie.',
  },
  {
    slug: '8bit-nes',
    name: '8-Bit NES',
    harmonics: { hardness: 1.0, temperature: 0.3, weight: 0.3, formality: 0.8, era_affinity: 0.2 },
    register: 0.40,
    category_weights: {
      'style.medium': 2.5, 'color.palette': 2.5, 'composition.rule': 1.8,
      'style.genre': 1.5, 'subject.expression': 1.3, 'lighting.source': 0.8,
    },
    description_hint: 'NES hardware constraints: 52-color master palette, 3+1 colors per 8x8 sprite tile, 4 background palettes of 3+1. Silhouette-first character design, attribute grid color boundaries. Canonical: SMB3, Mega Man 2, Castlevania III.',
    context_mode_overrides: { 'color.palette': 'replace', 'style.medium': 'replace', 'composition.rule': 'replace' },
  },
  {
    slug: '16bit-snes',
    name: '16-Bit SNES',
    harmonics: { hardness: 0.9, temperature: 0.5, weight: 0.4, formality: 0.7, era_affinity: 0.3 },
    register: 0.45,
    category_weights: {
      'style.medium': 2.5, 'color.palette': 2.0, 'style.genre': 1.8,
      'composition.rule': 1.5, 'lighting.source': 1.3, 'environment.atmosphere': 1.2,
    },
    description_hint: 'SNES PPU: 256 on-screen from 32,768-color palette, 16-color sub-palettes, Mode 7 rotation/scaling, multi-layer parallax scrolling, color math for transparency. Canonical: Chrono Trigger, FF6, Super Metroid, EarthBound.',
    context_mode_overrides: { 'color.palette': 'replace', 'style.medium': 'replace' },
  },
  {
    slug: '16bit-genesis',
    name: '16-Bit Genesis',
    harmonics: { hardness: 0.9, temperature: 0.3, weight: 0.5, formality: 0.7, era_affinity: 0.3 },
    register: 0.45,
    category_weights: {
      'style.medium': 2.5, 'color.palette': 2.0, 'style.genre': 1.8,
      'composition.rule': 1.5, 'lighting.source': 1.3, 'environment.setting': 1.2,
    },
    description_hint: 'Genesis/Mega Drive VDP: 512-color palette, 61 on-screen, 4 palettes of 16 colors, highlight/shadow modes for pseudo-transparency, fast DMA for scroll effects. Canonical: Sonic, Streets of Rage 2, Gunstar Heroes, Phantasy Star IV.',
    context_mode_overrides: { 'color.palette': 'replace', 'style.medium': 'replace' },
  },
  {
    slug: 'demoscene',
    name: 'Demoscene',
    harmonics: { hardness: 0.8, temperature: 0.3, weight: 0.5, formality: 0.5, era_affinity: 0.2 },
    register: 0.50,
    category_weights: {
      'style.medium': 2.0, 'style.genre': 2.0, 'color.palette': 1.8,
      'composition.rule': 1.5, 'effect.post': 1.5, 'reference.technique': 1.3,
    },
    description_hint: 'Competition-driven pixel art from Amiga, C64, Atari ST, ZX Spectrum scenes. Photorealism push within hardware limits, cracktro/intro aesthetics, advanced dithering (ordered, Floyd-Steinberg), sub-pixel animation. Graphicians as artist title. DEGAS Elite, Deluxe Paint tooling.',
    context_mode_overrides: { 'style.medium': 'replace' },
  },
  {
    slug: 'neo-retro',
    name: 'Neo-Retro',
    harmonics: { hardness: 0.8, temperature: 0.5, weight: 0.3, formality: 0.5, era_affinity: 0.7 },
    register: 0.40,
    category_weights: {
      'style.medium': 2.0, 'style.genre': 1.8, 'color.palette': 1.8,
      'composition.rule': 1.5, 'environment.atmosphere': 1.3, 'lighting.source': 1.2,
    },
    description_hint: 'Modern games with self-imposed retro constraints plus modern conveniences (widescreen, sub-pixel scrolling, expanded palettes). Shovel Knight (NES+), Celeste (SNES-inspired), Hyper Light Drifter, Owlboy. The "8 color gentlemen\'s club" purist tradition vs. expanded neo-retro freedom.',
  },
  {
    slug: 'pixel-illustration',
    name: 'Pixel Illustration',
    harmonics: { hardness: 0.7, temperature: 0.4, weight: 0.5, formality: 0.6, era_affinity: 0.6 },
    register: 0.55,
    category_weights: {
      'style.medium': 2.0, 'composition.rule': 1.8, 'style.genre': 1.5,
      'color.palette': 1.5, 'environment.setting': 1.5, 'environment.prop': 1.3,
    },
    description_hint: 'Large-canvas pixel art for commercial and editorial use. eBoy isometric cityscapes, Superbrothers: Sword & Sworcery EP painterly pixels, advertising poster work. Anti-aliasing acceptable, higher resolution canvas, richer palettes. Pixel art as illustration medium rather than game asset.',
  },
  {
    slug: 'pixel-dolls',
    name: 'Pixel Dolls',
    harmonics: { hardness: 0.7, temperature: 0.6, weight: 0.2, formality: 0.3, era_affinity: 0.5 },
    register: 0.30,
    category_weights: {
      'covering.clothing': 2.0, 'covering.accessory': 2.0, 'subject.hair': 1.8,
      'covering.footwear': 1.5, 'subject.expression': 1.5, 'color.palette': 1.3,
    },
    description_hint: 'Character design and dress-up pixel art from late 1990s forum/chat culture. Dollz, dollmakers, Candybar Doll Maker lineage. Intricate clothing and accessory detail at tiny scales. Pixel dolls to dress-up games to DeviantArt adoptables pipeline. Community-driven, fashion-focused, character identity expression.',
  },
];

// 15 target categories: the standard 13 plus pixel-art-critical additions
const TARGET_CATEGORIES = [
  'style.genre', 'lighting.source', 'environment.setting',
  'environment.atmosphere', 'covering.clothing', 'covering.material',
  'covering.accessory', 'subject.hair', 'subject.expression',
  'camera.shot', 'pose.position', 'color.palette', 'style.medium',
  'composition.rule', 'reference.technique',
];

async function main() {
  console.log('=== Pixel Art Arrangements ===\n');
  if (DRY_RUN) console.log('[DRY RUN MODE]\n');

  // Check existing
  const existingRows = await queryD1('SELECT slug FROM arrangements');
  const existingSlugs = new Set(existingRows.map(r => r.slug));
  console.log(`Existing arrangements: ${existingSlugs.size}`);

  const toCreate = PIXEL_ARRANGEMENTS.filter(a => !existingSlugs.has(a.slug));
  if (toCreate.length === 0) {
    console.log('All pixel art arrangements already exist. Generating missing contexts only.\n');
  } else {
    console.log(`New arrangements to create: ${toCreate.length}`);
  }

  // Get category info for prompt context
  const catSlugs = TARGET_CATEGORIES.map(s => `'${s}'`).join(',');
  const catRows = await queryD1(
    `SELECT slug, label, description FROM categories WHERE slug IN (${catSlugs})`
  );
  const catInfo = new Map();
  for (const row of catRows) {
    catInfo.set(row.slug, { label: row.label, description: row.description });
  }

  // Get example contexts for few-shot prompting
  const examples = [];
  const examplePairs = [
    ['noir', 'lighting.source'],
    ['atomic-noir', 'style.genre'],
    ['manga', 'style.medium'],
    ['ligne-claire', 'composition.rule'],
  ];
  for (const [ctx, cat] of examplePairs) {
    try {
      const rows = await queryD1(
        `SELECT guidance FROM category_contexts WHERE context = '${ctx}' AND category_slug = '${cat}'`
      );
      if (rows.length > 0) examples.push({ context: ctx, category: cat, guidance: rows[0].guidance });
    } catch { /* non-fatal */ }
  }

  for (const arr of PIXEL_ARRANGEMENTS) {
    console.log(`\n--- ${arr.name} (${arr.slug}) ---`);

    const harmonicsJson = JSON.stringify(arr.harmonics).replace(/'/g, "''");
    const weightsJson = JSON.stringify(arr.category_weights).replace(/'/g, "''");

    // Insert arrangement if new
    if (!existingSlugs.has(arr.slug)) {
      if (DRY_RUN) {
        console.log(`  [dry] Would INSERT: slug=${arr.slug}, register=${arr.register}`);
      } else {
        const descEsc = arr.description_hint.split("'").join("''");
        const sql = `INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description)
          VALUES ('${arr.slug}', '${arr.name.replace(/'/g, "''")}', '${harmonicsJson}', '${weightsJson}', '${arr.slug}', ${arr.register}, '${descEsc}')`;
        try {
          await queryD1(sql);
          console.log('  Inserted arrangement');
        } catch (err) {
          console.error(`  INSERT failed: ${err.message.slice(0, 200)}`);
          continue;
        }
      }
    } else {
      console.log('  Arrangement exists, checking contexts...');
    }

    // Check existing contexts for this arrangement
    const existingCtx = await queryD1(
      `SELECT category_slug FROM category_contexts WHERE context = '${arr.slug}'`
    );
    const existingCtxSlugs = new Set(existingCtx.map(r => r.category_slug));
    const missingCats = TARGET_CATEGORIES.filter(c => !existingCtxSlugs.has(c));

    if (missingCats.length === 0) {
      console.log(`  All ${TARGET_CATEGORIES.length} contexts exist. Skipping.`);
      continue;
    }

    console.log(`  Generating ${missingCats.length} missing category contexts...`);

    const categoryBlock = missingCats.map(slug => {
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
- Be concrete and visual: "8x8 tile grid with 3+1 color sub-palettes per attribute block" not "retro pixel style"
- Specify exact constraints, techniques, tools, color counts, resolution details
- Reference canonical examples where relevant (specific games, artists, platforms)
- State what makes THIS arrangement's pixel art register unique vs others
- 2-4 sentences per category
- For pixel art arrangements, technique and constraint details are critical

CATEGORIES:
${categoryBlock}

EXAMPLES OF HIGH-QUALITY GUIDANCE:
${exampleBlock}

Return a JSON object mapping category_slug to guidance string:
{${missingCats.map(s => `"${s}": "..."`).join(', ')}}

Return ONLY the JSON object. No markdown, no code fences.`;

    try {
      const response = await callGemini(prompt);

      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        console.error(`  Bad response type: ${typeof response}`);
        continue;
      }

      let generated = 0;
      for (const cat of missingCats) {
        const guidance = response[cat];
        if (typeof guidance !== 'string' || guidance.length < 20) {
          console.log(`  [warn] ${cat}: missing or too short`);
          continue;
        }

        // Determine context_mode
        const modeOverrides = arr.context_mode_overrides || {};
        const contextMode = modeOverrides[cat] || null; // null = default enrich

        if (DRY_RUN) {
          const modeLabel = contextMode ? ` [${contextMode}]` : '';
          console.log(`  [dry] ${cat}${modeLabel}: ${guidance.slice(0, 80)}...`);
          generated++;
          continue;
        }

        const guidanceEsc = guidance.replace(/'/g, "''");
        const modeSql = contextMode
          ? `INSERT OR REPLACE INTO category_contexts (category_slug, context, guidance, context_mode) VALUES ('${cat}', '${arr.slug}', '${guidanceEsc}', '${contextMode}')`
          : `INSERT OR REPLACE INTO category_contexts (category_slug, context, guidance) VALUES ('${cat}', '${arr.slug}', '${guidanceEsc}')`;

        try {
          await queryD1(modeSql);
          generated++;
        } catch (err) {
          console.error(`  Context INSERT failed (${cat}): ${err.message.slice(0, 100)}`);
        }
      }

      console.log(`  Generated ${generated}/${missingCats.length} contexts`);
    } catch (err) {
      console.error(`  Gemini ERROR: ${err.message.slice(0, 200)}`);
    }

    await sleep(6000);
  }

  // Verify
  console.log('\n--- Verification ---');
  const verifyRows = await queryD1('SELECT COUNT(*) as cnt FROM arrangements');
  console.log(`Total arrangements: ${verifyRows[0]?.cnt}`);

  for (const arr of PIXEL_ARRANGEMENTS) {
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
