import { Hono } from 'hono'
import type { Env, DocumentChunkSearchResult } from './types'
import { searchAtoms, searchDocumentChunks } from './vectorize'
import { generateId } from './atoms'

const knowledgeApp = new Hono<{ Bindings: Env }>()

// Aesthetic channel categories (mirrored from StyleFusion conductor)
const AESTHETIC_PARENTS = new Set(['style', 'color', 'lighting', 'effect', 'composition', 'camera'])
const AESTHETIC_CATEGORIES = new Set(['narrative.mood', 'environment.atmosphere'])

function isAestheticCategory(slug: string): boolean {
  return AESTHETIC_PARENTS.has(slug.split('.')[0]) || AESTHETIC_CATEGORIES.has(slug)
}

interface KnowledgeQueryRequest {
  query: string
  arrangement?: string
  categories?: string[]
  include_documents?: boolean
  limit?: number
}

interface ContextEntry {
  guidance: string
  mode: string
}

interface KnowledgeQueryResponse {
  contexts: Record<string, ContextEntry>
  documents: DocumentChunkSearchResult[]
  arrangement_meta: {
    slug: string
    name: string
    harmonics: Record<string, unknown>
  } | null
  atom_signals: {
    aesthetic_matches: number
    texture_matches: number
    top_categories: string[]
  }
}

knowledgeApp.post('/query', async (c) => {
  const body = await c.req.json<KnowledgeQueryRequest>()
  if (!body.query) return c.json({ error: 'query is required' }, 400)

  const categoryFilter = body.categories ? new Set(body.categories) : null
  const response: KnowledgeQueryResponse = {
    contexts: {},
    documents: [],
    arrangement_meta: null,
    atom_signals: { aesthetic_matches: 0, texture_matches: 0, top_categories: [] },
  }

  // 1. Load category_contexts for the arrangement
  if (body.arrangement) {
    const arr = await c.env.DB.prepare(
      'SELECT slug, name, harmonics, context_key FROM arrangements WHERE slug = ?'
    ).bind(body.arrangement).first<{ slug: string; name: string; harmonics: string; context_key: string }>()

    if (arr) {
      response.arrangement_meta = {
        slug: arr.slug,
        name: arr.name,
        harmonics: JSON.parse(arr.harmonics || '{}'),
      }

      if (arr.context_key) {
        const { results } = await c.env.DB.prepare(
          'SELECT category_slug, guidance, context_mode FROM category_contexts WHERE context = ?'
        ).bind(arr.context_key).all<{ category_slug: string; guidance: string; context_mode: string | null }>()

        for (const row of results) {
          if (categoryFilter && !categoryFilter.has(row.category_slug)) continue
          response.contexts[row.category_slug] = {
            guidance: row.guidance,
            mode: row.context_mode || 'enrich',
          }
        }
      }
    }
  }

  // 2. Search document chunks via Vectorize (if requested)
  if (body.include_documents) {
    try {
      const docs = await searchDocumentChunks(
        body.query,
        c.env.AI,
        c.env.VECTORIZE,
        c.env.DB,
        { category_slug: body.categories?.[0], limit: body.limit ?? 20 }
      )
      response.documents = categoryFilter
        ? docs.filter(d => !d.category_slug || categoryFilter.has(d.category_slug))
        : docs
    } catch (error) {
      console.error('[knowledge] document chunk search failed:', error)
      // Non-fatal: documents are supplementary
    }
  }

  // 3. Compute atom_signals (diagnostic only, no atom text returned)
  try {
    const atomResults = await searchAtoms(
      body.query,
      c.env.AI,
      c.env.VECTORIZE,
      c.env.DB,
      { limit: 50 }
    )

    let aesthetic = 0
    let texture = 0
    const categoryCount = new Map<string, number>()

    for (const { atom } of atomResults) {
      const cat = atom.category_slug ?? 'unknown'
      if (isAestheticCategory(cat)) {
        aesthetic++
      } else {
        texture++
      }
      categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1)
    }

    response.atom_signals = {
      aesthetic_matches: aesthetic,
      texture_matches: texture,
      top_categories: [...categoryCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat]) => cat),
    }
  } catch (error) {
    console.error('[knowledge] atom signal computation failed:', error)
    // Non-fatal: signals are diagnostic only
  }

  return c.json(response)
})

// --- Knowledge Ingest ---

interface KnowledgePackage {
  type: 'compilation_outcome' | 'character_dna' | 'aesthetic_research' | 'external_data'
  source_app: string
  timestamp: string
  tags?: string[]

  compilation?: {
    generation_id: string
    extraction_model: string
    generation_provider?: string
    generation_model?: string
    ir_summary: {
      style_anchors: string[]
      description: string
      palette_mood?: string
      rendering_medium?: string
      aspect_ratio?: string
    }
    arrangement: {
      slug: string
      score: number
      selection_path: string
    }
    signal: 'kept' | 'regenerated' | 'provider_switched'
    render_mode?: string
    product_mode?: string
    character_id?: string
  }

  character?: {
    character_id: string
    name: string
    anchors: string[]
    flex: string[]
    visual_dna_description: string
    extraction_model: string
  }

  research?: {
    topic: string
    content: string
    sources?: string[]
    arrangement_slug?: string
  }
}

interface KnowledgeRouting {
  document_title: string
  document_description: string
  document_tags: string[]
  chunk_content: string
  chunk_category: string | null
  arrangement_slugs: string
  chunk_metadata: string
}

function buildCompilationChunkContent(c: KnowledgePackage['compilation']): string {
  if (!c) return ''
  const parts = [
    `Compilation: ${c.signal} (${c.arrangement.slug} @ ${c.arrangement.score.toFixed(3)})`,
    `Extraction: ${c.extraction_model}`,
    c.generation_provider ? `Generation: ${c.generation_provider}${c.generation_model ? '/' + c.generation_model : ''}` : null,
    `Anchors: ${c.ir_summary.style_anchors.join(', ')}`,
    c.ir_summary.description,
    c.ir_summary.palette_mood ? `Palette: ${c.ir_summary.palette_mood}` : null,
    c.ir_summary.rendering_medium ? `Medium: ${c.ir_summary.rendering_medium}` : null,
    c.render_mode ? `Render mode: ${c.render_mode}` : null,
    c.product_mode ? `Product mode: ${c.product_mode}` : null,
  ]
  return parts.filter(Boolean).join('\n')
}

function buildCharacterChunkContent(c: KnowledgePackage['character']): string {
  if (!c) return ''
  return [
    `Character: ${c.name}`,
    `Anchors: ${c.anchors.join(', ')}`,
    `Flex: ${c.flex.join(', ')}`,
    c.visual_dna_description,
  ].join('\n')
}

function routeKnowledgePackage(pkg: KnowledgePackage): KnowledgeRouting {
  switch (pkg.type) {
    case 'compilation_outcome':
      return {
        document_title: 'Compilation Outcomes',
        document_description: 'StyleFusion compilation feedback. Each chunk records what extraction model was used, which arrangement matched, whether the user kept or regenerated the result, and the visual summary.',
        document_tags: ['compilation-outcome', 'feedback', 'stylefusion'],
        chunk_content: buildCompilationChunkContent(pkg.compilation),
        chunk_category: 'style.genre',
        arrangement_slugs: JSON.stringify([pkg.compilation!.arrangement.slug]),
        chunk_metadata: JSON.stringify({
          generation_id: pkg.compilation!.generation_id,
          extraction_model: pkg.compilation!.extraction_model,
          generation_provider: pkg.compilation!.generation_provider,
          generation_model: pkg.compilation!.generation_model,
          signal: pkg.compilation!.signal,
          render_mode: pkg.compilation!.render_mode,
          product_mode: pkg.compilation!.product_mode,
          arrangement_score: pkg.compilation!.arrangement.score,
          selection_path: pkg.compilation!.arrangement.selection_path,
          character_id: pkg.compilation!.character_id,
          timestamp: pkg.timestamp,
        }),
      }

    case 'character_dna':
      return {
        document_title: 'Character DNA Registry',
        document_description: "Visual identity definitions for recurring characters. Each chunk defines a character's anchors (fixed visual elements) and flex (variable elements) with provenance from extraction models.",
        document_tags: ['character-dna', 'identity', 'stylefusion'],
        chunk_content: buildCharacterChunkContent(pkg.character),
        chunk_category: 'reference.character',
        arrangement_slugs: '[]',
        chunk_metadata: JSON.stringify({
          character_id: pkg.character!.character_id,
          extraction_model: pkg.character!.extraction_model,
          timestamp: pkg.timestamp,
        }),
      }

    case 'aesthetic_research':
      return {
        document_title: 'Aesthetic Research',
        document_description: 'Research findings about aesthetics, styles, and visual movements. Generated by the knowledge agent from web search, LLM training data, and Grimoire gap analysis.',
        document_tags: ['aesthetic-research', 'knowledge-agent'],
        chunk_content: pkg.research?.content || '',
        chunk_category: 'style.genre',
        arrangement_slugs: pkg.research?.arrangement_slug
          ? JSON.stringify([pkg.research.arrangement_slug])
          : '[]',
        chunk_metadata: JSON.stringify({
          topic: pkg.research?.topic,
          sources: pkg.research?.sources,
          timestamp: pkg.timestamp,
        }),
      }

    case 'external_data':
      return {
        document_title: 'External Knowledge',
        document_description: 'Knowledge ingested from external databases, RSS feeds, and other sources.',
        document_tags: ['external', ...(pkg.tags || [])],
        chunk_content: pkg.research?.content || JSON.stringify(pkg),
        chunk_category: null,
        arrangement_slugs: '[]',
        chunk_metadata: JSON.stringify({
          source_app: pkg.source_app,
          timestamp: pkg.timestamp,
        }),
      }
  }
}

knowledgeApp.post('/ingest', async (c) => {
  const pkg = await c.req.json<KnowledgePackage>()

  if (!pkg.type || !pkg.source_app) {
    return c.json({ error: 'type and source_app are required' }, 400)
  }

  // Validate type-specific payload
  if (pkg.type === 'compilation_outcome' && !pkg.compilation) {
    return c.json({ error: 'compilation payload required for compilation_outcome type' }, 400)
  }
  if (pkg.type === 'character_dna' && !pkg.character) {
    return c.json({ error: 'character payload required for character_dna type' }, 400)
  }
  if (pkg.type === 'aesthetic_research' && !pkg.research) {
    return c.json({ error: 'research payload required for aesthetic_research type' }, 400)
  }

  try {
    const routing = routeKnowledgePackage(pkg)

    // Find or create document by title
    let doc = await c.env.DB.prepare(
      'SELECT id, chunk_count FROM documents WHERE title = ? LIMIT 1'
    ).bind(routing.document_title).first<{ id: string; chunk_count: number }>()

    if (!doc) {
      const docId = generateId()
      await c.env.DB.prepare(
        `INSERT INTO documents (id, title, description, mime_type, tags, chunk_count, status, source_app, created_at, updated_at)
         VALUES (?, ?, ?, 'application/json', ?, 0, 'chunked', ?, datetime('now'), datetime('now'))`
      ).bind(docId, routing.document_title, routing.document_description, JSON.stringify(routing.document_tags), pkg.source_app).run()
      doc = { id: docId, chunk_count: 0 }
    }

    // Create chunk
    const chunkId = generateId()
    const chunkIndex = doc.chunk_count
    await c.env.DB.prepare(
      `INSERT INTO document_chunks (id, document_id, chunk_index, content, category_slug, arrangement_slugs, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(chunkId, doc.id, chunkIndex, routing.chunk_content, routing.chunk_category, routing.arrangement_slugs, routing.chunk_metadata).run()

    // Dual-write: arrangement_chunks + arrangement_documents join tables
    const arrSlugs: string[] = JSON.parse(routing.arrangement_slugs || '[]')
    if (arrSlugs.length > 0) {
      const stmts = arrSlugs.flatMap(slug => [
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO arrangement_chunks (arrangement_slug, chunk_id) VALUES (?, ?)'
        ).bind(slug, chunkId),
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO arrangement_documents (arrangement_slug, document_id) VALUES (?, ?)'
        ).bind(slug, doc.id),
      ])
      await c.env.DB.batch(stmts)
    }

    // Update document chunk_count
    await c.env.DB.prepare(
      "UPDATE documents SET chunk_count = chunk_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).bind(doc.id).run()

    // Enqueue for vectorization
    await c.env.VECTORIZE_QUEUE.send({ type: 'vectorize-chunk', chunkId })

    return c.json({
      document_id: doc.id,
      chunk_id: chunkId,
      type: pkg.type,
    })
  } catch (error) {
    console.error('[knowledge:ingest] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { knowledgeApp }
