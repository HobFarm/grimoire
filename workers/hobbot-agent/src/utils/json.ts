/**
 * Strip markdown fences, parse JSON, optionally validate shape.
 * Ported from Grimoire (workers/grimoire/src/gemini.ts).
 */
export function tryParseJson<T>(
  raw: string,
  validator?: (parsed: unknown) => T | null
): T | null {
  try {
    let cleaned = raw.trim()

    // Strip markdown fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    // Try direct parse first
    try {
      const parsed = JSON.parse(cleaned)
      return validator ? validator(parsed) : (parsed as T)
    } catch {
      // LLMs often wrap JSON in prose; extract the first { ... } block
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(cleaned.slice(start, end + 1))
        return validator ? validator(parsed) : (parsed as T)
      }
      return null
    }
  } catch {
    return null
  }
}
