import type { Hono } from 'hono'
import type { Env } from '../types'
import { listCategories, getCategoryContexts } from '../db'
import { getCacheStats, clearCache, clearCacheByCategory } from '../cache'
import {
  listCollections,
  getCollectionTree,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
} from '../collections'

/**
 * Register taxonomy routes (categories, cache, collections, arrangements).
 * Uses a register function instead of a sub-app because routes span multiple prefixes.
 */
export function registerTaxonomyRoutes(app: Hono<{ Bindings: Env }>) {
  // --- Categories ---

  app.get('/categories', async (c) => {
    const parent = c.req.query('parent')
    const categories = await listCategories(c.env.DB, parent || undefined)
    return c.json({ categories })
  })

  app.get('/categories/:slug/contexts', async (c) => {
    const slug = c.req.param('slug')
    const contextFilter = c.req.query('context')
    const contexts = await getCategoryContexts(c.env.DB, slug, contextFilter || undefined)
    return c.json({ slug, contexts })
  })

  // --- Cache ---

  app.get('/cache/stats', async (c) => {
    const stats = await getCacheStats(c.env.DB)
    return c.json(stats)
  })

  app.delete('/cache', async (c) => {
    const result = await clearCache(c.env.DB)
    return c.json(result)
  })

  app.delete('/cache/:slug', async (c) => {
    const slug = c.req.param('slug')
    const result = await clearCacheByCategory(c.env.DB, slug)
    return c.json(result)
  })

  // --- Collections ---

  app.get('/collections', async (c) => {
    const collections = await listCollections(c.env.DB)
    return c.json({ collections })
  })

  app.get('/collections/tree', async (c) => {
    const tree = await getCollectionTree(c.env.DB)
    return c.json({ tree })
  })

  app.post('/collections', async (c) => {
    try {
      const body = await c.req.json<{ slug: string; name: string; description?: string; parent_slug?: string }>()
      if (!body.slug || !body.name) {
        return c.json({ error: 'slug and name are required' }, 400)
      }
      const collection = await createCollection(c.env.DB, body)
      return c.json(collection, 201)
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        return c.json({ error: 'Collection slug already exists' }, 409)
      }
      console.error('Error creating collection:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  app.get('/collections/:slug', async (c) => {
    const slug = c.req.param('slug')
    const collection = await getCollection(c.env.DB, slug)
    if (!collection) return c.json({ error: 'Collection not found' }, 404)
    return c.json(collection)
  })

  app.put('/collections/:slug', async (c) => {
    const slug = c.req.param('slug')
    const body = await c.req.json<{ name?: string; description?: string; parent_slug?: string | null }>()
    const updated = await updateCollection(c.env.DB, slug, body)
    if (!updated) return c.json({ error: 'Collection not found' }, 404)
    return c.json(updated)
  })

  app.delete('/collections/:slug', async (c) => {
    try {
      const slug = c.req.param('slug')
      const deleted = await deleteCollection(c.env.DB, slug)
      if (!deleted) return c.json({ error: 'Collection not found' }, 404)
      return c.json({ deleted: true })
    } catch (error) {
      if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
        return c.json({ error: 'Cannot delete collection with atoms referencing it' }, 409)
      }
      console.error('Error deleting collection:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // --- Arrangements ---

  app.get('/arrangements', async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT slug, name, harmonics, context_key FROM arrangements ORDER BY slug'
    ).all()
    return c.json(rows.results)
  })

  app.get('/arrangements/:slug', async (c) => {
    const slug = c.req.param('slug')
    const arr = await c.env.DB.prepare(
      'SELECT slug, name, harmonics, context_key FROM arrangements WHERE slug = ?'
    ).bind(slug).first()
    if (!arr) return c.json({ error: 'not found' }, 404)

    const contexts = await c.env.DB.prepare(
      'SELECT category_slug, guidance, context_mode FROM category_contexts WHERE context = ?'
    ).bind(arr.context_key).all()

    return c.json({ ...arr, contexts: contexts.results })
  })
}
