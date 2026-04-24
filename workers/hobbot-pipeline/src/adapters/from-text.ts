// Input adapter: raw text -> NormalizedDocument
// No dedup check needed (text ingest is always intentional, no URL to collide on)

import type { NormalizedDocument, ContentBlock } from '@shared/rpc/pipeline-types'
import type { IngestFromTextParams } from '@shared/rpc/pipeline-types'

export function fromText(params: IngestFromTextParams): NormalizedDocument {
  const paragraphs = params.content.split(/\n\n+/).filter(p => p.trim().length >= 50)

  let content_blocks: ContentBlock[]

  if (paragraphs.length === 0) {
    // Entire content as single block
    content_blocks = params.content.trim().length >= 50
      ? [{ heading: params.title, content: params.content.trim(), token_count: Math.ceil(params.content.trim().length / 4) }]
      : []
  } else {
    // Split into blocks, merging small paragraphs
    const blocks: ContentBlock[] = []
    let chunk = ''
    let chunkIdx = 0

    for (const para of paragraphs) {
      if (chunk.length + para.length > 1500 && chunk.length >= 200) {
        blocks.push({
          heading: chunkIdx === 0 ? params.title : `${params.title} (part ${chunkIdx + 1})`,
          content: chunk.trim(),
          token_count: Math.ceil(chunk.trim().length / 4),
        })
        chunk = ''
        chunkIdx++
      }
      chunk += (chunk ? '\n\n' : '') + para
    }

    if (chunk.trim().length >= 50) {
      blocks.push({
        heading: chunkIdx === 0 ? params.title : `${params.title} (part ${chunkIdx + 1})`,
        content: chunk.trim(),
        token_count: Math.ceil(chunk.trim().length / 4),
      })
    }

    content_blocks = blocks
  }

  return {
    title: params.title,
    content_blocks,
    source_url: undefined,
    source_type: params.source_type ?? 'domain',
    mime_type: 'text/plain',
    tags: [...(params.tags ?? []), params.source_type ?? 'domain'],
    provenance: {
      adapter: 'text',
      collection_slug: params.collection_slug,
    },
  }
}
