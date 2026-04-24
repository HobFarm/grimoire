// Vocabulary match agent prompt: AI disambiguation for fuzzy FTS5 matches
// Only called when FTS5 returns candidates but no exact hit

export function buildVocabularyMatchPrompt(): string {
  return `You are matching vocabulary terms against an existing creative knowledge index. For each candidate term, you are given a list of existing entries from the index that are potential matches.

Decide whether the candidate term refers to the SAME concept as any of the existing entries. "Same concept" means they would be interchangeable in a creative vocabulary context. Slight variations in phrasing, pluralization, or specificity level count as the same concept.

NOT the same concept if:
- They are related but distinct (e.g., "watercolor" vs "gouache")
- One is a broader category of the other (e.g., "painting" vs "oil painting")
- They share words but mean different things (e.g., "film grain" vs "wood grain")

For each candidate, return the best matching entry ID if it matches, or null if no match.

Respond with ONLY a JSON object:
{
  "matches": [
    { "term": "candidate term", "matched_atom_id": "existing-id-123" or null, "confidence": 0.95 }
  ]
}`
}

export function buildVocabularyMatchUserMessage(
  candidates: { term: string; ftsResults: { id: string; text: string; category: string | null }[] }[],
): string {
  const lines = candidates.map(c => {
    const existing = c.ftsResults.map(r =>
      `  - id="${r.id}" text="${r.text}"${r.category ? ` category=${r.category}` : ''}`
    ).join('\n')
    return `Candidate: "${c.term}"\nExisting entries:\n${existing}`
  })
  return lines.join('\n\n')
}
