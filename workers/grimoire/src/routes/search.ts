import { Hono } from 'hono'
import type { Env, SearchRequest } from '../types'
import { searchAtoms } from '../vectorize'

const app = new Hono<{ Bindings: Env }>()

app.post('/', async (c) => {
  try {
    const body = await c.req.json<SearchRequest>()
    const query = (body.query || '').trim()
    if (!query) {
      return c.json({ error: 'query is required' }, 400)
    }

    const results = await searchAtoms(query, c.env.AI, c.env.VECTORIZE, c.env.DB, {
      collection_slug: body.collection_slug,
      category_slug: body.category_slug,
      limit: body.limit,
    })

    return c.json({ results, query })
  } catch (error) {
    console.error('Error in /search:', error)
    return c.json({ error: 'Search failed' }, 500)
  }
})

app.post('/batch', async (c) => {
  try {
    const body = await c.req.json<{ query: string; categories?: string[]; limit?: number }>()
    const query = (body.query || '').trim()
    if (!query) {
      return c.json({ error: 'query is required' }, 400)
    }

    const results = await searchAtoms(query, c.env.AI, c.env.VECTORIZE, c.env.DB, {
      limit: body.limit ?? 200,
    })

    let mapped = results.map(r => ({
      id: r.atom.id,
      text: r.atom.text,
      category_slug: r.atom.category_slug,
      similarity: r.score,
      harmonics: r.atom.harmonics,
      tags: r.atom.tags,
    }))

    if (body.categories?.length) {
      mapped = mapped.filter(r => r.category_slug && body.categories!.includes(r.category_slug))
    }

    return c.json({ results: mapped, query })
  } catch (error) {
    console.error('Error in /search/batch:', error)
    return c.json({ error: 'Batch search failed' }, 500)
  }
})

export { app as searchRoutes }
