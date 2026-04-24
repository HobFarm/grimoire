#!/usr/bin/env node
/**
 * Phase 0.A audit for the dimensional-vocabulary pilot.
 *
 * Emits four sections to stdout (JSON + markdown preview):
 *   1. Candidate body-light atoms   (weight <= 0.35 in candidate categories)
 *   2. Candidate body-heavy atoms   (weight >= 0.65 in candidate categories)
 *   3. Register side-check          (10 random atoms + their register, weight, category)
 *   4. Missing seed-term report     (stocky, scrawny, sumoesque, willowy, hefty, rangy, beefy)
 *
 * Each candidate row emits `suggested_action` defaulting to "keep". User hand-edits
 * to "recategorize:<slug>" or "reject" before feeding the list to /admin/heal-drift.
 *
 * Usage:
 *   node scripts/ingest/dimension-vocab-audit.mjs > audit.json
 *   node scripts/ingest/dimension-vocab-audit.mjs --limit 300
 *
 * Read-only; safe to re-run.
 */

import { queryD1 } from './utils/d1.mjs';
import './utils/env.mjs';

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] ? args[i + 1] : null; };

const LIMIT = Math.min(Math.max(parseInt(getArg('limit') || '200', 10), 1), 500);
const CANDIDATE_CATEGORIES = ['subject.form', 'narrative.mood', 'composition.rule'];
const LIGHT_MAX = 0.35;
const HEAVY_MIN = 0.65;
const SEED_TERMS = ['stocky', 'scrawny', 'sumoesque', 'willowy', 'hefty', 'rangy', 'beefy'];

const textFilterArg = getArg('text-filter');
const TEXT_FILTER = textFilterArg
  ? textFilterArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : null;

const sqlList = (arr) => arr.map(s => `'${s.replace(/'/g, "''")}'`).join(',');

async function candidates(bound, direction) {
  if (TEXT_FILTER) {
    // In text-filter mode a single list (the filter set) is emitted via both
    // candidate calls. Avoid double-listing: only return on the 'light' pass.
    if (direction !== 'light') return [];
    return textFilterRows();
  }
  const comparator = direction === 'light' ? '<=' : '>=';
  const order = direction === 'light' ? 'ASC' : 'DESC';
  const sql = `
    SELECT
      id, text, category_slug,
      json_extract(harmonics, '$.weight')     AS weight,
      register,
      status
    FROM atoms
    WHERE status != 'rejected'
      AND harmonics IS NOT NULL
      AND harmonics LIKE '%"weight"%'
      AND category_slug IN (${sqlList(CANDIDATE_CATEGORIES)})
      AND json_extract(harmonics, '$.weight') ${comparator} ${bound}
    ORDER BY weight ${order}, text ASC
    LIMIT ${LIMIT}
  `;
  const rows = await queryD1(sql);
  return rows.map(r => ({
    id: r.id,
    text: r.text,
    current_category: r.category_slug,
    weight: r.weight,
    register: r.register,
    status: r.status,
    suggested_action: 'keep',
  }));
}

async function textFilterRows() {
  // Returns every atom matching the filter set, regardless of harmonic range
  // or category. Used during Phase 0.5 to verify manifest coverage end-to-end.
  const out = [];
  for (let i = 0; i < TEXT_FILTER.length; i += 80) {
    const chunk = TEXT_FILTER.slice(i, i + 80);
    const sql = `
      SELECT
        id, text, text_lower, category_slug,
        json_extract(harmonics, '$.weight') AS weight,
        register,
        status,
        harmonics IS NOT NULL AS has_harmonics,
        tag_version
      FROM atoms
      WHERE text_lower IN (${sqlList(chunk)})
      ORDER BY text_lower ASC
    `;
    const rows = await queryD1(sql);
    for (const r of rows) {
      out.push({
        id: r.id,
        text: r.text,
        text_lower: r.text_lower,
        current_category: r.category_slug,
        weight: r.weight,
        register: r.register,
        status: r.status,
        has_harmonics: r.has_harmonics === 1 || r.has_harmonics === true,
        tag_version: r.tag_version,
        suggested_action: 'keep',
      });
    }
  }
  return out;
}

async function registerSample() {
  const sql = `
    SELECT text, category_slug, register, harmonics
    FROM atoms
    WHERE status != 'rejected'
      AND register IS NOT NULL
      AND category_slug IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 10
  `;
  const rows = await queryD1(sql);
  return rows.map(r => ({
    text: r.text,
    category: r.category_slug,
    register: r.register,
    harmonics: r.harmonics,
  }));
}

async function missingTerms() {
  const check = TEXT_FILTER ?? SEED_TERMS.map(t => t.toLowerCase());
  const present = new Set();
  for (let i = 0; i < check.length; i += 80) {
    const chunk = check.slice(i, i + 80);
    const rows = await queryD1(`
      SELECT text_lower
      FROM atoms
      WHERE status != 'rejected'
        AND text_lower IN (${sqlList(chunk)})
    `);
    for (const r of rows) present.add(r.text_lower);
  }
  return check.map(term => ({
    term,
    present: present.has(term.toLowerCase()),
  }));
}

function markdownPreview(data) {
  const lines = [];
  lines.push('# Dimensional vocab audit (markdown preview)');
  lines.push('');
  lines.push(`Run: ${new Date().toISOString()}`);
  if (TEXT_FILTER) {
    lines.push(`Mode: text-filter (${TEXT_FILTER.length} slugs)`);
  } else {
    lines.push(`Mode: harmonic-range`);
    lines.push(`Candidate categories: ${CANDIDATE_CATEGORIES.join(', ')}`);
    lines.push(`Thresholds: light <= ${LIGHT_MAX}, heavy >= ${HEAVY_MIN}`);
  }
  lines.push('');

  if (TEXT_FILTER) {
    lines.push(`## Matched atoms (${data.body_light.length} of ${TEXT_FILTER.length} requested)`);
    for (const row of data.body_light) {
      const hh = row.has_harmonics ? '1' : '0';
      lines.push(`- ${row.text_lower}  w=${row.weight ?? '-'}  cat=${row.current_category}  reg=${row.register ?? '-'}  has_harmonics=${hh}  tv=${row.tag_version}`);
    }
    lines.push('');
  } else {
    lines.push(`## Candidate body-light (${data.body_light.length})`);
    for (const row of data.body_light.slice(0, 30)) {
      lines.push(`- ${row.text}  w=${row.weight}  cat=${row.current_category}  reg=${row.register ?? '-'}  ->  ${row.suggested_action}`);
    }
    if (data.body_light.length > 30) lines.push(`  ... and ${data.body_light.length - 30} more in JSON payload`);
    lines.push('');

    lines.push(`## Candidate body-heavy (${data.body_heavy.length})`);
    for (const row of data.body_heavy.slice(0, 30)) {
      lines.push(`- ${row.text}  w=${row.weight}  cat=${row.current_category}  reg=${row.register ?? '-'}  ->  ${row.suggested_action}`);
    }
    if (data.body_heavy.length > 30) lines.push(`  ... and ${data.body_heavy.length - 30} more in JSON payload`);
    lines.push('');
  }

  lines.push('## Register side-check (10 random atoms, observational only)');
  for (const row of data.register_sample) {
    lines.push(`- ${row.text}  cat=${row.category}  reg=${row.register}  harmonics=${row.harmonics}`);
  }
  lines.push('');

  const missingLabel = TEXT_FILTER ? 'Manifest terms' : 'Seed terms';
  lines.push(`## ${missingLabel}`);
  for (const row of data.missing) {
    lines.push(`- ${row.term}: ${row.present ? 'PRESENT' : 'MISSING'}`);
  }
  const missingCount = data.missing.filter(m => !m.present).length;
  lines.push('');
  const totalChecked = data.missing.length;
  lines.push(`Missing count: ${missingCount} of ${totalChecked}. These feed Phase 0.5.B (POST /discover for each).`);
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const [bodyLight, bodyHeavy, regSample, missing] = await Promise.all([
    candidates(LIGHT_MAX, 'light'),
    candidates(HEAVY_MIN, 'heavy'),
    registerSample(),
    missingTerms(),
  ]);

  const data = {
    run_at: new Date().toISOString(),
    mode: TEXT_FILTER ? 'text-filter' : 'harmonic-range',
    text_filter: TEXT_FILTER,
    thresholds: { light_max: LIGHT_MAX, heavy_min: HEAVY_MIN },
    candidate_categories: CANDIDATE_CATEGORIES,
    body_light: bodyLight,
    body_heavy: bodyHeavy,
    register_sample: regSample,
    missing: missing,
    counts: {
      body_light: bodyLight.length,
      body_heavy: bodyHeavy.length,
      missing: missing.filter(m => !m.present).length,
    },
  };

  console.error(markdownPreview(data));
  console.log(JSON.stringify(data, null, 2));
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
