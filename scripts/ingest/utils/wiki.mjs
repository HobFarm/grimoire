/**
 * Wikipedia plaintext fetcher.
 * Uses MediaWiki API with explaintext=true for clean text output.
 */

import { sleep } from './env.mjs';

const API_BASE = 'https://en.wikipedia.org/w/api.php';

/**
 * Fetch plaintext content of a Wikipedia page.
 * @param {string} pageTitle - Wikipedia page title (underscores or spaces)
 * @returns {{ title: string, text: string, url: string }}
 */
export async function fetchWikiPlaintext(pageTitle) {
  const params = new URLSearchParams({
    action: 'query',
    titles: pageTitle,
    prop: 'extracts',
    explaintext: 'true',
    redirects: 'true',
    format: 'json',
    origin: '*',
  });

  const res = await fetch(`${API_BASE}?${params}`);
  if (!res.ok) {
    throw new Error(`Wikipedia API ${res.status} for "${pageTitle}"`);
  }

  const data = await res.json();
  const pages = data.query.pages;
  const pageId = Object.keys(pages)[0];

  if (pageId === '-1') {
    throw new Error(`Wikipedia page not found: "${pageTitle}"`);
  }

  const page = pages[pageId];
  let text = page.extract || '';
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`;

  // Cap at 30K chars to avoid massive redirect articles (e.g., Aztec_art -> Aztecs = 98K)
  // 30K is ~10 chunks at 3K each = ~10 Gemini calls per page, reasonable budget.
  if (text.length > 30000) {
    console.log(`  [wiki] Truncating ${page.title} from ${text.length} to 30000 chars`);
    // Cut at paragraph boundary
    const cutoff = text.lastIndexOf('\n\n', 30000);
    text = cutoff > 0 ? text.slice(0, cutoff) : text.slice(0, 30000);
  }

  return { title: page.title, text, url };
}

/**
 * Split text into chunks of roughly maxChars, breaking at paragraph boundaries.
 */
export function chunkText(text, maxChars = 3000) {
  const paragraphs = text.split('\n\n');
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n\n';
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}
