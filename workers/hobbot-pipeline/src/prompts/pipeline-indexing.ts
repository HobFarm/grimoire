// Indexing agent prompt: classify unmatched concepts into vocabulary entries

export function buildIndexingPrompt(
  categories: { slug: string }[],
  arrangements: { slug: string; name: string }[],
): string {
  const categorySlugs = categories.map(c => c.slug).join(', ')
  const arrangementList = arrangements.map(a => a.slug).join(', ')

  return `You are creating new vocabulary index entries for a creative knowledge system. Each entry is a lookup key that helps the system find relevant knowledge chunks.

For each concept, classify it into the system's taxonomy:

1. **category_slug**: Best matching category from the list below.
2. **collection_slug**: Use "uncategorized" unless you are certain of a better fit.
3. **observation**: Always "observation".
4. **modality**: One of: visual, conceptual, atmospheric, technical, reference.
5. **arrangement_slugs**: 0-3 arrangement slugs most associated with this concept.
6. **harmonic_hints**: Score 0.0-1.0 for each dimension:
   - hardness: 0=soft/organic/flowing, 1=hard/geometric/rigid
   - temperature: 0=cool/clinical, 1=warm/intimate/organic
   - weight: 0=light/airy/minimal, 1=heavy/dense/substantial
   - formality: 0=casual/raw/spontaneous, 1=formal/refined/structured
   - era_affinity: 0=ancient/historical, 1=contemporary/digital

## Available Category Slugs
${categorySlugs}

## Available Arrangement Slugs
${arrangementList}

Respond with ONLY a JSON object:
{
  "entries": [
    {
      "term": "the concept term",
      "category_slug": "best.category",
      "collection_slug": "uncategorized",
      "observation": "observation",
      "modality": "visual",
      "arrangement_slugs": ["slug1"],
      "harmonic_hints": { "hardness": 0.5, "temperature": 0.5, "weight": 0.5, "formality": 0.5, "era_affinity": 0.5 }
    }
  ]
}`
}

export function buildIndexingUserMessage(
  concepts: { term: string; categoryHint: string | null; isProperNoun: boolean }[],
): string {
  const lines = concepts.map(c =>
    `- "${c.term}"${c.categoryHint ? ` (hint: ${c.categoryHint})` : ''}${c.isProperNoun ? ' [proper noun]' : ''}`
  )
  return `Classify these concepts as vocabulary index entries:\n\n${lines.join('\n')}`
}
