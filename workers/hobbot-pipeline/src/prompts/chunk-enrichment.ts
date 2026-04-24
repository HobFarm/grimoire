// Prompt template for async chunk enrichment via Gemini
// Called by the cron pipeline to add summaries, validated categories, and arrangement tags to document chunks

export function buildChunkEnrichmentPrompt(
  categories: string[],
  arrangements: string[]
): string {
  return `You are enriching a document chunk from a creative knowledge base. Given the chunk content and document title, return structured metadata.

Available category slugs (pick the single best match):
${categories.join(', ')}

Available arrangement slugs (pick 0-4 that are most relevant):
${arrangements.join(', ')}

Respond with ONLY a JSON object:
{
  "summary": "One sentence summary of what this chunk describes. Be specific and concrete.",
  "category_slug": "best matching category slug from the list above, or null if none fit",
  "arrangement_slugs": ["matching arrangement slugs from the list above"]
}`
}
