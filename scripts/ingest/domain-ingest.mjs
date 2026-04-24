#!/usr/bin/env node
/**
 * Domain Vocabulary Ingestion
 *
 * Fetches Wikipedia pages for a given domain, extracts visual/material
 * vocabulary via Gemini Flash, deduplicates against D1, and bulk-inserts
 * via the Grimoire Worker REST API.
 *
 * Usage:
 *   node scripts/ingest/domain-ingest.mjs --domain mesoamerican [--dry-run]
 */

import { WORKER_URL, sleep } from './utils/env.mjs';
import { checkExistingAtoms, createDocument, createChunks } from './utils/d1.mjs';
import { fetchWikiPlaintext, chunkText } from './utils/wiki.mjs';
import { extractTerms } from './utils/gemini.mjs';
import { DOMAINS } from './domains.mjs';

// --- CLI ---

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] ? args[i + 1] : null; };
const hasFlag = (name) => args.includes(`--${name}`);

const DOMAIN_KEY = getArg('domain');
const DRY_RUN = hasFlag('dry-run');

if (!DOMAIN_KEY || !DOMAINS[DOMAIN_KEY]) {
  console.error('Usage: node scripts/ingest/domain-ingest.mjs --domain <key> [--dry-run]');
  console.error(`Available domains: ${Object.keys(DOMAINS).join(', ')}`);
  process.exit(1);
}

const domain = DOMAINS[DOMAIN_KEY];
console.log(`\n=== Domain Ingest: ${domain.label} ===`);
console.log(`Tag: ${domain.tag} | Source: ${domain.source_app} | Dry run: ${DRY_RUN}`);
console.log(`Pages: ${domain.pages.length}`);

// --- Main ---

async function main() {
  const allCandidates = [];
  const wikiPages = [];

  // Phase 1: Fetch and extract from each Wikipedia page
  for (const pageTitle of domain.pages) {
    console.log(`\n--- ${pageTitle} ---`);

    let wiki;
    try {
      wiki = await fetchWikiPlaintext(pageTitle);
      console.log(`  Fetched: "${wiki.title}" (${wiki.text.length} chars)`);
    } catch (err) {
      console.error(`  SKIP: ${err.message}`);
      continue;
    }

    if (wiki.text.length < 200) {
      console.log(`  SKIP: Too short (${wiki.text.length} chars)`);
      continue;
    }

    wikiPages.push(wiki);

    // Split into chunks for Gemini
    const chunks = chunkText(wiki.text, 3000);
    console.log(`  Chunks: ${chunks.length}`);

    let pageTotal = 0;
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Extracting chunk ${i + 1}/${chunks.length}...`);

      try {
        const terms = await extractTerms(chunks[i], domain.label, domain.collections);
        console.log(`    Got ${terms.length} terms`);
        allCandidates.push(...terms);
        pageTotal += terms.length;
      } catch (err) {
        console.error(`    Extract failed: ${err.message}`);
      }

      // Rate limit: 6s between Gemini calls
      if (i < chunks.length - 1) await sleep(6000);
    }

    console.log(`  Page total: ${pageTotal} terms`);

    // Rate limit between pages
    await sleep(2000);
  }

  console.log(`\n=== Extraction Complete ===`);
  console.log(`Raw candidates: ${allCandidates.length}`);

  // Phase 2: Local dedup (by lowercase text)
  const seen = new Map();
  for (const c of allCandidates) {
    const key = c.text.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, c);
    }
  }
  const unique = Array.from(seen.values());
  console.log(`After local dedup: ${unique.length} (removed ${allCandidates.length - unique.length} duplicates)`);

  // Phase 3: Dedup against D1
  console.log(`\nChecking existing atoms in D1...`);
  const textLowers = unique.map(c => c.text.toLowerCase().trim());
  const existing = await checkExistingAtoms(textLowers);
  console.log(`Found ${existing.size} already in database`);

  const newAtoms = unique.filter(c => !existing.has(c.text.toLowerCase().trim()));
  console.log(`New atoms to insert: ${newAtoms.length}`);

  if (DRY_RUN) {
    console.log(`\n=== DRY RUN: Would insert ${newAtoms.length} atoms ===`);
    // Show sample
    const sample = newAtoms.slice(0, 30);
    console.log('\nSample (first 30):');
    for (const a of sample) {
      console.log(`  [${a.collection_slug}] ${a.text}`);
    }

    // Show collection distribution
    const dist = {};
    for (const a of newAtoms) {
      dist[a.collection_slug] = (dist[a.collection_slug] || 0) + 1;
    }
    console.log('\nCollection distribution:');
    for (const [col, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${col}: ${count}`);
    }

    console.log(`\nWould create ${wikiPages.length} documents`);
    return;
  }

  // Phase 4: Insert via Worker /atoms/bulk
  console.log(`\nInserting atoms via Worker API...`);
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalRejected = 0;
  let totalErrors = 0;

  const BATCH_SIZE = 500;
  for (let i = 0; i < newAtoms.length; i += BATCH_SIZE) {
    const batch = newAtoms.slice(i, i + BATCH_SIZE);
    const payload = {
      atoms: batch.map(a => ({
        text: a.text,
        collection_slug: a.collection_slug,
        source: 'seed',
        source_app: domain.source_app,
        tags: [domain.tag],
      })),
    };

    try {
      const res = await fetch(`${WORKER_URL}/atoms/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${res.status} ${text.slice(0, 200)}`);
        totalErrors += batch.length;
        continue;
      }

      const result = await res.json();
      totalInserted += result.inserted || 0;
      totalDuplicates += result.duplicates || 0;
      totalRejected += result.rejected || 0;
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: inserted=${result.inserted}, dupes=${result.duplicates}, rejected=${result.rejected}, chunks=${result.chunks_created || 0}`);
    } catch (err) {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${err.message}`);
      totalErrors += batch.length;
    }

    await sleep(1000);
  }

  console.log(`\nInsertion complete: inserted=${totalInserted}, dupes=${totalDuplicates}, rejected=${totalRejected}, errors=${totalErrors}`);

  // Phase 5: Create documents for wiki pages
  console.log(`\nCreating documents for ${wikiPages.length} wiki pages...`);
  for (const wiki of wikiPages) {
    try {
      const docTitle = `Wikipedia: ${wiki.title}`;
      const docId = await createDocument(docTitle, `${domain.label} reference from ${wiki.url}`, domain.source_app);

      const textChunks = chunkText(wiki.text, 2000);
      const chunks = textChunks.map((content, i) => ({ content, order: i }));
      const created = await createChunks(docId, chunks);
      console.log(`  ${docTitle}: ${created} chunks`);
    } catch (err) {
      console.error(`  Document creation failed for "${wiki.title}": ${err.message}`);
    }
  }

  // Summary
  console.log(`\n=== ${DOMAIN_KEY} Complete ===`);
  console.log(`Atoms inserted: ${totalInserted}`);
  console.log(`Atoms skipped (duplicate): ${totalDuplicates}`);
  console.log(`Atoms rejected (content router): ${totalRejected}`);
  console.log(`Documents created: ${wikiPages.length}`);
  console.log(`\nAtoms are provisional. The 15-min cron will classify, vectorize, and tag them.`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
