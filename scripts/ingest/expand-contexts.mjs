#!/usr/bin/env node
/**
 * Phase 2: Arrangement Context Expansion
 *
 * Finds arrangements with < 10 category contexts and fills the gaps
 * using Gemini Flash to generate visual guidance.
 *
 * Pattern from scripts/backfill-contexts.mjs
 *
 * Usage:
 *   node scripts/ingest/expand-contexts.mjs [--dry-run] [--arrangement slug]
 */

import { sleep } from './utils/env.mjs';
import { queryD1 } from './utils/d1.mjs';
import { callGemini, callGeminiText } from './utils/gemini.mjs';

// Target categories that every arrangement should have contexts for
const TARGET_CATEGORIES = [
  'style.genre', 'lighting.source', 'environment.setting',
  'environment.atmosphere', 'covering.clothing', 'covering.material',
  'covering.accessory', 'subject.hair', 'subject.expression',
  'camera.shot', 'pose.position', 'color.palette',
];

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] ? args[i + 1] : null; };
const hasFlag = (name) => args.includes(`--${name}`);
const DRY_RUN = hasFlag('dry-run');
const FILTER_ARRANGEMENT = getArg('arrangement');

async function main() {
  console.log('=== Phase 2: Arrangement Context Expansion ===\n');

  // 1. Get all arrangements and their context counts
  const arrangements = await queryD1(
    `SELECT slug, name, harmonics, category_weights FROM arrangements ORDER BY slug`
  );
  console.log(`Total arrangements: ${arrangements.length}`);

  // 2. Get existing contexts
  const existingRows = await queryD1(
    `SELECT category_slug, context FROM category_contexts WHERE context != 'default'`
  );
  const contextMap = new Map(); // arrangement_slug -> Set<category_slug>
  for (const row of existingRows) {
    if (!contextMap.has(row.context)) contextMap.set(row.context, new Set());
    contextMap.get(row.context).add(row.category_slug);
  }

  // 3. Get category descriptions for the prompt
  const catSlugs = TARGET_CATEGORIES.map(s => `'${s}'`).join(',');
  const catRows = await queryD1(
    `SELECT slug, label, description FROM categories WHERE slug IN (${catSlugs})`
  );
  const catInfo = new Map();
  for (const row of catRows) {
    catInfo.set(row.slug, { label: row.label, description: row.description });
  }

  // 4. Get default guidance for reference
  const defaultRows = await queryD1(
    `SELECT category_slug, guidance FROM category_contexts WHERE context = 'default' AND category_slug IN (${catSlugs})`
  );
  const defaultGuidance = new Map();
  for (const row of defaultRows) {
    defaultGuidance.set(row.category_slug, row.guidance);
  }

  // 5. Get example guidance from well-covered arrangements
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
      if (rows.length > 0) {
        examples.push({ context: ctx, category: cat, guidance: rows[0].guidance });
      }
    } catch { /* non-fatal */ }
  }

  // 6. Find gaps
  const gaps = [];
  for (const arr of arrangements) {
    if (FILTER_ARRANGEMENT && arr.slug !== FILTER_ARRANGEMENT) continue;

    const existing = contextMap.get(arr.slug) || new Set();
    if (!FILTER_ARRANGEMENT && existing.size >= 10) continue; // skip well-covered

    const missing = TARGET_CATEGORIES.filter(cat => !existing.has(cat));
    if (missing.length === 0) continue;

    gaps.push({ arrangement: arr, missing, existingCount: existing.size });
    console.log(`  ${arr.slug}: ${existing.size} existing, ${missing.length} gaps`);
  }

  if (gaps.length === 0) {
    console.log('\nAll arrangements have sufficient contexts. Nothing to do.');
    return;
  }

  console.log(`\n${gaps.length} arrangements need expansion, ${gaps.reduce((s, g) => s + g.missing.length, 0)} total gaps`);

  // 7. Generate contexts via Gemini
  const results = [];
  for (const { arrangement, missing } of gaps) {
    console.log(`\nGenerating for ${arrangement.slug} (${missing.length} categories)...`);

    const categoryBlock = missing.map(slug => {
      const info = catInfo.get(slug);
      const defG = defaultGuidance.get(slug) || '(no default)';
      return `- ${slug}: ${info?.label || slug} - ${info?.description || ''}\n  Default: ${defG}`;
    }).join('\n');

    const exampleBlock = examples.map(ex =>
      `- ${ex.context} / ${ex.category}: "${ex.guidance}"`
    ).join('\n');

    const prompt = `You are writing visual composition guidance for an AI image generation system called Grimoire.

ARRANGEMENT: ${arrangement.name}
HARMONICS: ${arrangement.harmonics}
CATEGORY WEIGHTS: ${arrangement.category_weights}

Generate specific, visual, actionable guidance for each category below. This guidance tells the system HOW to handle each visual category within this arrangement's aesthetic.

Rules:
- Be concrete and visual: "Hard directional key light from a desk lamp" not "moody atmospheric lighting"
- Specify materials, techniques, objects, colors by name
- State what makes THIS arrangement different from generic usage
- 2-4 sentences per category

CATEGORIES:
${categoryBlock}

EXAMPLES OF HIGH-QUALITY GUIDANCE:
${exampleBlock}

Return a JSON object mapping category_slug to guidance string:
{${missing.map(s => `"${s}": "..."`).join(', ')}}

Return ONLY the JSON object. No markdown, no code fences.`;

    try {
      const response = await callGemini(prompt);

      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        console.error(`  Bad response type: ${typeof response}`);
        continue;
      }

      let generated = 0;
      for (const cat of missing) {
        const guidance = response[cat];
        if (typeof guidance === 'string' && guidance.length > 20) {
          results.push({ arrangement_slug: arrangement.slug, category_slug: cat, guidance });
          generated++;
        } else {
          console.log(`  [warn] ${cat}: missing or too short`);
        }
      }
      console.log(`  Generated ${generated}/${missing.length}`);
    } catch (err) {
      console.error(`  ERROR: ${err.message.slice(0, 200)}`);
    }

    await sleep(6000);
  }

  console.log(`\nTotal generated: ${results.length}`);

  if (DRY_RUN) {
    console.log('\n=== DRY RUN ===');
    for (const r of results) {
      console.log(`  ${r.arrangement_slug} / ${r.category_slug}: ${r.guidance.slice(0, 80)}...`);
    }
    return;
  }

  // 8. Insert into D1
  console.log('\nInserting contexts...');
  let inserted = 0;
  let failed = 0;

  for (const ctx of results) {
    const guidance = ctx.guidance.replace(/'/g, "''");
    const sql = `INSERT OR REPLACE INTO category_contexts (category_slug, context, guidance) VALUES ('${ctx.category_slug}', '${ctx.arrangement_slug}', '${guidance}')`;

    try {
      await queryD1(sql);
      inserted++;
    } catch (err) {
      console.error(`  INSERT failed (${ctx.arrangement_slug}/${ctx.category_slug}): ${err.message.slice(0, 100)}`);
      failed++;
    }
  }

  console.log(`\nInserted: ${inserted}, Failed: ${failed}`);

  // 9. Verify
  console.log('\n--- Verification ---');
  const verifyRows = await queryD1(`
    SELECT a.slug, COUNT(cc.context) as ctx
    FROM arrangements a
    LEFT JOIN category_contexts cc ON cc.context = a.slug
    GROUP BY a.slug
    ORDER BY ctx ASC
    LIMIT 15
  `);
  for (const row of verifyRows) {
    const marker = row.ctx < 10 ? ' <-- still under 10' : '';
    console.log(`  ${row.slug}: ${row.ctx} contexts${marker}`);
  }
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
