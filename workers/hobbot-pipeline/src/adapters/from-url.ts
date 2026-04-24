// Input adapter: URL -> NormalizedDocument
// Extracts from knowledge-ingest.ts steps 1-3: fetch, parse, quality filter
// Includes ingest_log dedup check (CRITICAL: prevents re-processing completed URLs)

import { createGrimoireHandle } from '@shared/grimoire/handle'
import type { NormalizedDocument, ContentBlock } from '@shared/rpc/pipeline-types'
import type { IngestFromUrlParams } from '@shared/rpc/pipeline-types'

interface UrlAdapterEnv {
  GRIMOIRE_DB: D1Database
}

export interface UrlAdapterResult {
  already_ingested: boolean
  doc?: NormalizedDocument
  logId?: string
  sourceId?: string
  documentId?: string
  ingest_log?: Record<string, unknown>
}

// ---- HTML Content Area Extraction ----

function extractContentArea(html: string): string {
  const match = html.match(/<div class="mw-parser-output">([\s\S]+)<\/div>\s*(?:<div class="(?:page-footer|content-footer)|<noscript|<!--\s*NewPP)/i)
  if (match) return match[1]
  const simple = html.match(/<div class="mw-parser-output">([\s\S]+?)<\/div>\s*<\/div>/i)
  return simple ? simple[1] : html
}

// ---- HTML Fetching + Cleaning ----

async function fetchHtml(url: string): Promise<{ html: string; resolvedUrl: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'HobBot-Grimoire/2.0 (knowledge-ingest)' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    return { html: await response.text(), resolvedUrl: response.url }
  } finally {
    clearTimeout(timeoutId)
  }
}

function stripHtmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|blockquote|article|section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()

  return text
}

// ---- Wiki Section Parsing ----

interface WikiSection {
  heading: string
  content: string
  categoryHint: string | null
}

const DROP_SECTIONS = new Set([
  'gallery', 'external links', 'references', 'categories', 'see also',
  'navigation', 'contents', 'site navigation',
  'videos', 'explore properties', 'follow us',
])

function isInfobox(content: string): boolean {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  if (lines.length < 3) return false
  const whitespaceRatio = (content.match(/\s/g) || []).length / content.length
  return whitespaceRatio > 0.6 && lines.length > 5 && lines.every(l => l.trim().length < 80)
}

function isProseChunk(content: string): boolean {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return false

  const proseLines = lines.filter(l =>
    l.includes('.') || l.includes('?') || l.includes('!') || l.trim().length > 80
  )
  const proseRatio = proseLines.length / lines.length
  if (proseRatio < 0.3) return false

  const avgLineLen = lines.reduce((sum, l) => sum + l.trim().length, 0) / lines.length
  if (avgLineLen < 50 && lines.length > 5) return false

  return true
}

const SECTION_CATEGORY_MAP: Record<string, string> = {
  'visual': 'style.genre', 'aesthetic': 'style.genre', 'visuals': 'style.genre',
  'color': 'color.palette', 'palette': 'color.palette', 'colors': 'color.palette',
  'history': 'narrative.mood', 'origin': 'narrative.mood', 'origins': 'narrative.mood',
  'background': 'narrative.mood', 'fashion': 'covering.clothing',
  'clothing': 'covering.clothing', 'architecture': 'environment.setting',
  'interior': 'environment.setting', 'media': 'reference.character',
  'film': 'reference.character', 'music': 'narrative.mood',
  'philosophy': 'narrative.mood', 'technology': 'style.medium',
  'photography': 'style.medium',
}

function inferCategory(heading: string): string | null {
  const lower = heading.toLowerCase()
  for (const [keyword, category] of Object.entries(SECTION_CATEGORY_MAP)) {
    if (lower.includes(keyword)) return category
  }
  return null
}

function stripInnerTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

function parseWikiSections(contentHtml: string, pageTitle: string): WikiSection[] {
  const h2Pattern = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
  const headings: { heading: string; startIndex: number }[] = []
  let match: RegExpExecArray | null

  while ((match = h2Pattern.exec(contentHtml)) !== null) {
    headings.push({
      heading: stripInnerTags(match[1]),
      startIndex: match.index + match[0].length,
    })
  }

  const rawSections: { heading: string; html: string }[] = []

  const introEnd = headings.length > 0 ? contentHtml.indexOf('<h2') : contentHtml.length
  if (introEnd > 0) {
    rawSections.push({ heading: pageTitle, html: contentHtml.slice(0, introEnd) })
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].startIndex
    const end = i + 1 < headings.length ? contentHtml.indexOf('<h2', start) : contentHtml.length
    rawSections.push({ heading: headings[i].heading, html: contentHtml.slice(start, end) })
  }

  const cleaned: WikiSection[] = []

  for (const section of rawSections) {
    const headingLower = section.heading.toLowerCase().replace(/\[\]$/, '').trim()
    if (DROP_SECTIONS.has(headingLower)) continue
    if (headingLower.includes('explore properties') || headingLower.includes('follow us')) continue

    const text = stripHtmlToText(section.html)
    if (!text || text.length < 50) continue

    const linkCount = (section.html.match(/<a /gi) || []).length
    const wordCount = text.split(/\s+/).length
    if (linkCount > 0 && wordCount > 0 && linkCount / wordCount > 0.5) continue

    const categoryHint = inferCategory(section.heading)

    if (text.length > 1500) {
      const paragraphs = text.split(/\n\n+/)
      let chunk = ''
      let chunkIdx = 0
      for (const para of paragraphs) {
        if (chunk.length + para.length > 1500 && chunk.length >= 200) {
          cleaned.push({
            heading: chunkIdx === 0 ? section.heading : `${section.heading} (cont.)`,
            content: chunk.trim(),
            categoryHint,
          })
          chunk = ''
          chunkIdx++
        }
        chunk += (chunk ? '\n\n' : '') + para
      }
      if (chunk.trim().length >= 50) {
        cleaned.push({
          heading: chunkIdx === 0 ? section.heading : `${section.heading} (cont.)`,
          content: chunk.trim(),
          categoryHint,
        })
      }
    } else {
      cleaned.push({ heading: section.heading, content: text, categoryHint })
    }
  }

  const merged: WikiSection[] = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].content.length < 200 && i + 1 < cleaned.length) {
      cleaned[i + 1] = {
        heading: cleaned[i + 1].heading,
        content: cleaned[i].content + '\n\n' + cleaned[i + 1].content,
        categoryHint: cleaned[i + 1].categoryHint ?? cleaned[i].categoryHint,
      }
    } else {
      merged.push(cleaned[i])
    }
  }

  return merged
}

// ---- Page Title Extraction ----

function extractPageTitle(contentHtml: string, url: string): string {
  const h1Match = contentHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1Match) return stripInnerTags(h1Match[1])

  const urlPath = new URL(url).pathname
  const slug = urlPath.split('/').pop() || 'Untitled'
  return slug.replace(/_/g, ' ')
}

// ---- Main Adapter ----

export async function fromUrl(
  env: UrlAdapterEnv,
  params: IngestFromUrlParams,
): Promise<UrlAdapterResult> {
  const handle = createGrimoireHandle(env.GRIMOIRE_DB)
  const dryRun = params.dry_run ?? false

  // Dedup check: pre-fetch on request URL
  const existing = await handle.ingestLogByUrl(params.url)
  if (existing && existing.status === 'complete' && !dryRun) {
    return {
      already_ingested: true,
      ingest_log: existing as unknown as Record<string, unknown>,
    }
  }

  // Create ingest log entry
  const logId = crypto.randomUUID()
  if (!dryRun) {
    await handle.ingestLogInsert({
      id: logId,
      url: params.url,
      source_type: params.source_type ?? 'aesthetic',
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

  // Fetch + extract content
  const fetchResult = await fetchHtml(params.url)
  const resolvedUrl = fetchResult.resolvedUrl
  const contentHtml = extractContentArea(fetchResult.html)
  const cleanedFullText = stripHtmlToText(contentHtml)
  const pageTitle = extractPageTitle(contentHtml, params.url)

  console.log(`[adapter:url] url=${params.url} resolvedUrl=${resolvedUrl} contentChars=${cleanedFullText.length} title="${pageTitle}"`)

  // Dedup check: post-fetch on resolved URL (catches wiki redirects)
  if (resolvedUrl !== params.url) {
    const existingResolved = await handle.ingestLogByUrl(resolvedUrl)
    if (existingResolved && existingResolved.status === 'complete' && !dryRun) {
      return {
        already_ingested: true,
        ingest_log: existingResolved as unknown as Record<string, unknown>,
      }
    }
    // Update log with resolved URL
    if (!dryRun) {
      await handle.ingestLogUpdate(logId, { url: resolvedUrl })
    }
  }

  // Parse into sections
  const rawSections = parseWikiSections(contentHtml, pageTitle)
  const sections = rawSections.filter(s => !isInfobox(s.content) && isProseChunk(s.content))

  console.log(`[adapter:url] raw=${rawSections.length} kept=${sections.length}`)

  // Build content blocks
  const content_blocks: ContentBlock[] = sections.map(s => ({
    heading: s.heading,
    content: s.content,
    token_count: Math.ceil(s.content.length / 4),
  }))

  const doc: NormalizedDocument = {
    title: pageTitle,
    content_blocks,
    source_url: resolvedUrl,
    source_type: params.source_type ?? 'aesthetic',
    mime_type: 'text/html',
    tags: [...(params.tags ?? []), params.source_type ?? 'aesthetic'],
    provenance: {
      adapter: 'url',
      fetched_at: new Date().toISOString(),
      original_url: params.url,
      collection_slug: params.collection_slug,
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
