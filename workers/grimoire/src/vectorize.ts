import type { AtomRow, SearchResult } from './types'

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5' as const

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
    const embeddingResult = await ai.run(EMBEDDING_MODEL, { text: texts })

    // Narrow union type: sync result has 'data', async has 'request_id'
    if (!('data' in embeddingResult) || !embeddingResult.data) {
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
  const topK = Math.min(options?.limit ?? 20, 100)

  // Embed query with the same model used for atoms
  const embeddingResult = await ai.run(EMBEDDING_MODEL, { text: [query] })
  if (!('data' in embeddingResult) || !embeddingResult.data?.[0]) {
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
      .prepare(`SELECT * FROM atoms WHERE id IN (${placeholders})`)
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
