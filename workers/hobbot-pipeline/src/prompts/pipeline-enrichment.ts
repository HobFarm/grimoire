// Enrichment agent prompt: per-chunk enrichment + concept extraction
// Replaces both AESTHETIC/DOMAIN_EXTRACTION_PROMPT (page-level) and buildChunkEnrichmentPrompt (cron-deferred)

export function buildEnrichmentPrompt(
  categories: { slug: string }[],
  arrangements: { slug: string; name: string }[],
): string {
  const categorySlugs = categories.map(c => c.slug).join(', ')
  const arrangementList = arrangements.map(a => `${a.slug} (${a.name})`).join(', ')

  return `You are enriching a knowledge chunk from a creative vocabulary system. Given a chunk of text and its document title, produce structured metadata and extract key concepts.

## Your Tasks

1. **Summary**: Write one specific, concrete sentence describing what this chunk contains. Not vague. Not generic.

2. **Category**: Pick the single best-matching category slug from the list below, or null if none fit.

3. **Arrangements**: Pick 0-4 arrangement slugs from the list below that are most relevant to this chunk's visual/aesthetic content.

4. **Quality Score**: Rate 0.0-1.0 based on knowledge density. High: rich descriptive content with specific details, techniques, named references. Low: stub text, lists without context, navigation fragments.

5. **Key Concepts**: Extract concrete vocabulary terms from this chunk. These are visual descriptors, techniques, materials, named references, or domain terms that could serve as index entries in a creative vocabulary system.
   - Single terms or 2-3 word phrases only
   - Must exist in or be directly implied by the text
   - Do not invent terms
   - Include a category_hint (best-guess category slug) for each
   - Mark proper nouns (people, places, named works, movements)
   - Max 15 concepts per chunk

## Available Category Slugs
${categorySlugs}

## Available Arrangement Slugs
${arrangementList}

## Output Format

Respond with ONLY a JSON object:
{
  "summary": "One concrete sentence",
  "category_slug": "best.matching.slug" or null,
  "arrangement_slugs": ["slug1", "slug2"],
  "quality_score": 0.85,
  "key_concepts": [
    { "term": "term text", "category_hint": "category.slug" or null, "is_proper_noun": false }
  ]
}`
}

export function buildEnrichmentUserMessage(
  chunkContent: string,
  documentTitle: string,
  chunkHeading: string,
): string {
  const content = chunkContent.slice(0, 3000)
  return `Document: "${documentTitle}"
Section: "${chunkHeading}"

---
${content}`
}
