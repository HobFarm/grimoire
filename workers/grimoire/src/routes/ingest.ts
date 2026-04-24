import { Hono } from 'hono'
import type { Env, CreateAtomInput, IngestCsvRequest } from '../types'
import { bulkInsertAtoms } from '../atoms'

const app = new Hono<{ Bindings: Env }>()

app.post('/csv', async (c) => {
  try {
    const body = await c.req.json<IngestCsvRequest>()

    if (!body.rows || !Array.isArray(body.rows) || body.rows.length === 0) {
      return c.json({ error: 'rows array is required' }, 400)
    }
    if (!body.collection_slug) {
      return c.json({ error: 'collection_slug is required' }, 400)
    }
    if (!body.column_map?.text) {
      return c.json({ error: 'column_map.text is required' }, 400)
    }
    if (body.rows.length > 5000) {
      return c.json({ error: 'Maximum 5000 rows per request' }, 400)
    }

    const textCol = body.column_map.text
    const tagsCol = body.column_map.tags

    const atoms: CreateAtomInput[] = []
    let skipped = 0

    for (const row of body.rows) {
      const text = (row[textCol] || '').trim()
      if (!text) {
        skipped++
        continue
      }

      const tags: string[] = tagsCol && row[tagsCol]
        ? row[tagsCol].split(',').map(t => t.trim()).filter(Boolean)
        : []

      atoms.push({
        text,
        collection_slug: body.collection_slug,
        source: 'manual',
        source_app: body.source_app ?? 'csv-import',
        tags,
      })
    }

    const result = await bulkInsertAtoms(c.env.DB, atoms)

    return c.json({
      ...result,
      skipped,
      total_rows: body.rows.length,
    })
  } catch (error) {
    console.error('Error in /ingest/csv:', error)
    return c.json({ error: 'Ingest failed' }, 500)
  }
})

export { app as ingestRoutes }
