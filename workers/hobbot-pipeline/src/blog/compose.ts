// Phase 3: generate blog post via Workers AI (Nemotron primary, Gemini fallback)

import { BLOG_CHARACTER_BRIEF } from './character'
import { callWithJsonParse, type TokenUsageReport } from '@shared/providers/call-with-json-parse'
import { MODELS } from '@shared/models'
import type { SourceResult, EnrichResult, ComposeOutput } from './types'

function deriveSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function buildUserPrompt(source: SourceResult, enrich: EnrichResult): string {
  const atomLines = enrich.atoms.length
    ? enrich.atoms.map(a => `  - ${a.label} (${a.category})`).join('\n')
    : '  (none)'

  const corrLines = enrich.correspondences.length
    ? enrich.correspondences.map(c => `  - ${c.from} <-> ${c.to} (strength: ${c.strength.toFixed(2)})`).join('\n')
    : '  (none)'

  const wordTarget = source.content_type === 'grimoire_spotlight' ? '200-400' : '400-800'

  return `Generate a blog post for the following source material.

SOURCE CONTENT:
${source.sourceContent}

TARGET CATEGORY: ${source.category}
CHANNEL: ${source.channel}
WORD TARGET: ${wordTarget} words

GRIMOIRE CONTEXT:
Relevant atoms:
${atomLines}

Correspondences:
${corrLines}${enrich.arrangement ? `\nSuggested arrangement: ${enrich.arrangement}` : ''}

Return a single JSON object with these exact fields:
{
  "title": string (10-100 chars),
  "slug": string (lowercase, hyphens only, max 60 chars),
  "excerpt": string (50-200 chars, one or two tight sentences),
  "body_md": string (full markdown, ${wordTarget} words, ## headers allowed, prose paragraphs only),
  "tags": string[] (1-8 items, lowercase with hyphens),
  "heroDirection": {
    "subject": string,
    "style": string,
    "mood": string,
    "palette": string
  }
}`
}

export async function composePost(
  source: SourceResult,
  enrich: EnrichResult,
  ai: Ai,
  geminiKey: string,
  onUsage?: (usage: TokenUsageReport) => void,
): Promise<ComposeOutput> {
  const { result } = await callWithJsonParse<Partial<ComposeOutput>>(
    'blog.compose',
    BLOG_CHARACTER_BRIEF,
    buildUserPrompt(source, enrich),
    ai,
    geminiKey,
    MODELS['blog.compose'],
    { onUsage },
  )

  // Ensure slug is derived from title if missing or invalid
  if (!result.slug || !/^[a-z0-9-]+$/.test(result.slug)) {
    result.slug = deriveSlug(result.title ?? '')
  }
  result.slug = result.slug.slice(0, 60)

  return result as ComposeOutput
}
