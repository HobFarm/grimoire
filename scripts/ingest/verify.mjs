#!/usr/bin/env node
/**
 * Verification script for ingestion pipeline.
 * Queries D1 directly to check atom counts, distribution, and coverage.
 *
 * Usage:
 *   node scripts/ingest/verify.mjs [--domain mesoamerican]
 */

import { queryD1 } from './utils/d1.mjs';
import './utils/env.mjs'; // trigger .env load

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] ? args[i + 1] : null; };
const domainFilter = getArg('domain');

async function main() {
  console.log('=== Grimoire Verification ===\n');

  // 1. Total atom counts by status
  console.log('--- Atom Counts by Status ---');
  const statusRows = await queryD1(`SELECT status, COUNT(*) as cnt FROM atoms GROUP BY status ORDER BY cnt DESC`);
  for (const row of statusRows) {
    console.log(`  ${row.status}: ${row.cnt.toLocaleString()}`);
  }

  // 2. Atoms by source_app (wiki-* sources)
  console.log('\n--- Wiki Ingest Sources ---');
  const sourceRows = await queryD1(`SELECT source_app, COUNT(*) as cnt FROM atoms WHERE source_app LIKE 'wiki-%' GROUP BY source_app ORDER BY cnt DESC`);
  if (sourceRows.length === 0) {
    console.log('  (none found)');
  } else {
    for (const row of sourceRows) {
      console.log(`  ${row.source_app}: ${row.cnt}`);
    }
  }

  // 3. Atoms by tag (search tags JSON column)
  if (domainFilter) {
    console.log(`\n--- Atoms Tagged "${domainFilter}" ---`);
    const tagRows = await queryD1(`SELECT COUNT(*) as cnt FROM atoms WHERE tags LIKE '%${domainFilter}%'`);
    console.log(`  ${domainFilter}: ${tagRows[0]?.cnt || 0}`);
  }

  // 4. Domain category distribution
  console.log('\n--- Domain Category Distribution ---');
  const domainCatRows = await queryD1(`SELECT category_slug, COUNT(*) as cnt FROM atoms WHERE category_slug LIKE 'domain.%' GROUP BY category_slug ORDER BY cnt DESC`);
  if (domainCatRows.length === 0) {
    console.log('  (no domain.* categories yet)');
  } else {
    for (const row of domainCatRows) {
      console.log(`  ${row.category_slug}: ${row.cnt}`);
    }
  }

  // 5. Arrangement context coverage
  console.log('\n--- Arrangement Context Coverage ---');
  const ctxRows = await queryD1(`
    SELECT a.slug, a.name, COUNT(cc.context) as ctx
    FROM arrangements a
    LEFT JOIN category_contexts cc ON cc.context = a.slug
    GROUP BY a.slug
    ORDER BY ctx ASC
  `);
  const underCovered = ctxRows.filter(r => r.ctx < 10);
  console.log(`  Total arrangements: ${ctxRows.length}`);
  if (underCovered.length > 0) {
    console.log(`  Under-covered (< 10 contexts):`);
    for (const row of underCovered) {
      console.log(`    ${row.slug}: ${row.ctx} contexts`);
    }
  } else {
    console.log('  All arrangements have >= 10 contexts');
  }

  // 6. Document and chunk counts
  console.log('\n--- Documents & Chunks ---');
  const docRows = await queryD1(`SELECT COUNT(*) as cnt FROM documents`);
  const chunkRows = await queryD1(`SELECT COUNT(*) as cnt FROM document_chunks`);
  console.log(`  Documents: ${docRows[0]?.cnt || 0}`);
  console.log(`  Chunks: ${chunkRows[0]?.cnt || 0}`);

  // 7. Atoms pending classification
  console.log('\n--- Pending Classification ---');
  const pendingRows = await queryD1(`SELECT COUNT(*) as cnt FROM atoms WHERE category_slug IS NULL OR category_slug = ''`);
  console.log(`  Unclassified atoms: ${pendingRows[0]?.cnt || 0}`);

  // 8. Atoms pending vectorization
  const vecPendingRows = await queryD1(`SELECT embedding_status, COUNT(*) as cnt FROM atoms WHERE status = 'provisional' GROUP BY embedding_status`);
  if (vecPendingRows.length > 0) {
    console.log('\n--- Provisional Atom Embedding Status ---');
    for (const row of vecPendingRows) {
      console.log(`  ${row.embedding_status}: ${row.cnt}`);
    }
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
