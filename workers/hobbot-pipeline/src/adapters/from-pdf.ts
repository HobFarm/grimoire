// Input adapter: PDF -> NormalizedDocument
// Extracts markdown via Workers AI toMarkdown(), splits by heading structure,
// filters low-value blocks (TOC, index, bibliography), returns NormalizedDocument.

import { createGrimoireHandle } from '@shared/grimoire/handle'
import type { NormalizedDocument, ContentBlock, IngestFromPdfParams } from '@shared/rpc/pipeline-types'

interface PdfAdapterEnv {
  GRIMOIRE_DB: D1Database
  AI: Ai
  R2: R2Bucket
}

export interface PdfAdapterResult {
  already_ingested: boolean
  doc?: NormalizedDocument
  logId?: string
  sourceId?: string
  documentId?: string
  ingest_log?: Record<string, unknown>
}

// Headings that contain valuable provenance but not aesthetic vocabulary
const BIBLIOGRAPHY_HEADINGS = /^(bibliography|references|works cited|notes|endnotes|index|table of contents|contents|appendix|acknowledgements)/i

// Detect index/TOC pages: high ratio of numbers to words
function isIndexPage(text: string): boolean {
  const words = text.split(/\s+/)
  if (words.length < 10) return false
  const numberWords = words.filter(w => /^\d+[.,\-]*$/.test(w))
  return numberWords.length / words.length > 0.4
}

// Split markdown by ## headings into content blocks
function parseMarkdownToBlocks(markdown: string, docTitle: string): { blocks: ContentBlock[]; bibliographyDetected: boolean } {
  const lines = markdown.split('\n')
  const sections: { heading: string; content: string; isBibliography: boolean }[] = []
  let currentHeading = docTitle
  let currentContent: string[] = []
  let currentIsBib = false
  let bibliographyDetected = false

  // Extract H1 as title if present
  let extractedTitle: string | undefined
  for (const line of lines) {
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      extractedTitle = line.slice(2).trim()
      break
    }
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Flush previous section
      if (currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent.join('\n').trim(), isBibliography: currentIsBib })
      }
      currentHeading = line.slice(3).trim()
      currentIsBib = BIBLIOGRAPHY_HEADINGS.test(currentHeading)
      if (currentIsBib) bibliographyDetected = true
      currentContent = []
    } else if (line.startsWith('# ') && !line.startsWith('## ')) {
      // Skip H1 (used as title)
      continue
    } else {
      currentContent.push(line)
    }
  }
  // Flush last section
  if (currentContent.length > 0) {
    sections.push({ heading: currentHeading, content: currentContent.join('\n').trim(), isBibliography: currentIsBib })
  }

  // Filter and build content blocks
  const raw: ContentBlock[] = []
  for (const section of sections) {
    // Skip bibliography sections (tagged in provenance, not extracted)
    if (section.isBibliography) continue

    const text = section.content.trim()
    // Skip empty or tiny blocks
    if (text.length < 50) continue

    // Skip index/TOC pages
    if (isIndexPage(text)) continue

    // Chunk large sections (same 1500-char boundary as from-url)
    if (text.length > 1500) {
      const paragraphs = text.split(/\n\n+/)
      let chunk = ''
      let chunkIdx = 0
      for (const para of paragraphs) {
        if (chunk.length + para.length > 1500 && chunk.length >= 200) {
          raw.push({
            heading: chunkIdx === 0 ? section.heading : `${section.heading} (cont.)`,
            content: chunk.trim(),
            token_count: Math.ceil(chunk.trim().length / 4),
          })
          chunk = ''
          chunkIdx++
        }
        chunk += (chunk ? '\n\n' : '') + para
      }
      if (chunk.trim().length >= 50) {
        raw.push({
          heading: chunkIdx === 0 ? section.heading : `${section.heading} (cont.)`,
          content: chunk.trim(),
          token_count: Math.ceil(chunk.trim().length / 4),
        })
      }
    } else {
      raw.push({
        heading: section.heading,
        content: text,
        token_count: Math.ceil(text.length / 4),
      })
    }
  }

  // Merge small adjacent blocks (under 200 chars)
  const blocks: ContentBlock[] = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].content.length < 200 && i + 1 < raw.length) {
      raw[i + 1] = {
        heading: raw[i + 1].heading,
        content: raw[i].content + '\n\n' + raw[i + 1].content,
        token_count: Math.ceil((raw[i].content.length + raw[i + 1].content.length) / 4),
      }
    } else {
      blocks.push(raw[i])
    }
  }

  return { blocks, bibliographyDetected }
}

export async function fromPdf(
  env: PdfAdapterEnv,
  params: IngestFromPdfParams,
): Promise<PdfAdapterResult> {
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)
  const dryRun = params.dry_run ?? false

  // Determine canonical URL for dedup
  const canonicalUrl = params.url ?? (params.r2_key ? `r2://${params.r2_key}` : undefined)

  // Dedup check
  if (canonicalUrl) {
    const existing = await handle.ingestLogByUrl(canonicalUrl)
    if (existing && existing.status === 'complete' && !dryRun) {
      return {
        already_ingested: true,
        ingest_log: existing as unknown as Record<string, unknown>,
      }
    }
  }

  // Create ingest log entry
  const logId = crypto.randomUUID()
  if (!dryRun && canonicalUrl) {
    await handle.ingestLogInsert({
      id: logId,
      url: canonicalUrl,
      source_type: params.source_type ?? 'domain',
      status: 'processing',
      atoms_created: 0,
      atoms_skipped: 0,
      relations_created: 0,
      extraction_json: null,
      error_message: null,
      dry_run: false,
    })
  }

  const sourceId = crypto.randomUUID()
  const documentId = crypto.randomUUID()

  // Resolve PDF bytes from one of three sources
  let pdfArrayBuffer: ArrayBuffer

  if (params.url) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60_000) // 60s for large PDFs
    try {
      const response = await fetch(params.url, {
        headers: { 'User-Agent': 'HobBot-Grimoire/2.0 (knowledge-ingest)' },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      pdfArrayBuffer = await response.arrayBuffer()
    } finally {
      clearTimeout(timeoutId)
    }
  } else if (params.r2_key) {
    const obj = await env.R2.get(params.r2_key)
    if (!obj) throw new Error(`R2 object not found: ${params.r2_key}`)
    pdfArrayBuffer = await obj.arrayBuffer()
  } else if (params.pdf_base64) {
    const binaryStr = atob(params.pdf_base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
    pdfArrayBuffer = bytes.buffer
  } else {
    throw new Error('One of url, r2_key, or pdf_base64 is required')
  }

  const sizeMB = pdfArrayBuffer.byteLength / (1024 * 1024)
  console.log(`[adapter:pdf] source=${params.url ?? params.r2_key ?? 'base64'} size=${sizeMB.toFixed(1)}MB`)

  // Extract markdown via Workers AI
  const pdfBlob = new Blob([pdfArrayBuffer], { type: 'application/pdf' })
  const filename = params.filename ?? 'document.pdf'

  // Workers AI toMarkdown: takes array of {name, blob}, returns array of {name, data}
  const mdResults = await (env.AI as any).toMarkdown([{ name: filename, blob: pdfBlob }])
  const mdResult = Array.isArray(mdResults) ? mdResults[0] : mdResults
  const markdown: string = mdResult?.data ?? mdResult?.content ?? ''

  if (!markdown || markdown.length < 100) {
    console.warn(`[adapter:pdf] toMarkdown returned minimal content (${markdown.length} chars)`)
    if (!dryRun && canonicalUrl) {
      await handle.ingestLogUpdate(logId, {
        status: 'failed',
        error_message: `PDF extraction returned minimal content (${markdown.length} chars)`,
      })
    }
    return {
      already_ingested: false,
      doc: undefined,
      logId,
      sourceId,
      documentId,
    }
  }

  console.log(`[adapter:pdf] markdown=${markdown.length} chars`)

  // Parse markdown into content blocks
  const { blocks, bibliographyDetected } = parseMarkdownToBlocks(markdown, params.title ?? filename)

  // Extract title: prefer params.title, then H1 from markdown, then filename
  let title = params.title
  if (!title) {
    const h1Match = markdown.match(/^# (.+)$/m)
    title = h1Match ? h1Match[1].trim() : filename.replace(/\.pdf$/i, '')
  }

  console.log(`[adapter:pdf] title="${title}" blocks=${blocks.length} bibliography=${bibliographyDetected}`)

  const doc: NormalizedDocument = {
    title,
    content_blocks: blocks,
    source_url: canonicalUrl,
    source_type: params.source_type ?? 'domain',
    mime_type: 'application/pdf',
    tags: [...(params.tags ?? []), ...(params.arrangement_hints ?? []), 'pdf'],
    provenance: {
      adapter: 'pdf',
      fetched_at: new Date().toISOString(),
      original_url: params.url,
      pdf_r2_key: params.r2_key,
      collection_slug: params.collection_slug,
      arrangement_hints: params.arrangement_hints,
      bibliography_detected: bibliographyDetected,
    },
  }

  return {
    already_ingested: false,
    doc,
    logId,
    sourceId,
    documentId,
  }
}
