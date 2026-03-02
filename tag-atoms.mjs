#!/usr/bin/env node
// tag-atoms.mjs - Tag atoms with matching arrangement slugs based on harmonic similarity
// Usage: node tag-atoms.mjs [--dry-run] [--batch-size 500]
// Requires: CF_API_TOKEN env var

const ACCOUNT_ID = 'e343cbfa70c5166f00d871e513ae352a';
const DATABASE_ID = '3cb1cdee-17af-477c-ab0a-5a18447948ef';
const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

const DIMS = ['hardness', 'temperature', 'weight', 'formality', 'era_affinity'];
const THRESHOLD = 0.50;

// ─── D1 Access ────────────────────────────────────────────────────────────────

async function queryD1(sql, cfToken, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
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
        if (res.status >= 500 && attempt < retries) {
          console.warn(`  D1 ${res.status} on attempt ${attempt}/${retries}, retrying in ${attempt}s...`);
          await new Promise(r => setTimeout(r, attempt * 1000));
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
      if (attempt < retries && (err.cause?.code === 'UND_ERR_SOCKET' || err.message === 'fetch failed')) {
        console.warn(`  Network error on attempt ${attempt}/${retries}, retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }
      throw err;
    }
  }
}

// ─── Harmonic Similarity ──────────────────────────────────────────────────────

function harmonicSimilarity(a, b) {
  let score = 0;
  for (const dim of DIMS) {
    if (a[dim] === b[dim]) score += 1.0;
    else if (a[dim] === 'neutral' || b[dim] === 'neutral') score += 0.5;
  }
  return score / DIMS.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bsIdx = args.indexOf('--batch-size');
  const BATCH_SIZE = bsIdx !== -1 ? parseInt(args[bsIdx + 1], 10) : 500;

  const cfToken = process.env.CF_API_TOKEN;
  if (!cfToken) {
    console.error('Error: CF_API_TOKEN not set');
    console.error('  PowerShell: $env:CF_API_TOKEN = "your-token"');
    process.exit(1);
  }

  // 1. Load arrangements
  console.log('Loading arrangements...');
  const rawArrangements = await queryD1('SELECT slug, harmonics FROM arrangements', cfToken);
  const arrangements = rawArrangements.map(a => ({
    slug: a.slug,
    harmonics: JSON.parse(a.harmonics),
  }));
  console.log(`Loaded ${arrangements.length} arrangements: ${arrangements.map(a => a.slug).join(', ')}`);

  // 2. Process untagged atoms in batches (cursor-based to avoid re-selecting 0-match atoms)
  let totalProcessed = 0;
  let batchNum = 0;
  let cursor = '';
  const startTime = Date.now();

  while (true) {
    batchNum++;
    const cursorClause = cursor ? `AND id > '${cursor}'` : '';
    const atoms = await queryD1(
      `SELECT id, harmonics FROM atoms WHERE (tags IS NULL OR tags = '[]') AND status != 'rejected' AND harmonics IS NOT NULL ${cursorClause} ORDER BY id ASC LIMIT ${BATCH_SIZE}`,
      cfToken
    );

    if (atoms.length === 0) break;
    cursor = atoms[atoms.length - 1].id;

    // 3. Compute tags for each atom
    const updates = [];
    for (const atom of atoms) {
      let profile;
      try {
        profile = JSON.parse(atom.harmonics);
      } catch {
        continue;
      }

      const matchedSlugs = [];
      for (const arr of arrangements) {
        if (harmonicSimilarity(profile, arr.harmonics) >= THRESHOLD) {
          matchedSlugs.push(arr.slug);
        }
      }

      updates.push({ id: atom.id, tags: JSON.stringify(matchedSlugs) });
    }

    if (updates.length === 0) {
      totalProcessed += atoms.length;
      continue;
    }

    // 4. Batch write using CASE/WHEN
    if (!dryRun) {
      const caseClauses = updates.map(u => {
        const escapedTags = u.tags.replace(/'/g, "''");
        return `WHEN '${u.id}' THEN '${escapedTags}'`;
      });
      const idList = updates.map(u => `'${u.id}'`).join(',');

      const sql = `UPDATE atoms SET tags = CASE id ${caseClauses.join(' ')} END, updated_at = datetime('now') WHERE id IN (${idList})`;

      await queryD1(sql, cfToken);
    }

    totalProcessed += atoms.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (totalProcessed / (elapsed || 1)).toFixed(0);
    console.log(`Batch ${batchNum}: tagged ${atoms.length} atoms (total: ${totalProcessed}, ${elapsed}s, ${rate}/s)${dryRun ? ' [dry-run]' : ''}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. Tagged ${totalProcessed} atoms in ${elapsed}s.`);

  // 5. Verification
  if (!dryRun && totalProcessed > 0) {
    console.log('\n--- Verification ---');

    const remaining = await queryD1(
      `SELECT COUNT(*) as cnt FROM atoms WHERE (tags IS NULL OR tags = '[]') AND status != 'rejected' AND harmonics IS NOT NULL`,
      cfToken
    );
    console.log(`Untagged atoms remaining: ${remaining[0].cnt}`);

    const stats = await queryD1(
      `SELECT ROUND(AVG(json_array_length(tags)),1) as avg_arr, MIN(json_array_length(tags)) as min_arr, MAX(json_array_length(tags)) as max_arr FROM atoms WHERE tags IS NOT NULL AND tags != '[]'`,
      cfToken
    );
    console.log(`Arrangements per atom: avg=${stats[0].avg_arr}, min=${stats[0].min_arr}, max=${stats[0].max_arr}`);

    const sample = await queryD1(
      `SELECT text, tags FROM atoms WHERE tags IS NOT NULL AND tags != '[]' ORDER BY RANDOM() LIMIT 5`,
      cfToken
    );
    console.log('\nSample:');
    for (const row of sample) {
      console.log(`  "${row.text}" -> ${row.tags}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
