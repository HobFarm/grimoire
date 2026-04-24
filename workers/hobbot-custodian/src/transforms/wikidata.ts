import type { AtomCandidate } from '../harvesters/base'

export interface WikidataDomain {
  id: string
  name: string
  category: string | null
  query: string // SPARQL template with {BATCH_SIZE} and {OFFSET} placeholders
}

export const WIKIDATA_DOMAINS: WikidataDomain[] = [
  {
    id: 'art-movements',
    name: 'Art Movements',
    category: 'style.genre',
    query: `
      SELECT ?item ?itemLabel ?description ?inception ?influencedByLabel ?influencedByItem
      WHERE {
        ?item wdt:P31 wd:Q968159 .
        OPTIONAL { ?item wdt:P571 ?inception }
        OPTIONAL { ?item wdt:P737 ?influencedBy .
          BIND(?influencedBy AS ?influencedByItem)
        }
        OPTIONAL { ?item schema:description ?description
          FILTER(LANG(?description) = "en") }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      ORDER BY ?item
      LIMIT {BATCH_SIZE} OFFSET {OFFSET}
    `,
  },
  {
    id: 'techniques',
    name: 'Visual Arts Techniques',
    category: 'reference.technique',
    query: `
      SELECT ?item ?itemLabel ?description
      WHERE {
        ?item wdt:P31/wdt:P279* wd:Q11076732 .
        OPTIONAL { ?item schema:description ?description
          FILTER(LANG(?description) = "en") }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      ORDER BY ?item
      LIMIT {BATCH_SIZE} OFFSET {OFFSET}
    `,
  },
  {
    id: 'film-noir',
    name: 'Film Noir and Cinematography',
    category: null,
    query: `
      SELECT ?film ?filmLabel ?directorLabel ?cinematographerLabel ?year
      WHERE {
        ?film wdt:P31 wd:Q11424 ;
              wdt:P136 wd:Q186472 .
        OPTIONAL { ?film wdt:P57 ?director }
        OPTIONAL { ?film wdt:P344 ?cinematographer }
        OPTIONAL { ?film wdt:P577 ?date . BIND(YEAR(?date) AS ?year) }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      ORDER BY ?film
      LIMIT {BATCH_SIZE} OFFSET {OFFSET}
    `,
  },
  {
    id: 'architecture-styles',
    name: 'Architectural Styles',
    category: 'environment.prop',
    query: `
      SELECT ?item ?itemLabel ?description ?inception
      WHERE {
        ?item wdt:P31 wd:Q32880 .
        OPTIONAL { ?item schema:description ?description
          FILTER(LANG(?description) = "en") }
        OPTIONAL { ?item wdt:P571 ?inception }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      ORDER BY ?item
      LIMIT {BATCH_SIZE} OFFSET {OFFSET}
    `,
  },
  {
    id: 'materials',
    name: 'Art Materials and Media',
    category: 'covering.material',
    query: `
      SELECT ?item ?itemLabel ?description
      WHERE {
        ?item wdt:P31/wdt:P279* wd:Q214609 .
        OPTIONAL { ?item schema:description ?description
          FILTER(LANG(?description) = "en") }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      ORDER BY ?item
      LIMIT {BATCH_SIZE} OFFSET {OFFSET}
    `,
  },
  {
    id: 'color-concepts',
    name: 'Color Concepts',
    category: 'covering.palette',
    query: `
      SELECT ?item ?itemLabel ?description
      WHERE {
        ?item wdt:P31/wdt:P279* wd:Q1075 .
        OPTIONAL { ?item schema:description ?description
          FILTER(LANG(?description) = "en") }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      ORDER BY ?item
      LIMIT {BATCH_SIZE} OFFSET {OFFSET}
    `,
  },
]

interface WikidataBinding {
  item?: { type: string; value: string }
  itemLabel?: { type: string; value: string }
  film?: { type: string; value: string }
  filmLabel?: { type: string; value: string }
  description?: { type: string; value: string }
  inception?: { type: string; value: string }
  influencedByLabel?: { type: string; value: string }
  influencedByItem?: { type: string; value: string }
  directorLabel?: { type: string; value: string }
  cinematographerLabel?: { type: string; value: string }
  year?: { type: string; value: string }
}

export interface WikidataSparqlResults {
  results: {
    bindings: WikidataBinding[]
  }
}

const UNRESOLVED_QID = /^Q\d+$/

export function transformWikidataResults(
  data: WikidataSparqlResults,
  domain: WikidataDomain,
): AtomCandidate[] {
  const candidates: AtomCandidate[] = []
  const isFilmNoir = domain.id === 'film-noir'
  const isArtMovements = domain.id === 'art-movements'

  // For art-movements, group influenced_by per item URI
  const influencedByMap = new Map<string, { label: string; wikidata_uri: string }[]>()

  for (const binding of data.results.bindings) {
    const uri = isFilmNoir
      ? binding.film?.value
      : binding.item?.value
    const label = isFilmNoir
      ? binding.filmLabel?.value?.trim()
      : binding.itemLabel?.value?.trim()

    if (!uri || !label) continue
    if (UNRESOLVED_QID.test(label)) continue
    if (label.length < 2 || label.split(/\s+/).length > 10) continue

    // Collect influenced_by relationships for grouping
    if (isArtMovements && binding.influencedByLabel?.value) {
      const ibLabel = binding.influencedByLabel.value.trim()
      if (!UNRESOLVED_QID.test(ibLabel)) {
        const existing = influencedByMap.get(uri) ?? []
        const ibUri = binding.influencedByItem?.value ?? ''
        if (!existing.some(e => e.label === ibLabel)) {
          existing.push({ label: ibLabel, wikidata_uri: ibUri })
          influencedByMap.set(uri, existing)
        }
      }
    }

    // Avoid duplicate candidates for the same URI (art-movements can have multiple influenced_by rows)
    if (candidates.some(c => c.external_uri === uri)) continue

    const metadata: Record<string, unknown> = {
      wikidata_uri: uri,
      domain: domain.id,
    }

    if (binding.description?.value) metadata.description = binding.description.value
    if (binding.inception?.value) metadata.inception = binding.inception.value

    if (isFilmNoir) {
      if (binding.directorLabel?.value && !UNRESOLVED_QID.test(binding.directorLabel.value)) {
        metadata.director = binding.directorLabel.value.trim()
      }
      if (binding.cinematographerLabel?.value && !UNRESOLVED_QID.test(binding.cinematographerLabel.value)) {
        metadata.cinematographer = binding.cinematographerLabel.value.trim()
      }
      if (binding.year?.value) metadata.year = parseInt(binding.year.value, 10)
    }

    candidates.push({
      text: label,
      collection_slug: 'wikidata',
      source: 'seed',
      source_app: 'hobbot-harvester',
      category_slug: domain.category,
      metadata,
      external_uri: uri,
    })
  }

  // Back-fill influenced_by into art-movement candidates
  if (isArtMovements) {
    for (const candidate of candidates) {
      const influences = influencedByMap.get(candidate.external_uri)
      if (influences && influences.length > 0) {
        (candidate.metadata as Record<string, unknown>).influenced_by = influences
      }
    }
  }

  return candidates
}
