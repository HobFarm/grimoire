// Input adapter: RSS feed_entry row -> NormalizedDocument
// Routes to from-url (HTML) or from-pdf depending on content type

import { fromUrl } from './from-url'
import { fromPdf } from './from-pdf'
import type { NormalizedDocument } from '@shared/rpc/pipeline-types'

interface FeedEntry {
  id: number
  source_id: string
  entry_url: string
  entry_title: string
  content?: string
  mime_type?: string
  metadata?: string
  knowledge_request_id?: number
}

interface FeedEntryAdapterEnv {
  GRIMOIRE_DB: D1Database
  AI: Ai
  R2: R2Bucket
}

export interface FeedEntryAdapterResult {
  already_ingested: boolean
  doc?: NormalizedDocument
  logId?: string
  sourceId?: string
  documentId?: string
}

export async function fromFeedEntry(
  env: FeedEntryAdapterEnv,
  entry: FeedEntry,
): Promise<FeedEntryAdapterResult> {
  // Detect PDF content: explicit mime_type or URL extension
  const isPdf = entry.mime_type === 'application/pdf'
    || entry.entry_url.toLowerCase().endsWith('.pdf')

  if (isPdf) {
    // Parse metadata for arrangement_hints from agent
    let arrangementHints: string[] | undefined
    let tags = ['agent', 'pdf']
    if (entry.metadata) {
      try {
        const meta = JSON.parse(entry.metadata)
        arrangementHints = meta.arrangement_hints
      } catch { /* metadata isn't valid JSON, skip */ }
    }
    if (entry.source_id) tags.push(entry.source_id)

    const pdfResult = await fromPdf(env, {
      url: entry.entry_url,
      source_type: 'domain',
      tags,
      arrangement_hints: arrangementHints,
    })

    if (pdfResult.already_ingested) {
      return { already_ingested: true }
    }

    if (!pdfResult.doc) {
      // PDF extraction returned no content (empty/image-only PDF)
      return {
        already_ingested: false,
        doc: undefined,
        logId: pdfResult.logId,
        sourceId: pdfResult.sourceId,
        documentId: pdfResult.documentId,
      }
    }

    // Tag the provenance with feed entry info
    pdfResult.doc.provenance.feed_entry_id = entry.id

    return {
      already_ingested: false,
      doc: pdfResult.doc,
      logId: pdfResult.logId,
      sourceId: pdfResult.sourceId,
      documentId: pdfResult.documentId,
    }
  }

  // Default: delegate to from-url (HTML content)
  const urlResult = await fromUrl(env, {
    url: entry.entry_url,
    source_type: 'domain',
    tags: ['rss'],
  })

  if (urlResult.already_ingested) {
    return { already_ingested: true }
  }

  if (!urlResult.doc) {
    throw new Error(`from-url adapter returned no document for ${entry.entry_url}`)
  }

  // Tag the provenance with feed entry info
  urlResult.doc.provenance.feed_entry_id = entry.id

  return {
    already_ingested: false,
    doc: urlResult.doc,
    logId: urlResult.logId,
    sourceId: urlResult.sourceId,
    documentId: urlResult.documentId,
  }
}
