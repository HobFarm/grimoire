import { Hono } from 'hono'
import type {
  Env,
  AtomRow,
  ClassifyRequest,
  ClassifyBatchRequest,
  CreateAtomInput,
  UpdateAtomInput,
  SetRoutingInput,
  DiscoverRequest,
  DecomposeRequest,
  SearchRequest,
  IngestCsvRequest,
} from './types'
import { classifyText, ClassifyError } from './classify'
import { discoverSemanticBatch } from './correspondence'
import { getCacheStats, clearCache, clearCacheByCategory } from './cache'
import { listCategories, getCategoryContexts } from './db'
import {
  listCollections,
  getCollectionTree,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
} from './collections'
import {
  listAtoms,
  getAtom,
  createAtom,
  updateAtom,
  deleteAtom,
  bulkInsertAtoms,
  encounterAtom,
  listAtomsForReview,
  getAtomStats,
} from './atoms'
import {
  setRouting,
  getRoutingForApp,
  bulkSetRouting,
  deleteRouting,
} from './routing'
import { discoverAtom, decomposeAtom } from './suggest'
import { classifyAtom, classifyBatchProcess, classifyRegister } from './atom-classify'
import { vectorizeAtomBatch, vectorizeBatchProcess, searchAtoms } from './vectorize'
import { adminApp } from './admin'
import { invoke, InvokeError } from './invoke'
import { tagAllAtoms, tagNewAtoms } from './arrangement-tagger'

const app = new Hono<{ Bindings: Env }>()

// --- CORS Middleware ---

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') || ''
  const allowedRaw = c.env.ALLOWED_ORIGINS || ''
  const allowed = allowedRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  // Localhost only when no ALLOWED_ORIGINS set (local dev) or origin matches
  const isAllowed =
    allowed.length === 0
      ? origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')
      : allowed.includes(origin)

  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': isAllowed ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  await next()

  if (isAllowed) {
    c.header('Access-Control-Allow-Origin', origin)
  }
})

// --- Health ---

app.get('/health', (c) =>
  c.json({ status: 'ok', worker: 'grimoire', version: '2.0' })
)

// --- Classification (Phase 1) ---

app.post('/classify', async (c) => {
  try {
    const body = await c.req.json<ClassifyRequest>()
    const result = await classifyText(c.env, body)
    return c.json(result)
  } catch (error) {
    if (error instanceof ClassifyError) {
      return c.json(
        { error: error.message, ...(error.details ? { details: error.details } : {}) },
        error.status as 400 | 502 | 503
      )
    }
    console.error('Unexpected error in /classify:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.post('/classify/batch', async (c) => {
  try {
    const body = await c.req.json<ClassifyBatchRequest>()

    if (!body.items || body.items.length === 0) {
      return c.json({ error: 'items array is required' }, 400)
    }

    const results = await Promise.allSettled(
      body.items.map(item =>
        classifyText(c.env, {
          text: item.text,
          categories: item.categories,
          contexts: body.contexts,
          max_results: body.max_results_per_item,
        })
      )
    )

    return c.json(
      results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : {
              classifications: [],
              unclassified: [],
              context_used: [],
              error: r.reason instanceof Error ? r.reason.message : 'Unknown error',
            }
      )
    )
  } catch (error) {
    console.error('Unexpected error in /classify/batch:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// --- Categories (Phase 1) ---

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

// --- Cache Management (Phase 1) ---

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

// --- Atoms (static routes first) ---

app.get('/atoms/stats', async (c) => {
  const stats = await getAtomStats(c.env.DB)
  return c.json(stats)
})

app.get('/atoms/review', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const result = await listAtomsForReview(c.env.DB, limit, offset)
  return c.json(result)
})

// No inline classification on bulk imports: classifying N atoms would blow CPU limits.
// Atoms insert with null category_slug and '{}' harmonics; cron sweep catches them.
app.post('/atoms/bulk', async (c) => {
  try {
    const body = await c.req.json<{ atoms: CreateAtomInput[] }>()
    if (!body.atoms || body.atoms.length === 0) {
      return c.json({ error: 'atoms array is required' }, 400)
    }
    if (body.atoms.length > 5000) {
      return c.json({ error: 'Maximum 5000 atoms per bulk request' }, 400)
    }
    const result = await bulkInsertAtoms(c.env.DB, body.atoms)
    return c.json(result)
  } catch (error) {
    console.error('Error in bulk insert:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.post('/atoms/discover', async (c) => {
  try {
    const body = await c.req.json<DiscoverRequest>()
    const text = (body.text || '').trim()

    // Validation filters: reject terms that aren't atom-shaped
    if (text.length < 2 || text.length > 50) {
      return c.json({ atom: null, created: false, reason: 'invalid_length' })
    }
    if (text.split(/\s+/).length > 5) {
      return c.json({ atom: null, created: false, reason: 'too_complex' })
    }

    const result = await discoverAtom(c.env, body.text, body.source_app)
    if ('rejected' in result) {
      return c.json(result)
    }
    return c.json(result)
  } catch (error) {
    console.error('Error in /atoms/discover:', error)
    return c.json({ atom: null, created: false, reason: error instanceof Error ? error.message : 'classification_failed' })
  }
})

app.post('/atoms/decompose', async (c) => {
  const body = await c.req.json<DecomposeRequest>()
  if (!body.concept?.trim()) {
    return c.json({ error: 'concept is required' }, 400)
  }
  try {
    const result = await decomposeAtom(c.env, body.concept.trim(), body.source_app)
    return c.json(result)
  } catch (e) {
    console.error('Decompose error:', e)
    return c.json({ error: 'Classification failed', concept: body.concept }, 502)
  }
})

// --- Semantic Search ---

app.post('/search', async (c) => {
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

// --- CSV Ingest ---

app.post('/ingest/csv', async (c) => {
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

app.get('/atoms', async (c) => {
  const query = {
    collection_slug: c.req.query('collection_slug') || undefined,
    status: (c.req.query('status') as 'provisional' | 'confirmed' | 'rejected') || undefined,
    source: (c.req.query('source') as 'seed' | 'ai' | 'manual') || undefined,
    source_app: c.req.query('source_app') || undefined,
    q: c.req.query('q') || undefined,
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!) : undefined,
  }
  const result = await listAtoms(c.env.DB, query)
  return c.json(result)
})

app.post('/atoms', async (c) => {
  try {
    const body = await c.req.json<CreateAtomInput>()
    if (!body.text || !body.collection_slug || !body.source) {
      return c.json({ error: 'text, collection_slug, and source are required' }, 400)
    }
    const textLower = body.text.toLowerCase().trim()
    const classification = await classifyAtom(textLower, c.env.GEMINI_API_KEY)
    const atom = await createAtom(c.env.DB, {
      ...body,
      category_slug: classification?.category_slug ?? null,
      harmonics: classification ? JSON.stringify(classification.harmonics) : '{}',
      modality: classification?.modality ?? 'visual',
    })
    return c.json(atom, 201)
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return c.json({ error: 'Atom already exists in this collection' }, 409)
    }
    if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
      return c.json({ error: 'Invalid collection_slug' }, 400)
    }
    console.error('Error creating atom:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.get('/atoms/:id', async (c) => {
  const id = c.req.param('id')
  const atom = await getAtom(c.env.DB, id)
  if (!atom) return c.json({ error: 'Atom not found' }, 404)
  return c.json(atom)
})

app.put('/atoms/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<UpdateAtomInput>()
    const updated = await updateAtom(c.env.DB, id, body)
    if (!updated) return c.json({ error: 'Atom not found' }, 404)

    // Reclassify when text or collection changes
    if (body.text !== undefined || body.collection_slug !== undefined) {
      const classification = await classifyAtom(
        updated.text_lower,
        c.env.GEMINI_API_KEY
      )
      if (classification) {
        await c.env.DB.prepare(
          'UPDATE atoms SET category_slug = ?, harmonics = ?, modality = ? WHERE id = ?'
        ).bind(classification.category_slug, JSON.stringify(classification.harmonics), classification.modality, id).run()
        updated.category_slug = classification.category_slug
        updated.harmonics = JSON.stringify(classification.harmonics)
        updated.modality = classification.modality
      }
    }

    return c.json(updated)
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      return c.json({ error: 'Atom already exists in this collection' }, 409)
    }
    if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
      return c.json({ error: 'Invalid collection_slug' }, 400)
    }
    console.error('Error updating atom:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.patch('/atoms/:id/encounter', async (c) => {
  const id = c.req.param('id')
  const updated = await encounterAtom(c.env.DB, id)
  if (!updated) return c.json({ error: 'Atom not found' }, 404)
  return c.json(updated)
})

app.delete('/atoms/:id', async (c) => {
  const id = c.req.param('id')
  const deleted = await deleteAtom(c.env.DB, id)
  if (!deleted) return c.json({ error: 'Atom not found' }, 404)
  return c.json({ deleted: true })
})

// --- Routing ---

app.get('/routing/:app', async (c) => {
  const appName = c.req.param('app')
  const routing = c.req.query('routing') || undefined
  const results = await getRoutingForApp(c.env.DB, appName, routing)
  return c.json({ routing: results })
})

app.post('/routing', async (c) => {
  try {
    const body = await c.req.json<SetRoutingInput>()
    if (!body.atom_id || !body.app || !body.routing) {
      return c.json({ error: 'atom_id, app, and routing are required' }, 400)
    }
    const result = await setRouting(c.env.DB, body)
    return c.json(result, 201)
  } catch (error) {
    if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
      return c.json({ error: 'Invalid atom_id' }, 400)
    }
    console.error('Error setting routing:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.post('/routing/bulk', async (c) => {
  try {
    const body = await c.req.json<{ routes: SetRoutingInput[] }>()
    if (!body.routes || body.routes.length === 0) {
      return c.json({ error: 'routes array is required' }, 400)
    }
    const result = await bulkSetRouting(c.env.DB, body.routes)
    return c.json(result)
  } catch (error) {
    console.error('Error in bulk routing:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.delete('/routing/:atom_id/:app', async (c) => {
  const atomId = c.req.param('atom_id')
  const appName = c.req.param('app')
  const deleted = await deleteRouting(c.env.DB, atomId, appName)
  if (!deleted) return c.json({ error: 'Routing entry not found' }, 404)
  return c.json({ deleted: true })
})

// --- Invoke (prompt assembly engine) ---

app.post('/invoke', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.incantation) return c.json({ error: 'incantation slug is required' }, 400)
    if (body.modality && !['visual', 'narrative', 'both'].includes(body.modality)) {
      return c.json({ error: 'modality must be visual, narrative, or both' }, 400)
    }
    const result = await invoke(c.env, body)
    return c.json(result)
  } catch (error) {
    if (error instanceof InvokeError) return c.json({ error: error.message }, error.status as 400 | 404 | 500)
    console.error('Error in /invoke:', error)
    return c.json({ error: 'Invocation failed' }, 500)
  }
})

// --- Arrangement Tagging (one-shot bulk) ---

app.post('/admin/tag-arrangements', async (c) => {
  try {
    const batchSize = parseInt(c.req.query('batch_size') || '5000', 10)
    const result = await tagAllAtoms(c.env.DB, batchSize)
    return c.json(result)
  } catch (error) {
    console.error('Error in tag-arrangements:', error)
    return c.json({ error: 'Tagging failed' }, 500)
  }
})

// TODO: Add auth gating
app.route('/admin', adminApp)

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Budget tracker: Gemini API calls this tick (used to gate Phase 5)
    let geminiCalls = 0

    // Phase 1: Classify unclassified atoms
    try {
      const result = await classifyBatchProcess(env.DB, env.GEMINI_API_KEY, { limit: 200 })
      geminiCalls += result.geminiCalls
      if (result.classified > 0 || result.failed > 0) {
        console.log(`[cron] Phase 1: ${result.classified} classified, ${result.failed} failed`)
      }
    } catch (error) {
      console.error('[cron] Phase 1 error:', error)
    }

    // Phase 2: Vectorize pending atoms (only those already classified)
    try {
      const result = await vectorizeBatchProcess(env.DB, env.AI, env.VECTORIZE, { limit: 100 })
      if (result.vectorized > 0 || result.failed > 0) {
        console.log(`[cron] Phase 2: ${result.vectorized} vectorized, ${result.failed} failed`)
      }
    } catch (error) {
      console.error('[cron] Phase 2 error:', error)
    }

    // Phase 3: Enrich harmonics for atoms with categories but no harmonic profiles
    try {
      const harmonicRes = await env.DB.prepare(
        "SELECT id, text_lower, collection_slug FROM atoms WHERE category_slug IS NOT NULL AND (harmonics IS NULL OR harmonics = '{}' OR LENGTH(harmonics) <= 2) AND status != 'rejected' LIMIT 10"
      ).all()
      console.log(`[cron] Phase 3: ${harmonicRes.results.length} atoms to enrich`)

      if (harmonicRes.results.length > 0) {
        let enriched = 0
        for (const atom of harmonicRes.results) {
          geminiCalls += 2
          const classification = await classifyAtom(
            atom.text_lower as string,
            env.GEMINI_API_KEY
          )
          if (classification) {
            await env.DB.prepare(
              "UPDATE atoms SET harmonics = ?, modality = ?, updated_at = datetime('now') WHERE id = ?"
            ).bind(JSON.stringify(classification.harmonics), classification.modality, atom.id).run()
            enriched++
          }
        }
        console.log(`[cron] Phase 3 done: ${enriched}/${harmonicRes.results.length} enriched`)
      }
    } catch (error) {
      console.error('[cron] Phase 3 error:', error)
    }

    // Phase 4: Tag atoms with arrangement affiliations (incremental)
    try {
      const { tagged, scanned } = await tagNewAtoms(env.DB, 50)
      if (scanned > 0) {
        console.log(`[cron] Phase 4: ${tagged}/${scanned} atoms tagged with arrangements`)
      }
    } catch (error) {
      console.error('[cron] Phase 4 error:', error)
    }

    // Phase 5: Classify register dimension for newly classified atoms
    // Skip if previous phases consumed too many Gemini calls (RPM budget)
    // Threshold is generous because Phase 5 uses flash-lite (separate RPM quota from flash)
    if (geminiCalls >= 40) {
      console.log(`[cron] Phase 5: skipped (${geminiCalls} Gemini calls already this tick)`)
    } else {
      try {
        const registerRes = await env.DB.prepare(
          'SELECT id, text_lower, category_slug FROM atoms WHERE register IS NULL AND category_slug IS NOT NULL LIMIT 10'
        ).all<{ id: string; text_lower: string; category_slug: string }>()

        if (registerRes.results.length > 0) {
          let registerClassified = 0
          let registerErrors = 0
          for (const atom of registerRes.results) {
            if (registerClassified + registerErrors > 0) {
              await new Promise(r => setTimeout(r, 500))
            }
            const result = await classifyRegister(
              atom.text_lower,
              atom.category_slug,
              env.GEMINI_API_KEY
            )
            if ('register' in result) {
              await env.DB.prepare('UPDATE atoms SET register = ? WHERE id = ?')
                .bind(result.register, atom.id).run()
              registerClassified++
            } else {
              console.log(`[cron] Phase 5 fail: "${atom.text_lower.slice(0, 30)}" -> ${result.error}`)
              registerErrors++
            }
          }
          console.log(`[cron] Phase 5: ${registerClassified}/${registerRes.results.length} register-classified, ${registerErrors} errors`)
        }
      } catch (error) {
        console.error('[cron] Phase 5 error:', error)
      }
    }

    // Phase 6: Discover semantic correspondences for atoms without any
    try {
      const needCorrs = await env.DB.prepare(`
        SELECT a.id, a.text_lower, a.category_slug FROM atoms a
        WHERE a.embedding_status = 'complete'
          AND a.category_slug IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM correspondences c
            WHERE (c.atom_a_id = a.id OR c.atom_b_id = a.id)
              AND c.provenance = 'semantic'
          )
        ORDER BY a.id LIMIT 200
      `).all<{ id: string; text_lower: string; category_slug: string }>()

      if (needCorrs.results.length > 0) {
        const { inserted } = await discoverSemanticBatch(env.DB, env.VECTORIZE, needCorrs.results)
        console.log(`[cron] Phase 6: ${needCorrs.results.length} atoms, ${inserted} correspondences`)
      }
    } catch (error) {
      console.error('[cron] Phase 6 error:', error)
    }
  },
}
