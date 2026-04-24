// Pipeline stage: NormalizedDocument -> ChunkResult[]
// NOTE: This stage bundles two responsibilities: persistence (document + chunk DB inserts)
// and transformation (content block filtering). That's fine for Phase 3 (matches existing code).
// Future refactoring could split persistence from transformation if needed.

import { createGrimoireHandle } from '@shared/grimoire/handle'
import type { NormalizedDocument, ChunkResult } from '@shared/rpc/pipeline-types'

interface ChunkEnv {
  GRIMOIRE_DB: D1Database
}

export async function chunk(
  env: ChunkEnv,
  doc: NormalizedDocument,
  sourceId: string,
  documentId: string,
  dryRun: boolean,
): Promise<ChunkResult[]> {
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)
  const blocks = doc.content_blocks.filter(b => b.content.trim().length >= 50)

  if (blocks.length === 0) return []

  if (!dryRun) {
    // Create source record
    const contentType = doc.source_type === 'aesthetic' ? 'wiki_aesthetic' : 'wiki_domain'
    await handle.sourceAdd({
      id: sourceId,
      type: doc.provenance.adapter === 'image' ? 'reference' : 'document',
      filename: null,
      mime_type: doc.mime_type,
      r2_key: doc.provenance.image_r2_key ?? null,
      source_url: doc.source_url ?? null,
      metadata: {
        fetched_at: doc.provenance.fetched_at ?? new Date().toISOString(),
        content_length: blocks.reduce((sum, b) => sum + b.content.length, 0),
        page_title: doc.title,
      },
      aesthetic_tags: [],
      arrangement_matches: [],
      harmonic_profile: {},
      atom_count: 0,
      created_at: new Date().toISOString(),
      content_type: contentType,
      status: 'processing',
    })

    // Create document record
    await handle.documentAdd({
      id: documentId,
      title: doc.title,
      description: null,
      mime_type: doc.mime_type,
      r2_key: doc.provenance.image_r2_key ?? null,
      source_url: doc.source_url ?? null,
      tags: doc.tags,
      token_count: null,
      chunk_count: 0,
      status: 'chunking',
      source_app: `pipeline-${doc.provenance.adapter}`,
      source_id: sourceId,
    })

    await handle.sourceUpdateExtraction(sourceId, { document_id: documentId })
  }

  // Create chunks
  const results: ChunkResult[] = []

  if (!dryRun) {
    for (let i = 0; i < blocks.length; i++) {
      const chunkId = crypto.randomUUID()
      await handle.documentChunkAdd({
        id: chunkId,
        document_id: documentId,
        chunk_index: i,
        content: blocks[i].content,
        summary: null,
        token_count: null,
        category_slug: null,
        arrangement_slugs: [],
        metadata: {
          heading: blocks[i].heading,
          source_url: doc.source_url,
          char_count: blocks[i].content.length,
        },
      })
      results.push({
        chunk_id: chunkId,
        content: blocks[i].content,
        section_heading: blocks[i].heading,
        token_count: blocks[i].token_count,
        quality_score: 1.0,
      })
    }
    await handle.documentUpdateStatus(documentId, 'chunked', blocks.length)
  } else {
    // Dry run: generate placeholder chunk IDs
    for (let i = 0; i < blocks.length; i++) {
      results.push({
        chunk_id: `dry-run-${i}`,
        content: blocks[i].content,
        section_heading: blocks[i].heading,
        token_count: blocks[i].token_count,
        quality_score: 1.0,
      })
    }
  }

  console.log(`[pipeline:chunk] blocks=${blocks.length} chunks=${results.length}`)
  return results
}
