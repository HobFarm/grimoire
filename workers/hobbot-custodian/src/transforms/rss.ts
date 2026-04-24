// RSS/Atom XML parser for feed harvester.
// Lightweight: no external dependencies, handles RSS 2.0 and Atom formats.

export interface FeedItem {
  title: string
  url: string
  published_at: string | null
  description: string
}

/**
 * Parse RSS 2.0 or Atom XML into normalized FeedItem objects.
 * Uses regex-based extraction (no DOM parser needed in Workers runtime).
 */
export function parseFeedXml(xml: string): FeedItem[] {
  const items: FeedItem[] = []

  // Detect format
  const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"')

  if (isAtom) {
    // Atom format: <entry> elements
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi
    let match
    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1]
      const title = extractTag(entry, 'title')
      const link = extractAtomLink(entry) || extractTag(entry, 'id')
      const published = extractTag(entry, 'published') || extractTag(entry, 'updated')
      const summary = extractTag(entry, 'summary') || extractTag(entry, 'content')

      if (title && link) {
        items.push({
          title: decodeHtmlEntities(title),
          url: link,
          published_at: published,
          description: summary ? decodeHtmlEntities(summary).slice(0, 1000) : '',
        })
      }
    }
  } else {
    // RSS 2.0 format: <item> elements
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi
    let match
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1]
      const title = extractTag(item, 'title')
      const link = extractTag(item, 'link')
      const pubDate = extractTag(item, 'pubDate')
      const description = extractTag(item, 'description')

      if (title && link) {
        items.push({
          title: decodeHtmlEntities(title),
          url: link.trim(),
          published_at: pubDate ? new Date(pubDate).toISOString() : null,
          description: description ? decodeHtmlEntities(description).slice(0, 1000) : '',
        })
      }
    }
  }

  return items
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA sections
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i')
  const cdataMatch = cdataRegex.exec(xml)
  if (cdataMatch) return cdataMatch[1].trim()

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const match = regex.exec(xml)
  return match ? match[1].trim() : null
}

function extractAtomLink(entry: string): string | null {
  // Atom links: <link href="..." rel="alternate" />
  const linkRegex = /<link[^>]*href="([^"]+)"[^>]*>/gi
  let match
  let alternate: string | null = null
  let first: string | null = null

  while ((match = linkRegex.exec(entry)) !== null) {
    const tag = match[0]
    const href = match[1]
    if (!first) first = href
    if (tag.includes('rel="alternate"') || !tag.includes('rel=')) {
      alternate = href
    }
  }

  return alternate || first
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '') // strip remaining HTML tags
}
