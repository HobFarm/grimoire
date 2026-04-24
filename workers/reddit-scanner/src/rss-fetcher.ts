// RSS-based Reddit feed fetcher. Zero external dependencies.
// Reddit exposes public Atom feeds at https://www.reddit.com/r/{sub}/{sort}/.rss
// No auth required. No rate limit headers. 200ms courtesy delay between requests.

import type { RedditPost } from './types'
import { USER_AGENT, REQUEST_DELAY_MS } from './config'

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Fetch an RSS feed from Reddit and parse into RedditPost[].
 * URL pattern: https://www.reddit.com/r/{sub}/{sort}/.rss?limit=N
 * For top sort, add &t=day for daily top posts.
 */
export async function fetchRssFeed(
  subreddit: string,
  sort: string,
  limit: number,
  options?: { timeWindow?: string },
): Promise<RedditPost[]> {
  let url = `https://www.reddit.com/r/${subreddit}/${sort}/.rss?limit=${limit}`
  if (options?.timeWindow) url += `&t=${options.timeWindow}`

  // Try www.reddit.com first, fall back to old.reddit.com if blocked (403).
  // Reddit blocks some Cloudflare Worker IPs on www; old.reddit.com is more permissive.
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/atom+xml,application/xml,text/xml',
  }

  let response = await fetch(url, { headers })

  if (response.status === 403) {
    const fallbackUrl = url.replace('https://www.reddit.com', 'https://old.reddit.com')
    console.log(`[rss-fetcher] 403 from www, trying old.reddit.com for r/${subreddit}/${sort}`)
    response = await fetch(fallbackUrl, { headers })
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`RSS fetch failed (${response.status}) for r/${subreddit}/${sort}: ${body.slice(0, 300)}`)
  }

  const xml = await response.text()
  return parseAtomFeed(xml, subreddit)
}

/**
 * Parse Reddit Atom XML into RedditPost[].
 * Reddit feeds are well-structured Atom: split on <entry>, extract fields with regex.
 * No external XML parser needed.
 *
 * Atom entry structure:
 *   <entry>
 *     <id>t3_xxxx</id>
 *     <title>Post title</title>
 *     <content type="html">HTML-encoded body</content>
 *     <link href="permalink"/>
 *     <published>ISO 8601</published>
 *     <category term="subreddit" label="r/subreddit"/>
 *     <author><name>/u/username</name></author>
 *   </entry>
 *
 * RSS does NOT expose: score, comment count, or flair.
 * These fields are set to 0/null in the output.
 */
function parseAtomFeed(xml: string, subreddit: string): RedditPost[] {
  const entries = xml.split('<entry>').slice(1) // skip feed header
  const posts: RedditPost[] = []

  for (const entry of entries) {
    const id = extractTag(entry, 'id')?.replace(/^t3_/, '') ?? ''
    const title = decodeXmlEntities(extractTag(entry, 'title') ?? '')
    const contentHtml = extractTag(entry, 'content') ?? ''
    const permalink = extractAttr(entry, 'link', 'href') ?? ''
    const published = extractTag(entry, 'published') ?? ''

    if (!id || !title) continue

    // Extract plain text body from HTML content
    const selftext = extractBodyText(decodeXmlEntities(contentHtml))

    posts.push({
      id,
      title,
      selftext,
      score: 0,           // Not available in RSS
      num_comments: 0,     // Not available in RSS
      permalink,
      created_utc: published ? Math.floor(new Date(published).getTime() / 1000) : 0,
      link_flair_text: null, // Not available in RSS
      subreddit,
    })
  }

  return posts
}

/**
 * Extract text content of a simple XML tag.
 * Handles both <tag>value</tag> and CDATA/encoded content.
 */
function extractTag(xml: string, tag: string): string | null {
  // Match tag with optional attributes (e.g., <content type="html">)
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)
  const match = xml.match(regex)
  return match ? match[1].trim() : null
}

/**
 * Extract an attribute value from a self-closing or opening tag.
 * e.g., extractAttr(xml, 'link', 'href') for <link href="..."/>
 */
function extractAttr(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*?${attr}="([^"]*)"`)
  const match = xml.match(regex)
  return match ? match[1] : null
}

/**
 * Extract readable body text from Reddit's HTML content.
 * The content field wraps post body in <div class="md">...</div> inside a table.
 * Strip all HTML tags and decode entities to get plain text.
 */
function extractBodyText(html: string): string {
  // Extract content from the markdown div if present
  const mdMatch = html.match(/<div class="md">([\s\S]*?)<\/div>/)
  const source = mdMatch ? mdMatch[1] : html

  // Strip HTML tags
  let text = source.replace(/<[^>]+>/g, ' ')

  // Strip URLs (they waste tokens and confuse extraction)
  text = text.replace(/https?:\/\/[^\s)]+/g, '')

  // Strip "submitted by /u/username [link] [comments]" boilerplate
  text = text.replace(/submitted by\s+\/u\/\S+/g, '')
  text = text.replace(/\[link\]/g, '').replace(/\[comments\]/g, '')

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()

  // Truncate very long bodies
  if (text.length > 1000) text = text.slice(0, 1000) + '...'

  return text
}

/**
 * Decode common XML/HTML entities.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#32;/g, ' ')
    .replace(/&apos;/g, "'")
}
