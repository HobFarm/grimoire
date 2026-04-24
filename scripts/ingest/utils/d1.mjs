/**
 * D1 REST API helpers for ingestion scripts.
 * Pattern from batch-process.mjs:508-529
 */

import { D1_API, getCfToken } from './env.mjs';
import { randomUUID } from 'node:crypto';

let _cfToken = null;
function cfToken() {
  if (!_cfToken) _cfToken = getCfToken();
  return _cfToken;
}

export async function queryD1(sql) {
  const res = await fetch(D1_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors).slice(0, 500)}`);
  }

  return data.result[0].results;
}

/**
 * Check which atom texts already exist in the database.
 * Batches queries in groups of 200 to stay within SQL limits.
 * Returns Set of existing text_lower values.
 */
export async function checkExistingAtoms(textLowerArray) {
  const existing = new Set();
  const BATCH = 200;

  for (let i = 0; i < textLowerArray.length; i += BATCH) {
    const chunk = textLowerArray.slice(i, i + BATCH);
    const placeholders = chunk.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
    const sql = `SELECT text_lower FROM atoms WHERE text_lower IN (${placeholders})`;

    try {
      const rows = await queryD1(sql);
      for (const row of rows) {
        existing.add(row.text_lower);
      }
    } catch (err) {
      console.error(`  [dedup] Batch query failed (offset ${i}): ${err.message}`);
    }
  }

  return existing;
}

/**
 * Create a document record in D1.
 * Returns the document ID.
 */
export async function createDocument(title, description, sourceApp) {
  const id = randomUUID();
  const sql = `INSERT OR IGNORE INTO documents (id, title, description, mime_type, source_app, chunk_count, status, created_at, updated_at)
    VALUES ('${id}', '${title.replace(/'/g, "''")}', '${(description || '').replace(/'/g, "''")}', 'text/plain', '${sourceApp || ''}', 0, 'pending', datetime('now'), datetime('now'))`;
  await queryD1(sql);

  // Return the ID (might be existing doc if title matched)
  const rows = await queryD1(`SELECT id FROM documents WHERE title = '${title.replace(/'/g, "''")}'`);
  return rows[0]?.id || id;
}

/**
 * Create document chunks in D1.
 * chunks: Array<{ content: string, order: number }>
 */
export async function createChunks(docId, chunks) {
  let created = 0;

  for (const chunk of chunks) {
    const id = randomUUID();
    const content = chunk.content.replace(/'/g, "''").slice(0, 4000);
    const sql = `INSERT INTO document_chunks (id, document_id, content, chunk_index, created_at)
      VALUES ('${id}', '${docId}', '${content}', ${chunk.order}, datetime('now'))`;

    try {
      await queryD1(sql);
      created++;
    } catch (err) {
      // Likely duplicate or constraint error, skip
      if (!err.message.includes('UNIQUE')) {
        console.error(`  [chunk] Insert failed: ${err.message.slice(0, 200)}`);
      }
    }
  }

  // Update chunk count
  await queryD1(`UPDATE documents SET chunk_count = (SELECT COUNT(*) FROM document_chunks WHERE document_id = '${docId}') WHERE id = '${docId}'`);

  return created;
}
