// Manifest builder admin routes. Mounted at /admin/manifests in index.ts.
//
// POST /admin/manifests/build          — build all specs found under specs/manifests/
// POST /admin/manifests/build/:slug    — rebuild a single manifest by spec slug
// GET  /admin/manifests                — list built manifests (reads sidecar .meta.json files)
//
// Auth is applied by the root app.use('/admin/*', serviceTokenAuth) middleware.

import { Hono } from 'hono'
import type { Env } from '../types'
import { buildAllManifests, listBuiltManifests } from '../manifests'

export const manifestsApp = new Hono<{ Bindings: Env }>()

function r2Missing(): { error: string } {
  return { error: 'GRIMOIRE_R2 binding not configured' }
}

manifestsApp.post('/build', async (c) => {
  if (!c.env.GRIMOIRE_R2) return c.json(r2Missing(), 503)
  try {
    const result = await buildAllManifests(c.env)
    return c.json(result)
  } catch (err) {
    return c.json({ error: 'manifest build failed', detail: String(err) }, 500)
  }
})

manifestsApp.post('/build/:slug', async (c) => {
  if (!c.env.GRIMOIRE_R2) return c.json(r2Missing(), 503)
  const slug = c.req.param('slug')
  if (!slug) return c.json({ error: 'slug required' }, 400)
  try {
    const result = await buildAllManifests(c.env, [slug])
    if (result.manifests.length === 0) {
      const notFound = result.skipped.find(s => s.slug === slug && s.reason === 'spec not found')
      if (notFound) return c.json({ error: 'spec not found', slug }, 404)
    }
    return c.json(result)
  } catch (err) {
    return c.json({ error: 'manifest build failed', detail: String(err) }, 500)
  }
})

manifestsApp.get('/', async (c) => {
  if (!c.env.GRIMOIRE_R2) return c.json(r2Missing(), 503)
  try {
    const manifests = await listBuiltManifests(c.env.GRIMOIRE_R2)
    return c.json({ manifests })
  } catch (err) {
    return c.json({ error: 'listing failed', detail: String(err) }, 500)
  }
})
