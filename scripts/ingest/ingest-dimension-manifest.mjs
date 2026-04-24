#!/usr/bin/env node
/**
 * Ingest a dimension-membership manifest.
 *
 * Parses a text manifest (one atom slug per line, # comments allowed), POSTs
 * the slug list to the grimoire worker's /admin/dimension/ingest-manifest
 * endpoint, and prints the response. Dry-run by default.
 *
 * Usage:
 *   node scripts/ingest/ingest-dimension-manifest.mjs \
 *     --axis body-mass \
 *     --pole low \
 *     --source manifests/body-mass-light.txt \
 *     [--file <path>]              # defaults to same path as --source, resolved under scripts/ingest/
 *     [--category-filter <slug>]   # scopes atom resolution to atoms.category_slug = <slug>
 *     [--execute]                  # disables dry_run
 *
 * Env:
 *   HOBBOT_SERVICE_TOKEN (required)
 *
 * Exit codes:
 *   0 on success (dry-run or execute)
 *   1 on validation / parse / network error
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { WORKER_URL } from './utils/env.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const has = (name) => args.includes(`--${name}`);
  return {
    axis: get('axis'),
    pole: get('pole'),
    source: get('source'),
    file: get('file'),
    categoryFilter: get('category-filter'),
    execute: has('execute'),
  };
}

function parseManifest(path) {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const slugs = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    slugs.push(trimmed.toLowerCase());
  }
  return [...new Set(slugs)];
}

function getServiceToken() {
  const token = process.env.HOBBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error('HOBBOT_SERVICE_TOKEN not set in .env or environment');
  }
  return token;
}

async function postManifest({ axis, pole, source, slugs, dryRun, categoryFilter }) {
  const payload = {
    axis_slug: axis,
    pole,
    source,
    atom_slugs: slugs,
    dry_run: dryRun,
  };
  if (categoryFilter) payload.category_filter = categoryFilter;

  const res = await fetch(`${WORKER_URL}/admin/dimension/ingest-manifest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getServiceToken()}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`ingest-manifest -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  const flags = parseArgs();
  if (!flags.axis) throw new Error('Missing --axis');
  if (flags.pole !== 'low' && flags.pole !== 'high') {
    throw new Error("Missing or invalid --pole (must be 'low' or 'high')");
  }
  if (!flags.source) throw new Error('Missing --source');

  const manifestPath = flags.file
    ? resolve(process.cwd(), flags.file)
    : resolve(__dirname, flags.source);

  const slugs = parseManifest(manifestPath);
  if (slugs.length === 0) {
    throw new Error(`Manifest parsed to 0 atom slugs: ${manifestPath}`);
  }

  const dryRun = !flags.execute;

  console.error(`[ingest-manifest] axis=${flags.axis} pole=${flags.pole} source=${flags.source}`);
  console.error(`[ingest-manifest] file=${manifestPath}  slugs=${slugs.length}  dry_run=${dryRun}  category_filter=${flags.categoryFilter ?? '-'}`);

  const data = await postManifest({
    axis: flags.axis,
    pole: flags.pole,
    source: flags.source,
    slugs,
    dryRun,
    categoryFilter: flags.categoryFilter,
  });

  console.log(JSON.stringify(data, null, 2));

  // Summary to stderr so stdout stays machine-parseable.
  const lines = [];
  if (dryRun) {
    lines.push(`[ingest-manifest] would_insert=${data.would_insert ?? 0}`);
  } else {
    lines.push(`[ingest-manifest] inserted=${data.inserted ?? 0}`);
  }
  lines.push(`[ingest-manifest] already_present=${data.already_present ?? 0}`);
  lines.push(`[ingest-manifest] conflicts=${(data.conflicts ?? []).length}`);
  lines.push(`[ingest-manifest] missing=${(data.missing ?? []).length}`);
  if ((data.conflicts ?? []).length) {
    lines.push(`[ingest-manifest] conflict slugs: ${data.conflicts.map(c => c.text_lower).join(', ')}`);
  }
  if ((data.missing ?? []).length) {
    lines.push(`[ingest-manifest] missing slugs: ${data.missing.join(', ')}`);
  }
  console.error(lines.join('\n'));
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
