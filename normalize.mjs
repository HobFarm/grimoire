// normalize.mjs
// Run this on the atom list BEFORE classification to catch data quality issues.
// Usage: import { normalizeAtoms } from './normalize.mjs'

/**
 * Normalize a single atom text string.
 * Returns null if the atom should be skipped entirely.
 */
export function normalizeText(text) {
  if (!text || typeof text !== 'string') return null;

  let t = text.trim();

  // Skip empty
  if (t.length === 0) return null;

  // Strip leading/trailing punctuation (quotes, brackets, etc.)
  t = t.replace(/^[\s"'`[\](){}]+|[\s"'`[\](){}]+$/g, '').trim();

  // Collapse multiple spaces
  t = t.replace(/\s+/g, ' ');

  // Skip if too short after cleanup
  if (t.length < 2) return null;

  // Skip if it's just numbers
  if (/^\d+$/.test(t)) return null;

  // Skip if it's a URL or path
  if (/^https?:\/\/|^\/|^\\/.test(t)) return null;

  // Normalize unicode quotes to ASCII
  t = t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  // Cap length (anything over 200 chars is probably a sentence, not an atom)
  if (t.length > 200) return null;

  return t;
}

/**
 * Process an array of raw atom objects, normalizing text and deduplicating.
 * Input: [{ text: "  elegant  ", collection: "style" }, ...]
 * Output: [{ text: "elegant", collection: "style" }, ...]
 */
export function normalizeAtoms(atoms) {
  const results = [];
  const seen = new Set();
  let skipped = 0;
  let deduped = 0;

  for (const atom of atoms) {
    const isString = typeof atom === 'string';
    const rawText = isString ? atom : atom.text;
    const normalized = normalizeText(rawText);

    if (normalized === null) {
      skipped++;
      continue;
    }

    // Normal atom
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      deduped++;
      continue;
    }
    seen.add(key);
    results.push(isString ? normalized : { ...atom, text: normalized });
  }

  return {
    atoms: results,
    stats: {
      input: atoms.length,
      output: results.length,
      skipped,
      deduped,
    }
  };
}

// CLI test mode
if (process.argv[1]?.endsWith('normalize.mjs') && process.argv[2] === '--test') {
  const testCases = [
    'gothic architecture',
    '  "elegant"  ',
    '',
    '42',
    'https://example.com',
    'rain-slicked highway reflecting sodium vapor lights',
    'tudor architecture',
    'a'.repeat(250),
    'normal term',
    'normal term',  // duplicate
  ];

  console.log('Normalization test:');
  for (const t of testCases) {
    console.log(`  "${t}" -> ${JSON.stringify(normalizeText(t))}`);
  }

  console.log('\nBatch test:');
  const batch = normalizeAtoms(testCases.map(t => ({ text: t, collection: 'test' })));
  console.log(`  Stats: ${JSON.stringify(batch.stats)}`);
  console.log(`  Atoms: ${batch.atoms.map(a => a.text).join(', ')}`);
}
