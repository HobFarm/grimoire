import { Hono } from 'hono'
import type { Env, CreateAtomInput, UpdateAtomInput, DiscoverRequest, DecomposeRequest } from '../types'
import {
  listAtoms,
  getAtom,
  createAtomWithHooks,
  updateAtom,
  deleteAtom,
  bulkInsertAtomsWithHooks,
  encounterAtomWithHooks,
  listAtomsForReview,
  getAtomStats,
  generateId,
} from '../atoms'
import { discoverAtom, decomposeAtom } from '../suggest'
import { classifyAtom, extractMetadataContext } from '../atom-classify'
import { buildModelContext } from '../models'
import { getCategoryMetadata } from '../db'
import { routeContent } from '../content-router'
import { qualityGate, qualityGateBatch } from '../quality-gate'
import type { QualityGateInput } from '../quality-gate'

const app = new Hono<{ Bindings: Env }>()

// Static routes first (before /:id param routes)

app.get('/stats', async (c) => {
  const stats = await getAtomStats(c.env.DB)
  return c.json(stats)
})

app.get('/review', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const result = await listAtomsForReview(c.env.DB, limit, offset)
  return c.json(result)
})

// Bulk insert with content routing
app.post('/bulk', async (c) => {
  try {
    const body = await c.req.json<{ atoms: CreateAtomInput[] }>()
    if (!body.atoms || body.atoms.length === 0) {
      return c.json({ error: 'atoms array is required' }, 400)
    }
    if (body.atoms.length > 5000) {
      return c.json({ error: 'Maximum 5000 atoms per bulk request' }, 400)
    }

    const validAtoms: CreateAtomInput[] = []
    let rejected = 0
    let gateRejected = 0
    let gateFlagged = 0
    const chunksByDoc = new Map<string, Array<{ text: string; category?: string; tags?: string[] }>>()

    for (const atom of body.atoms) {
      const text = (atom.text || '').trim()
      const route = routeContent(text, atom.collection_slug)

      if (route.destination === 'atom') {
        validAtoms.push(atom)
      } else if (route.destination === 'document_chunk') {
        const docTitle = route.suggested_document || 'Uncategorized Knowledge'
        if (!chunksByDoc.has(docTitle)) chunksByDoc.set(docTitle, [])
        chunksByDoc.get(docTitle)!.push({
          text,
          category: atom.collection_slug,
          tags: route.suggested_tags,
        })
      } else {
        rejected++
      }
    }

    // Quality gate batch: filter valid atoms through specificity + redundancy checks
    const ctx = await buildModelContext(c.env)
    const gateInputs: QualityGateInput[] = validAtoms.map(a => ({
      text: a.text, source: a.source, source_app: a.source_app, metadata: a.metadata,
    }))
    const gateResults = await qualityGateBatch(gateInputs, ctx, c.env.AI, c.env.VECTORIZE, c.env.DB)
    const gatedAtoms = validAtoms.filter((_, i) => gateResults[i]?.pass)
    gateRejected = validAtoms.length - gatedAtoms.length
    gateFlagged = gateResults.filter(r => r?.flagged_for_review).length

    const result = await bulkInsertAtomsWithHooks(c.env, gatedAtoms)

    let chunksCreated = 0
    for (const [docTitle, chunks] of chunksByDoc) {
      let doc = await c.env.DB.prepare(
        'SELECT id, chunk_count FROM documents WHERE title = ? LIMIT 1'
      ).bind(docTitle).first<{ id: string; chunk_count: number }>()

      if (!doc) {
        const docId = generateId()
        const tags = chunks[0]?.tags ? JSON.stringify(chunks[0].tags) : '[]'
        await c.env.DB.prepare(
          `INSERT INTO documents (id, title, description, mime_type, tags, chunk_count, status, source_app, created_at, updated_at)
           VALUES (?, ?, ?, 'text/plain', ?, 0, 'chunked', 'content-router', datetime('now'), datetime('now'))`
        ).bind(docId, docTitle, `Auto-routed content: ${docTitle}`, tags).run()
        doc = { id: docId, chunk_count: 0 }
      }

      for (let i = 0; i < chunks.length; i += 50) {
        const batch = chunks.slice(i, i + 50)
        const chunkIds: string[] = []
        const stmts = batch.map((chunk, idx) => {
          const chunkId = generateId()
          chunkIds.push(chunkId)
          const chunkIndex = doc!.chunk_count + i + idx
          return c.env.DB.prepare(
            `INSERT INTO document_chunks (id, document_id, chunk_index, content, category_slug, arrangement_slugs, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, '[]', '{}', datetime('now'))`
          ).bind(chunkId, doc!.id, chunkIndex, chunk.text, chunk.category || null)
        })
        await c.env.DB.batch(stmts)

        for (const chunkId of chunkIds) {
          await c.env.VECTORIZE_QUEUE.send({ type: 'vectorize-chunk', chunkId })
        }
        chunksCreated += batch.length
      }

      await c.env.DB.prepare(
        "UPDATE documents SET chunk_count = chunk_count + ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(chunks.length, doc.id).run()
    }

    return c.json({
      inserted: result.inserted,
      duplicates: result.duplicates,
      errors: result.errors,
      atoms_created: result.inserted,
      chunks_created: chunksCreated,
      rejected,
      quality_gate: { rejected: gateRejected, flagged: gateFlagged },
    })
  } catch (error) {
    console.error('Error in bulk insert:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Discovery with content routing
app.post('/discover', async (c) => {
  try {
    const body = await c.req.json<DiscoverRequest>()
    const text = (body.text || '').trim()

    const route = routeContent(text)

    if (route.destination === 'reject') {
      return c.json({ atom: null, created: false, reason: route.reason })
    }

    if (route.destination === 'document_chunk') {
      const docTitle = route.suggested_document || 'Uncategorized Knowledge'
      let doc = await c.env.DB.prepare(
        'SELECT id, chunk_count FROM documents WHERE title = ? LIMIT 1'
      ).bind(docTitle).first<{ id: string; chunk_count: number }>()

      if (!doc) {
        const docId = generateId()
        const tags = route.suggested_tags ? JSON.stringify(route.suggested_tags) : '[]'
        await c.env.DB.prepare(
          `INSERT INTO documents (id, title, description, mime_type, tags, chunk_count, status, source_app, created_at, updated_at)
           VALUES (?, ?, ?, 'text/plain', ?, 0, 'chunked', 'content-router', datetime('now'), datetime('now'))`
        ).bind(docId, docTitle, `Auto-routed content: ${docTitle}`, tags).run()
        doc = { id: docId, chunk_count: 0 }
      }

      const chunkId = generateId()
      await c.env.DB.prepare(
        `INSERT INTO document_chunks (id, document_id, chunk_index, content, category_slug, arrangement_slugs, metadata, created_at)
         VALUES (?, ?, ?, ?, NULL, '[]', ?, datetime('now'))`
      ).bind(chunkId, doc.id, doc.chunk_count, text, JSON.stringify({ source_app: body.source_app || 'discover' })).run()

      await c.env.DB.prepare(
        "UPDATE documents SET chunk_count = chunk_count + 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(doc.id).run()

      await c.env.VECTORIZE_QUEUE.send({ type: 'vectorize-chunk', chunkId })

      return c.json({ atom: null, created: false, routed_to: 'document_chunk', document: docTitle, chunk_id: chunkId })
    }

    // Atom-shaped: quality gate before discovery
    const ctx = await buildModelContext(c.env)
    const gateResult = await qualityGate(
      { text: body.text, source: 'ai', source_app: body.source_app },
      ctx, c.env.AI, c.env.VECTORIZE, c.env.DB
    )
    if (!gateResult.pass) {
      return c.json({
        atom: null, created: false,
        reason: gateResult.rejection_reason,
        quality_gate: {
          specificity_score: gateResult.specificity_score,
          similar_atom_id: gateResult.similar_atom_id,
          similarity_score: gateResult.similarity_score,
        },
      })
    }

    const result = await discoverAtom(c.env.DB, ctx, body.text, body.source_app)
    if ('rejected' in result) {
      return c.json(result)
    }

    if (result.classification.is_new) {
      await c.env.VECTORIZE_QUEUE.send({ type: 'vectorize', atomId: result.atom.id })
      await c.env.ENRICH_QUEUE.send({ type: 'tag-arrangements', atomId: result.atom.id })
    }

    return c.json(result)
  } catch (error) {
    console.error('Error in /atoms/discover:', error)
    return c.json({ atom: null, created: false, reason: error instanceof Error ? error.message : 'classification_failed' })
  }
})

// Decompose
app.post('/decompose', async (c) => {
  const body = await c.req.json<DecomposeRequest>()
  if (!body.concept?.trim()) {
    return c.json({ error: 'concept is required' }, 400)
  }
  try {
    const ctx = await buildModelContext(c.env)
    const result = await decomposeAtom(c.env.DB, ctx, body.concept.trim(), body.source_app)
    return c.json(result)
  } catch (e) {
    console.error('Decompose error:', e)
    return c.json({ error: 'Classification failed', concept: body.concept }, 502)
  }
})

// CRUD
app.get('/', async (c) => {
  const query = {
    collection_slug: c.req.query('collection_slug') || undefined,
    status: (c.req.query('status') as 'provisional' | 'confirmed' | 'rejected') || undefined,
    source: (c.req.query('source') as 'seed' | 'ai' | 'manual') || undefined,
    source_app: c.req.query('source_app') || undefined,
    q: c.req.query('q') || undefined,
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!) : undefined,
    after: c.req.query('after') || undefined,
  }
  const result = await listAtoms(c.env.DB, query)
  return c.json(result)
})

app.post('/', async (c) => {
  try {
    const body = await c.req.json<CreateAtomInput>()
    if (!body.text || !body.collection_slug || !body.source) {
      return c.json({ error: 'text, collection_slug, and source are required' }, 400)
    }
    const textLower = body.text.toLowerCase().trim()
    const ctx = await buildModelContext(c.env)

    // Quality gate: specificity + redundancy + provenance
    const gateResult = await qualityGate(
      { text: body.text, source: body.source, source_app: body.source_app, metadata: body.metadata },
      ctx, c.env.AI, c.env.VECTORIZE, c.env.DB
    )
    if (!gateResult.pass) {
      return c.json({
        error: 'Quality gate rejected',
        rejection_reason: gateResult.rejection_reason,
        specificity_score: gateResult.specificity_score,
        similar_atom_id: gateResult.similar_atom_id,
        similar_atom_text: gateResult.similar_atom_text,
        similarity_score: gateResult.similarity_score,
      }, 400)
    }

    const categories = await getCategoryMetadata(c.env.DB)
    // Request body may include metadata.context (curator-supplied disambiguation);
    // forward it to the classifier so polysemous terms resolve correctly.
    const requestContext = typeof body.metadata?.context === 'string' ? body.metadata.context : undefined
    const classification = await classifyAtom(textLower, ctx, categories, requestContext)
    const atom = await createAtomWithHooks(c.env, {
      ...body,
      category_slug: classification?.category_slug ?? null,
      harmonics: classification ? JSON.stringify(classification.harmonics) : '{}',
      modality: classification?.modality ?? 'visual',
    })
    return c.json({
      ...atom,
      quality_gate: { specificity_score: gateResult.specificity_score, flagged_for_review: gateResult.flagged_for_review },
    }, 201)
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

app.get('/:id', async (c) => {
  const id = c.req.param('id')
  const atom = await getAtom(c.env.DB, id)
  if (!atom) return c.json({ error: 'Atom not found' }, 404)
  return c.json(atom)
})

app.put('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<UpdateAtomInput>()
    const updated = await updateAtom(c.env.DB, id, body)
    if (!updated) return c.json({ error: 'Atom not found' }, 404)

    if (body.text !== undefined || body.collection_slug !== undefined) {
      const ctx = await buildModelContext(c.env)
      const categories = await getCategoryMetadata(c.env.DB)
      const context = extractMetadataContext(updated.metadata)
      const classification = await classifyAtom(updated.text_lower, ctx, categories, context)
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

app.patch('/:id/encounter', async (c) => {
  const id = c.req.param('id')
  const updated = await encounterAtomWithHooks(c.env, id)
  if (!updated) return c.json({ error: 'Atom not found' }, 404)
  return c.json(updated)
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const deleted = await deleteAtom(c.env.DB, id)
  if (!deleted) return c.json({ error: 'Atom not found' }, 404)
  return c.json({ deleted: true })
})

export { app as atomRoutes }
