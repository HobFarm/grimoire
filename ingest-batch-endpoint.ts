// ADD THIS ENDPOINT TO src/admin.ts
// Place after existing admin routes (vectorize-batch, classify-batch, status)
//
// POST /admin/ingest-batch
// Bulk insert atoms with optional pre-classification.
// Body: { atoms: [{ text: string, collection_slug: string, category_slug?: string }] }
// Response: { inserted: number, skipped: number, total: number }

adminApp.post('/ingest-batch', async (c) => {
  const { atoms } = await c.req.json()
  if (!Array.isArray(atoms) || atoms.length === 0) {
    return c.json({ error: 'atoms array required' }, 400)
  }

  const db = c.env.DB
  const limit = Math.min(atoms.length, 1000)
  const batch = atoms.slice(0, limit)

  let inserted = 0
  let skipped = 0

  // Process in chunks of 50 for D1 batch efficiency
  const CHUNK = 50
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK)
    const stmts = []

    for (const atom of chunk) {
      const text = (atom.text || '').trim()
      const collection = (atom.collection_slug || 'uncategorized').trim()
      const category = atom.category_slug ? atom.category_slug.trim() : null
      if (!text || text.length > 500) continue

      if (category) {
        // Pre-classified: insert with category
        stmts.push(
          db.prepare(
            `INSERT INTO atoms (text, collection_slug, category_slug, embedding_status, created_at)
             SELECT ?, ?, ?, 'pending', datetime('now')
             WHERE NOT EXISTS (
               SELECT 1 FROM atoms WHERE text = ? AND collection_slug = ?
             )`
          ).bind(text, collection, category, text, collection)
        )
      } else {
        // Unclassified: insert without category (classify-batch will handle later)
        stmts.push(
          db.prepare(
            `INSERT INTO atoms (text, collection_slug, embedding_status, created_at)
             SELECT ?, ?, 'pending', datetime('now')
             WHERE NOT EXISTS (
               SELECT 1 FROM atoms WHERE text = ? AND collection_slug = ?
             )`
          ).bind(text, collection, text, collection)
        )
      }
    }

    if (stmts.length > 0) {
      const results = await db.batch(stmts)
      for (const r of results) {
        if (r.meta?.changes > 0) inserted++
        else skipped++
      }
    }
  }

  return c.json({
    inserted,
    skipped,
    total: batch.length,
    remaining: Math.max(0, atoms.length - limit),
  })
})
