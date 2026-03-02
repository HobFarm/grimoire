#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Config ─────────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'e343cbfa70c5166f00d871e513ae352a';
const DATABASE_ID = '3cb1cdee-17af-477c-ab0a-5a18447948ef';
const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
// Direct Gemini API (AI Gateway needs separate cf-aig-authorization token stored as worker secret)
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const TARGET_CATEGORIES = [
  'style.genre', 'lighting.source', 'environment.setting',
  'environment.atmosphere', 'covering.clothing', 'covering.material',
  'covering.accessory', 'subject.hair', 'subject.expression',
  'camera.shot', 'pose.position', 'color.palette',
];

const TARGET_SET = new Set(TARGET_CATEGORIES);
const GEMINI_TEMPERATURE = 0.3;
const INTER_ARRANGEMENT_DELAY_MS = 1000;

// ─── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { audit: false, dryRun: false, arrangement: null, category: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--audit') opts.audit = true;
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--arrangement') opts.arrangement = args[++i];
    else if (args[i] === '--category') opts.category = args[++i];
  }
  return opts;
}

// ─── Utilities ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveCfToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;

  // Fall back to wrangler OAuth token
  const configPath = join(homedir(), '.wrangler', 'config', 'default.toml');
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) {
      console.log('[auth] Using wrangler OAuth token from ~/.wrangler/config/default.toml');
      return match[1];
    }
  }

  return null;
}

// Copied from batch-process.mjs:252-315
function sanitizeGeminiJson(raw) {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract JSON if wrapped in text explanation
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

  // Fix trailing commas
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
      result += ' ';
      continue;
    }

    result += char;
  }

  return result;
}

// ─── D1 HTTP API ────────────────────────────────────────────────────────────────

async function queryD1(sql, params, cfToken) {
  const body = params && params.length > 0
    ? { sql, params }
    : { sql };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(D1_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status >= 500 && attempt < 3) {
          await sleep(attempt * 2000);
          continue;
        }
        throw new Error(`D1 API ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(`D1 query failed: ${JSON.stringify(data.errors).slice(0, 300)}`);
      }

      return data.result[0].results;
    } catch (err) {
      if (attempt < 3 && err.message.includes('fetch failed')) {
        await sleep(attempt * 2000);
        continue;
      }
      throw err;
    }
  }
}

// ─── Gemini ─────────────────────────────────────────────────────────────────────

async function fetchGemini(prompt, apiKey) {
  const url = `${GEMINI_URL}?key=${apiKey}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: GEMINI_TEMPERATURE,
            maxOutputTokens: 4096,
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 429) {
      if (attempt === 1) {
        process.stderr.write(`  Gemini 429, waiting 60s...\n`);
        await sleep(60_000);
        continue;
      }
      throw new Error('Gemini 429 after retry');
    }

    if (response.status === 500 || response.status === 503) {
      if (attempt === 1) {
        process.stderr.write(`  Gemini ${response.status}, waiting 30s...\n`);
        await sleep(30_000);
        continue;
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

    const sanitized = sanitizeGeminiJson(raw);
    try {
      return JSON.parse(sanitized);
    } catch (parseErr) {
      if (attempt === 1) {
        process.stderr.write(`  JSON parse failed, retrying...\n`);
        continue;
      }
      throw new Error(`Unparseable JSON: ${parseErr.message}\nRaw: ${raw.slice(0, 300)}`);
    }
  }

  throw new Error('Gemini: exhausted retries');
}

// ─── Phase 1: Audit ─────────────────────────────────────────────────────────────

async function fetchArrangements(cfToken) {
  try {
    return await queryD1(
      'SELECT slug, name, description, harmonics, category_weights FROM arrangements ORDER BY slug',
      [],
      cfToken,
    );
  } catch (err) {
    if (err.message.includes('no such column') || err.message.includes('description')) {
      console.log('[audit] No description column, proceeding without it');
      const rows = await queryD1(
        'SELECT slug, name, harmonics, category_weights FROM arrangements ORDER BY slug',
        [],
        cfToken,
      );
      return rows.map(r => ({ ...r, description: null }));
    }
    throw err;
  }
}

async function audit(cfToken, filters) {
  console.log('[audit] Querying database state...');

  // 1. Arrangements
  const arrangements = await fetchArrangements(cfToken);
  console.log(`[audit] ${arrangements.length} arrangements found`);

  // 2. Existing non-default contexts
  const existingRows = await queryD1(
    'SELECT category_slug, context FROM category_contexts WHERE context != ?',
    ['default'],
    cfToken,
  );
  const existingContexts = new Map(); // arrangement -> Set<category_slug>
  for (const row of existingRows) {
    if (!existingContexts.has(row.context)) existingContexts.set(row.context, new Set());
    existingContexts.get(row.context).add(row.category_slug);
  }

  // 3. Category descriptions for the 12 targets
  const placeholders = TARGET_CATEGORIES.map(() => '?').join(', ');
  const catRows = await queryD1(
    `SELECT slug, label, description FROM categories WHERE slug IN (${placeholders})`,
    TARGET_CATEGORIES,
    cfToken,
  );
  const categoryDescriptions = new Map();
  for (const row of catRows) {
    categoryDescriptions.set(row.slug, { label: row.label, description: row.description });
  }

  // 4. Default guidance
  const defaultRows = await queryD1(
    `SELECT category_slug, guidance FROM category_contexts WHERE context = 'default' AND category_slug IN (${placeholders})`,
    TARGET_CATEGORIES,
    cfToken,
  );
  const defaultGuidance = new Map();
  for (const row of defaultRows) {
    defaultGuidance.set(row.category_slug, row.guidance);
  }

  // 5. Example guidance rows (for prompt injection)
  const exampleQueries = [
    { context: 'noir', category: 'lighting.source' },
    { context: 'atomic-noir', category: 'style.genre' },
    { context: 'cyberpunk', category: 'covering.material' },
  ];
  const examples = [];
  for (const eq of exampleQueries) {
    try {
      const rows = await queryD1(
        'SELECT guidance FROM category_contexts WHERE context = ? AND category_slug = ?',
        [eq.context, eq.category],
        cfToken,
      );
      if (rows.length > 0) {
        examples.push({ context: eq.context, category: eq.category, guidance: rows[0].guidance });
      }
    } catch {
      // Non-fatal: example might not exist
    }
  }

  // 6. Compute gap matrix
  const isRegenMode = !!(filters.arrangement || filters.category);
  const gaps = [];
  for (const arr of arrangements) {
    if (filters.arrangement && arr.slug !== filters.arrangement) continue;
    const existing = existingContexts.get(arr.slug) || new Set();
    for (const cat of TARGET_CATEGORIES) {
      if (filters.category && cat !== filters.category) continue;
      // In regen mode, include even existing pairs (INSERT OR REPLACE overwrites)
      if (!isRegenMode && existing.has(cat)) continue;
      gaps.push({ arrangement_slug: arr.slug, category_slug: cat });
    }
  }

  // 7. Save and report
  const gapFile = 'scripts/context-gaps.json';
  writeFileSync(gapFile, JSON.stringify(gaps, null, 2));

  const existingCount = existingRows.length;
  console.log(`[audit] ${arrangements.length} arrangements, ${TARGET_CATEGORIES.length} target categories`);
  console.log(`[audit] ${existingCount} existing non-default contexts, ${gaps.length} gaps to fill`);
  console.log(`[audit] Gaps saved to ${gapFile}`);

  // Per-arrangement breakdown
  for (const arr of arrangements) {
    const existing = existingContexts.get(arr.slug) || new Set();
    const arrGaps = gaps.filter(g => g.arrangement_slug === arr.slug).length;
    if (arrGaps > 0 || existing.size > 0) {
      console.log(`[audit]   ${arr.slug.padEnd(25)} ${existing.size} existing, ${arrGaps} gaps`);
    }
  }

  return { arrangements, existingContexts, categoryDescriptions, defaultGuidance, examples, gaps };
}

// ─── Phase 2: Generate ─────────────────────────────────────────────────────────

function buildBatchPrompt(arrangement, missingCategories, categoryDescriptions, defaultGuidance, examples) {
  const descLine = arrangement.description
    ? `DESCRIPTION: ${arrangement.description}\n`
    : '';

  const categoryBlock = missingCategories.map(slug => {
    const info = categoryDescriptions.get(slug);
    const defaultG = defaultGuidance.get(slug) || '(no default guidance)';
    return `- ${slug}: ${info?.label || slug} - ${info?.description || 'No description'}\n  Default guidance: ${defaultG}`;
  }).join('\n');

  const exampleBlock = examples.map(ex =>
    `- ${ex.context} / ${ex.category}: "${ex.guidance}"`
  ).join('\n');

  return `You are writing visual composition guidance for an AI image generation system called Grimoire.

ARRANGEMENT: ${arrangement.name}
HARMONICS: ${arrangement.harmonics}
CATEGORY WEIGHTS: ${arrangement.category_weights}
${descLine}
Generate specific, visual, actionable guidance for each category listed below. This guidance tells the system HOW to handle each visual category within this arrangement's aesthetic.

Rules:
- Be concrete and visual: "Hard directional key light from a desk lamp" not "moody atmospheric lighting"
- Specify materials, techniques, objects, colors by name
- State what makes THIS arrangement different from generic usage
- Include what to include AND what to avoid
- 2-4 sentences per category
- Categories with higher weights (shown in CATEGORY WEIGHTS above) deserve especially precise guidance

CATEGORIES TO GENERATE:
${categoryBlock}

EXAMPLES OF HIGH-QUALITY GUIDANCE (from other arrangements):
${exampleBlock}

Return a JSON object mapping category_slug to guidance string. Use the exact category slug as the key (with dots, e.g. "style.genre" not "style_genre"):
{${missingCategories.map(s => `"${s}": "..."`).join(', ')}}

Return ONLY the JSON object. No markdown, no code fences, no explanation.`;
}

async function generate(gapMatrix, apiKey) {
  const { arrangements, categoryDescriptions, defaultGuidance, examples, gaps } = gapMatrix;

  // Group gaps by arrangement
  const gapsByArrangement = new Map();
  for (const gap of gaps) {
    if (!gapsByArrangement.has(gap.arrangement_slug)) gapsByArrangement.set(gap.arrangement_slug, []);
    gapsByArrangement.get(gap.arrangement_slug).push(gap.category_slug);
  }

  const results = [];
  const failures = [];

  for (const [arrSlug, missingCats] of gapsByArrangement) {
    const arrangement = arrangements.find(a => a.slug === arrSlug);
    if (!arrangement) continue;

    console.log(`[generate] Processing ${arrSlug} (${missingCats.length} gaps)...`);

    const prompt = buildBatchPrompt(arrangement, missingCats, categoryDescriptions, defaultGuidance, examples);

    try {
      const response = await fetchGemini(prompt, apiKey);

      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error(`Expected JSON object, got ${typeof response}`);
      }

      let generated = 0;
      let skipped = 0;

      // Validate returned keys
      for (const key of Object.keys(response)) {
        if (!TARGET_SET.has(key)) {
          console.log(`  [warn] Unexpected key "${key}" (not in TARGET_CATEGORIES), skipping`);
          skipped++;
        }
      }

      for (const cat of missingCats) {
        const guidance = response[cat];
        if (typeof guidance === 'string' && guidance.length > 20) {
          results.push({ arrangement_slug: arrSlug, category_slug: cat, guidance });
          generated++;
        } else if (guidance) {
          console.log(`  [warn] ${cat}: guidance too short (${String(guidance).length} chars)`);
        } else {
          console.log(`  [warn] ${cat}: missing from response`);
        }
      }

      console.log(`[generate]   ${generated} categories generated${skipped ? `, ${skipped} unexpected keys skipped` : ''}`);
    } catch (err) {
      console.error(`[generate]   ERROR: ${err.message.slice(0, 150)}`);
      failures.push({ arrangement_slug: arrSlug, error: err.message });
    }

    await sleep(INTER_ARRANGEMENT_DELAY_MS);
  }

  return { results, failures };
}

// ─── Retry failed ───────────────────────────────────────────────────────────────

async function retryFailed(failures, gapMatrix, apiKey) {
  if (failures.length === 0) return [];

  console.log(`\n[retry] Retrying ${failures.length} failed arrangements...`);
  const retryResults = [];

  for (const { arrangement_slug } of failures) {
    const arrangement = gapMatrix.arrangements.find(a => a.slug === arrangement_slug);
    if (!arrangement) continue;

    const missingCats = gapMatrix.gaps
      .filter(g => g.arrangement_slug === arrangement_slug)
      .map(g => g.category_slug);

    if (missingCats.length === 0) continue;

    console.log(`[retry] ${arrangement_slug} (${missingCats.length} gaps)...`);
    await sleep(5000);

    try {
      const prompt = buildBatchPrompt(
        arrangement, missingCats,
        gapMatrix.categoryDescriptions, gapMatrix.defaultGuidance, gapMatrix.examples,
      );
      const response = await fetchGemini(prompt, apiKey);

      for (const cat of missingCats) {
        const guidance = response[cat];
        if (typeof guidance === 'string' && guidance.length > 20 && TARGET_SET.has(cat)) {
          retryResults.push({ arrangement_slug, category_slug: cat, guidance });
        }
      }
      console.log(`[retry]   ${retryResults.length} recovered`);
    } catch (err) {
      console.error(`[retry]   ${arrangement_slug} failed again: ${err.message.slice(0, 100)}`);
    }
  }

  return retryResults;
}

// ─── Phase 3: Insert ────────────────────────────────────────────────────────────

async function insert(results, cfToken, dryRun) {
  if (dryRun) {
    const outFile = 'scripts/context-generated.json';
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`[insert] Dry run: ${results.length} contexts saved to ${outFile}`);
    return { inserted: 0, failed: 0 };
  }

  console.log(`[insert] Inserting ${results.length} contexts...`);
  let inserted = 0;
  let failed = 0;

  // Process with concurrency of 5
  for (let i = 0; i < results.length; i += 5) {
    const chunk = results.slice(i, i + 5);

    const settled = await Promise.allSettled(
      chunk.map(async (ctx) => {
        const sql = 'INSERT OR REPLACE INTO category_contexts (category_slug, context, guidance) VALUES (?, ?, ?)';
        const params = [ctx.category_slug, ctx.arrangement_slug, ctx.guidance];
        await queryD1(sql, params, cfToken);
      })
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        inserted++;
      } else {
        failed++;
        console.error(`  [insert] FAILED: ${result.reason?.message?.slice(0, 100)}`);
      }
    }

    process.stdout.write(`\r[insert] ${inserted + failed}/${results.length}`);
  }

  console.log(`\n[insert] ${inserted}/${results.length} inserted, ${failed} failed`);
  return { inserted, failed };
}

// ─── Phase 4: Verify ────────────────────────────────────────────────────────────

async function verify(cfToken) {
  const rows = await queryD1(
    "SELECT context, COUNT(*) as cnt FROM category_contexts WHERE context != 'default' GROUP BY context ORDER BY context",
    [],
    cfToken,
  );

  console.log('\n[verify] Coverage:');
  let allGood = true;
  for (const row of rows) {
    const check = row.cnt >= 12 ? 'ok' : 'INCOMPLETE';
    console.log(`  ${row.context.padEnd(25)} ${row.cnt} ${check}`);
    if (row.cnt < 12) allGood = false;
  }

  if (allGood && rows.length > 0) {
    console.log(`[verify] All ${rows.length} arrangements at target coverage.`);
  } else if (rows.length > 0) {
    console.log('[verify] Some arrangements below 12. Re-run to fill gaps.');
  }

  const totalRows = await queryD1('SELECT COUNT(*) as cnt FROM category_contexts', [], cfToken);
  console.log(`[verify] Total category_contexts rows: ${totalRows[0]?.cnt}`);
}

// ─── Phase 5: Spot-check ────────────────────────────────────────────────────────

async function spotCheck(cfToken) {
  const arrangements = await queryD1(
    "SELECT DISTINCT context FROM category_contexts WHERE context != 'default'",
    [],
    cfToken,
  );

  if (arrangements.length === 0) return;

  const shuffled = arrangements.sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, 3);

  for (const { context: arrSlug } of sample) {
    console.log(`\n[spot-check] ${arrSlug}:`);
    const rows = await queryD1(
      'SELECT category_slug, guidance FROM category_contexts WHERE context = ? ORDER BY category_slug',
      [arrSlug],
      cfToken,
    );
    for (const row of rows) {
      const preview = row.guidance.length > 120
        ? row.guidance.slice(0, 120) + '...'
        : row.guidance;
      console.log(`  ${row.category_slug.padEnd(28)} "${preview}"`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  const geminiKey = process.env.GEMINI_API_KEY;
  const cfToken = resolveCfToken();

  if (!cfToken) {
    console.error('Error: No Cloudflare auth found');
    console.error('  Option 1: $env:CF_API_TOKEN = "your-token"');
    console.error('  Option 2: Run "npx wrangler login" to store OAuth token');
    process.exit(1);
  }
  if (!opts.audit && !geminiKey) {
    console.error('Error: GEMINI_API_KEY not set (required for generation)');
    console.error('  PowerShell: $env:GEMINI_API_KEY = "your-key"');
    process.exit(1);
  }

  // Phase 1: Audit
  const gapMatrix = await audit(cfToken, {
    arrangement: opts.arrangement,
    category: opts.category,
  });

  if (opts.audit) {
    console.log('\n[audit] Audit-only mode. Exiting.');
    return;
  }

  if (gapMatrix.gaps.length === 0) {
    console.log('\n[audit] No gaps found. Nothing to generate.');
    return;
  }

  // Phase 2: Generate
  const { results, failures } = await generate(gapMatrix, geminiKey);

  // Retry failures
  const retryResults = await retryFailed(failures, gapMatrix, geminiKey);
  const allResults = [...results, ...retryResults];

  if (allResults.length === 0) {
    console.log('\n[generate] No guidance generated. Check errors above.');
    return;
  }

  // Phase 3: Insert
  const { inserted, failed } = await insert(allResults, cfToken, opts.dryRun);

  if (opts.dryRun) {
    console.log('\n[dry-run] Done. Review scripts/context-generated.json');
    return;
  }

  // Phase 4: Verify
  await verify(cfToken);

  // Phase 5: Spot-check
  await spotCheck(cfToken);

  console.log(`\nDone: ${inserted} inserted, ${failed} failed out of ${allResults.length} generated.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
