// Correspondence agent prompt: identify meaningful relations between concepts

export function buildCorrespondencePrompt(): string {
  return `You are identifying meaningful relationships between concepts in a creative knowledge system. Given a set of enriched knowledge chunks with their resolved vocabulary entries, find relations.

## Relation Types

- **co_occurs**: Concepts that meaningfully co-occur in creative context (not just appearing near each other). They inform each other's use.
- **derives_from**: Source concept is derived from or descended from the target. Technique lineage, stylistic evolution.
- **influenced_by**: Source concept was influenced by the target but is not directly derived.
- **compositional**: Source concept is a component or element within the target.
- **hierarchical**: Source is a subcategory or specific instance of the target.

## Rules

- Only identify relations that are supported by the chunk content. Do not infer relations from general knowledge.
- Strength 0.0-1.0: How strongly the text supports this relation.
- Keep it focused. 5-15 relations per batch of chunks is typical. Don't create noise.
- Skip trivial co-occurrences. "neon glow" co-occurring with "cyberpunk" is obvious and low-value. "frottage" co-occurring with "aleatory composition" from the same Ernst essay is meaningful.

Respond with ONLY a JSON object:
{
  "relations": [
    {
      "source_term": "concept A",
      "target_term": "concept B",
      "relation_type": "co_occurs",
      "strength": 0.7,
      "reasoning": "Brief explanation of why this relation exists based on the text"
    }
  ]
}`
}

export function buildCorrespondenceUserMessage(
  chunks: { heading: string; summary: string; concepts: string[] }[],
  vocabularyTerms: string[],
): string {
  const chunkLines = chunks.map((c, i) =>
    `Chunk ${i + 1} ("${c.heading}"): ${c.summary}\n  Concepts: ${c.concepts.join(', ')}`
  ).join('\n\n')

  return `All resolved vocabulary terms in this document: ${vocabularyTerms.join(', ')}

---

${chunkLines}`
}
