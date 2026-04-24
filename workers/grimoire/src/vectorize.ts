import type { AtomRow, SearchResult, DocumentChunkSearchResult } from './types'
import { MODELS } from './models'

const EMBEDDING_MODEL = MODELS.embed.primary.model as Parameters<Ai['run']>[0]

function buildEmbeddingText(atom: AtomRow): string {
  // Text-only: category_slug and collection_slug excluded to prevent
  // same-category clustering bias in vector space. Category filtering
  // happens at query time via Vectorize metadata, not embedding similarity.
  return atom.text
}

/**
 * Generate embeddings for a batch of atoms and upsert into Vectorize.
 * Max 100 atoms per call. Updates embedding_status in D1.
 */
export async function vectorizeAtomBatch(
  atoms: AtomRow[],
  ai: Ai,
  vectorize: Vectorize,
  db: D1Database
): Promise<{ vectorized: number; failed: number }> {
  if (atoms.length === 0) return { vectorized: 0, failed: 0 }
  if (atoms.length > 100) throw new Error('vectorizeAtomBatch: max 100 atoms per call')

  const ids = atoms.map(a => a.id)

  try {
    // Mark batch as processing
    await db.batch(
      ids.map(id =>
        db.prepare("UPDATE atoms SET embedding_status = 'processing' WHERE id = ?").bind(id)
      )
    )

    // Generate embeddings via Workers AI
    const texts = atoms.map(buildEmbeddingText)
    const embeddingResult = await ai.run(EMBEDDING_MODEL, { text: texts }) as { data?: number[][] }

    if (!embeddingResult.data) {
      throw new Error('Unexpected async response from embedding model')
    }
    const vectors = embeddingResult.data
    if (vectors.length !== atoms.length) {
      throw new Error(`Embedding count mismatch: expected ${atoms.length}, got ${vectors.length}`)
    }

    // Build Vectorize vectors
    const vectorizeVectors: VectorizeVector[] = atoms.map((atom, i) => ({
      id: atom.id,
      values: vectors[i],
      namespace: atom.collection_slug,
      metadata: {
        category: atom.category_slug ?? '',
        status: atom.status,
        text: atom.text,
      },
    }))

    // Upsert (not insert) so re-embeddings are idempotent
    await vectorize.upsert(vectorizeVectors)

    // Mark batch as complete
    await db.batch(
      ids.map(id =>
        db.prepare("UPDATE atoms SET embedding_status = 'complete' WHERE id = ?").bind(id)
      )
    )

    return { vectorized: atoms.length, failed: 0 }
  } catch (error) {
    console.error('vectorizeAtomBatch error:', error)

    try {
      await db.batch(
        ids.map(id =>
          db.prepare("UPDATE atoms SET embedding_status = 'failed' WHERE id = ?").bind(id)
        )
      )
    } catch (dbError) {
      console.error('Failed to update embedding_status to failed:', dbError)
    }

    return { vectorized: 0, failed: atoms.length }
  }
}

/**
 * Fetch pending classified atoms and vectorize in 100-atom chunks.
 * Used by both the cron handler and the /admin/vectorize-batch REST endpoint.
 */
export async function vectorizeBatchProcess(
  db: D1Database,
  ai: Ai,
  vectorizeIndex: Vectorize,
  opts: { limit: number }
): Promise<{ vectorized: number; failed: number }> {
  const { results } = await db.prepare(
    "SELECT * FROM atoms WHERE embedding_status = 'pending' AND category_slug IS NOT NULL LIMIT ?"
  ).bind(opts.limit).all<AtomRow>()

  if (results.length === 0) return { vectorized: 0, failed: 0 }

  let vectorized = 0
  let failed = 0

  for (let i = 0; i < results.length; i += 100) {
    const chunk = results.slice(i, i + 100)
    const result = await vectorizeAtomBatch(chunk, ai, vectorizeIndex, db)
    vectorized += result.vectorized
    failed += result.failed
  }

  return { vectorized, failed }
}

// --- Document Chunk Vectorization ---

interface ChunkInput {
  id: string
  content: string
  document_id: string
  category_slug: string | null
}

/**
 * Generate embeddings for a batch of document chunks and upsert into Vectorize.
 * Max 100 chunks per call. No D1 status tracking (chunks have no embedding_status).
 * Vector IDs prefixed with 'doc_chunk_' to avoid collision with atom IDs.
 */
export async function vectorizeChunkBatch(
  chunks: ChunkInput[],
  ai: Ai,
  vectorize: Vectorize,
  db?: D1Database,
): Promise<{ vectorized: number; failed: number }> {
  if (chunks.length === 0) return { vectorized: 0, failed: 0 }
  if (chunks.length > 100) throw new Error('vectorizeChunkBatch: max 100 chunks per call')

  try {
    const texts = chunks.map(c => c.content)
    const embeddingResult = await ai.run(EMBEDDING_MODEL, { text: texts }) as { data?: number[][] }

    if (!embeddingResult.data) {
      throw new Error('Unexpected async response from embedding model')
    }
    const vectors = embeddingResult.data
    if (vectors.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${vectors.length}`)
    }

    const vectorizeVectors: VectorizeVector[] = chunks.map((chunk, i) => ({
      id: `doc_chunk_${chunk.id}`,
      values: vectors[i],
      metadata: {
        type: 'document_chunk',
        document_id: chunk.document_id,
        category: chunk.category_slug ?? '',
      },
    }))

    await vectorize.upsert(vectorizeVectors)

    // Mark chunks as complete
    if (db && chunks.length > 0) {
      const ph = chunks.map(() => '?').join(',')
      await db.prepare(`UPDATE document_chunks SET embedding_status = 'complete' WHERE id IN (${ph})`).bind(...chunks.map(c => c.id)).run()
    }

    return { vectorized: chunks.length, failed: 0 }
  } catch (error) {
    console.error('vectorizeChunkBatch error:', error)

    // Mark chunks as failed
    if (db && chunks.length > 0) {
      try {
        const ph = chunks.map(() => '?').join(',')
        await db.prepare(`UPDATE document_chunks SET embedding_status = 'failed' WHERE id IN (${ph})`).bind(...chunks.map(c => c.id)).run()
      } catch {}
    }

    return { vectorized: 0, failed: chunks.length }
  }
}

/**
 * Semantic search across document chunks in Vectorize.
 * Embeds the query, filters by type='document_chunk', hydrates from D1.
 */
export async function searchDocumentChunks(
  query: string,
  ai: Ai,
  vectorize: Vectorize,
  db: D1Database,
  options?: { category_slug?: string; limit?: number }
): Promise<DocumentChunkSearchResult[]> {
  const topK = Math.min(options?.limit ?? 20, 100)

  const embeddingResult = await ai.run(EMBEDDING_MODEL, { text: [query] }) as { data?: number[][] }
  if (!embeddingResult.data?.[0]) {
    throw new Error('Failed to embed search query')
  }

  const filter: Record<string, unknown> = { type: 'document_chunk' }
  if (options?.category_slug) {
    filter.category = options.category_slug
  }

  const matches = await vectorize.query(embeddingResult.data[0], {
    topK,
    returnMetadata: 'indexed',
    returnValues: false,
    filter,
  })
  if (matches.count === 0) return []

  // Strip doc_chunk_ prefix for D1 lookup
  const chunkIds = matches.matches.map(m => m.id.replace('doc_chunk_', ''))
  const scoreMap = new Map(matches.matches.map(m => [m.id.replace('doc_chunk_', ''), m.score]))

  // Hydrate from D1 in 50-ID chunks
  const rows: Array<{ id: string; content: string; category_slug: string | null; document_id: string; title: string }> = []
  for (let i = 0; i < chunkIds.length; i += 50) {
    const batch = chunkIds.slice(i, i + 50)
    const placeholders = batch.map(() => '?').join(',')
    const res = await db
      .prepare(`SELECT c.id, c.content, c.category_slug, c.document_id, d.title FROM document_chunks c JOIN documents d ON c.document_id = d.id WHERE c.id IN (${placeholders})`)
      .bind(...batch)
      .all<{ id: string; content: string; category_slug: string | null; document_id: string; title: string }>()
    rows.push(...res.results)
  }

  const rowMap = new Map(rows.map(r => [r.id, r]))
  const results: DocumentChunkSearchResult[] = []

  // Preserve Vectorize score order
  for (const chunkId of chunkIds) {
    const row = rowMap.get(chunkId)
    if (row) {
      results.push({
        id: row.id,
        content: row.content,
        category_slug: row.category_slug,
        document_id: row.document_id,
        document_title: row.title,
        similarity: scoreMap.get(chunkId) ?? 0,
      })
    }
  }

  return results
}

/**
 * Semantic search across the atom corpus.
 * Embeds the query, queries Vectorize, hydrates full atoms from D1.
 */
export async function searchAtoms(
  query: string,
  ai: Ai,
  vectorize: Vectorize,
  db: D1Database,
  options?: { collection_slug?: string; category_slug?: string; limit?: number }
): Promise<SearchResult[]> {
  const topK = Math.min(options?.limit ?? 20, 500)

  // Embed query with the same model used for atoms
  const embeddingResult = await ai.run(EMBEDDING_MODEL, { text: [query] }) as { data?: number[][] }
  if (!embeddingResult.data?.[0]) {
    throw new Error('Failed to embed search query')
  }
  const queryVector = embeddingResult.data[0]

  // Build Vectorize query options
  const queryOptions: VectorizeQueryOptions = {
    topK,
    returnMetadata: 'indexed',
    returnValues: false,
  }

  if (options?.collection_slug) {
    queryOptions.namespace = options.collection_slug
  }

  if (options?.category_slug) {
    queryOptions.filter = { category: options.category_slug }
  }

  const matches = await vectorize.query(queryVector, queryOptions)
  if (matches.count === 0) return []

  // Hydrate from D1 (chunk IDs at 50 for binding safety)
  const atoms: AtomRow[] = []
  for (let i = 0; i < matches.matches.length; i += 50) {
    const chunk = matches.matches.slice(i, i + 50)
    const placeholders = chunk.map(() => '?').join(',')
    const res = await db
      .prepare(`SELECT * FROM atoms WHERE id IN (${placeholders}) AND status != 'rejected'`)
      .bind(...chunk.map(m => m.id))
      .all<AtomRow>()
    atoms.push(...res.results)
  }

  // Build results preserving Vectorize score order, skip deleted atoms
  const atomMap = new Map(atoms.map(a => [a.id, a]))
  const results: SearchResult[] = []

  for (const match of matches.matches) {
    const atom = atomMap.get(match.id)
    if (atom) {
      results.push({ atom, score: match.score })
    }
  }

  return results
}
