// Prompt construction for AI-powered Grimoire validation
// Used by grimoire/immune.ts when structural checks pass but AI judgment is needed

export function getDuplicateCheckPrompt(candidateText: string, existingText: string, collection: string): string {
  return `Are these two grimoire entries semantically equivalent?

Collection: ${collection}
Entry A: "${candidateText}"
Entry B: "${existingText}"

Respond with JSON only:
{
  "duplicate": boolean,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}

Duplicate means: same core concept, even if phrased differently. Not duplicate means: meaningfully distinct ideas or applications.`
}

export function getCoverageGapPrompt(categorySlug: string, existingAtoms: string[]): string {
  const sampleAtoms = existingAtoms.slice(0, 10).join('\n- ')
  return `Review these grimoire atoms in category '${categorySlug}':
- ${sampleAtoms}

Identify any significant coverage gaps: concepts that should exist in this category but are missing.

Respond with JSON only:
{
  "gaps": ["description of gap 1", "description of gap 2"],
  "coverage_score": 0.0-1.0
}`
}
