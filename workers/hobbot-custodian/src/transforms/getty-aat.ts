import type { AtomCandidate } from '../harvesters/base'

interface SparqlBinding {
  concept: { type: string; value: string }
  term: { type: string; value: string }
  broaderUri?: { type: string; value: string }
  broaderTerm?: { type: string; value: string }
  scopeNote?: { type: string; value: string }
}

interface SparqlResults {
  results: {
    bindings: SparqlBinding[]
  }
}

// Map broader URIs to Grimoire categories by checking the AAT hierarchy path.
// broaderUri gives us one level up; we use known facet root URIs to determine category.
const FACET_CATEGORY_MAP: Record<string, string> = {
  // Techniques subtree markers
  '300053001': 'reference.technique', // painting techniques
  '300054143': 'reference.technique', // surface treatment
  '300053949': 'reference.technique', // transferring techniques
  '300053847': 'reference.technique', // printing processes
  '300069293': 'reference.technique', // image-making processes
  '300015058': 'reference.technique', // Techniques and Processes root
  // Materials subtree markers
  '300010357': 'covering.material',   // Materials root
  '300014744': 'covering.material',   // pigments
  '300010358': 'covering.material',   // materials by composition
  // Styles and Periods subtree markers
  '300069424': 'style.genre',         // Styles and Periods root
  '300264086': 'style.medium',        // Visual Works root (use style.medium as best fit)
  // Components subtree markers
  '300054156': 'environment.prop',    // Components root
}

function guessCategoryFromBroader(broaderUri: string | undefined): string | null {
  if (!broaderUri) return null
  // Extract the AAT numeric ID from the URI
  const match = broaderUri.match(/\/aat\/(\d+)$/)
  if (!match) return null
  return FACET_CATEGORY_MAP[match[1]] ?? null
}

export function transformSparqlResults(data: SparqlResults): AtomCandidate[] {
  const candidates: AtomCandidate[] = []

  for (const binding of data.results.bindings) {
    const text = binding.term.value.trim()

    // Skip terms that are too short
    if (text.length < 2) continue

    // Skip terms with more than 6 words (likely scope note leakage, not a real term)
    if (text.split(/\s+/).length > 6) continue

    const conceptUri = binding.concept.value
    const broaderUri = binding.broaderUri?.value
    const broaderTerm = binding.broaderTerm?.value
    const scopeNote = binding.scopeNote?.value

    const category = guessCategoryFromBroader(broaderUri)

    candidates.push({
      text,
      collection_slug: 'getty-aat',
      source: 'seed',
      source_app: 'hobbot-harvester',
      category_slug: category,
      metadata: {
        aat_uri: conceptUri,
        ...(scopeNote && { scope_note: scopeNote }),
        ...(broaderTerm && { broader_term: broaderTerm }),
        ...(broaderUri && { broader_uri: broaderUri }),
      },
      external_uri: conceptUri,
    })
  }

  return candidates
}
