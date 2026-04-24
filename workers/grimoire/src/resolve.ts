import { Hono } from 'hono'
import type {
  Env,
  ResolveRequest,
  ResolveResponse,
  ResolvedPhrase,
  ResolvedAtom,
  ResolveMatchType,
} from './types'
import { MODELS } from './models'
import { safeParseJSON } from './arrangement-tagger'

const EMBEDDING_MODEL = MODELS.embed.primary.model as Parameters<Ai['run']>[0]

const STOP_WORDS = new Set<string>([
  'the','a','an','of','in','on','with','and','or','for','to','by','from','as','at','into',
])

const SUFFIXES = ['ed','ing','ly','ness','tion','ment','ous','ive','ful','less','ity']

const MAX_PHRASES = 100
const MAX_TOKENS = 500
const D1_CHUNK = 80
const VECTORIZE_HYDRATE_CHUNK = 50
const SEMANTIC_TOP_K = 3
const DEFAULT_MIN_CONFIDENCE = 0.6
const PREFIX_CONFIDENCE = 0.9
const EXACT_CONFIDENCE = 1.0
const MIN_STEM_LENGTH = 3

const PUNCT_RE = /[^\p{L}\p{N}\s'-]/gu

export class ResolveError extends Error {
  status: 400 | 500
  constructor(message: string, status: 400 | 500 = 400) {
    super(message)
    this.status = status
  }
}

interface AtomLookupRow {
  id: string
  text: string
  text_lower: string
  category_slug: string | null
  harmonics: string
}

interface PhraseTokens {
  phrase: string
  tokens: string[]
  bigrams: Array<{ first: string; second: string; joined: string }>
}

function tokenizePhrase(phrase: string): PhraseTokens {
  const cleaned = phrase.toLowerCase().replace(PUNCT_RE, ' ')
  const rawTokens = cleaned.split(/\s+/).filter(Boolean)
  const tokens = rawTokens.filter(t => !STOP_WORDS.has(t))
  const bigrams: Array<{ first: string; second: string; joined: string }> = []
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push({ first: tokens[i], second: tokens[i + 1], joined: `${tokens[i]} ${tokens[i + 1]}` })
  }
  return { phrase, tokens, bigrams }
}

async function lookupByTextLower(
  db: D1Database,
  values: string[]
): Promise<Map<string, AtomLookupRow>> {
  const out = new Map<string, AtomLookupRow>()
  if (values.length === 0) return out

  const unique = Array.from(new Set(values))
  for (let i = 0; i < unique.length; i += D1_CHUNK) {
    const chunk = unique.slice(i, i + D1_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT id, text, text_lower, category_slug, harmonics
       FROM atoms
       WHERE status = 'confirmed' AND text_lower IN (${placeholders})`
    ).bind(...chunk).all<AtomLookupRow>()

    for (const row of results) {
      if (!out.has(row.text_lower)) out.set(row.text_lower, row)
    }
  }
  return out
}

function stemCandidates(token: string): string[] {
  const candidates = new Set<string>([token])
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= MIN_STEM_LENGTH && token.endsWith(suffix)) {
      candidates.add(token.slice(0, -suffix.length))
    }
  }
  return Array.from(candidates)
}

interface SemanticHit {
  atom: AtomLookupRow
  score: number
}

async function passSemantic(
  tokens: string[],
  minConfidence: number,
  env: Env
): Promise<Map<string, SemanticHit>> {
  const out = new Map<string, SemanticHit>()
  if (tokens.length === 0) return out

  // One embed call for all tokens.
  const embeddingResult = await env.AI.run(EMBEDDING_MODEL, { text: tokens }) as { data?: number[][] }
  if (!embeddingResult.data || embeddingResult.data.length !== tokens.length) {
    throw new ResolveError('Embedding service returned unexpected shape', 500)
  }
  const vectors = embeddingResult.data

  // Parallel Vectorize queries, one per token vector.
  const queryResults = await Promise.allSettled(
    vectors.map(vec => env.VECTORIZE.query(vec, {
      topK: SEMANTIC_TOP_K,
      returnMetadata: 'indexed',
      returnValues: false,
    }))
  )

  // Pick the best in-threshold match per token.
  const tokenToBestId = new Map<string, { id: string; score: number }>()
  const idsToHydrate = new Set<string>()
  queryResults.forEach((settled, i) => {
    if (settled.status === 'rejected') {
      console.error('[resolve] vectorize query failed:', settled.reason)
      return
    }
    const matches = settled.value.matches
    if (!matches || matches.length === 0) return
    const best = matches[0]
    if (best.score < minConfidence) return
    tokenToBestId.set(tokens[i], { id: best.id, score: best.score })
    idsToHydrate.add(best.id)
  })

  if (idsToHydrate.size === 0) return out

  // Hydrate atom rows from D1 (chunks of 50, matches searchAtoms()).
  const hydrated = new Map<string, AtomLookupRow>()
  const idArr = Array.from(idsToHydrate)
  for (let i = 0; i < idArr.length; i += VECTORIZE_HYDRATE_CHUNK) {
    const chunk = idArr.slice(i, i + VECTORIZE_HYDRATE_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT id, text, text_lower, category_slug, harmonics
       FROM atoms
       WHERE id IN (${placeholders}) AND status = 'confirmed'`
    ).bind(...chunk).all<AtomLookupRow>()
    for (const row of results) hydrated.set(row.id, row)
  }

  for (const [token, { id, score }] of tokenToBestId) {
    const atom = hydrated.get(id)
    if (atom) out.set(token, { atom, score })
  }
  return out
}

function toResolvedAtom(
  row: AtomLookupRow,
  matchType: ResolveMatchType,
  confidence: number,
  includeHarmonics: boolean
): ResolvedAtom {
  const out: ResolvedAtom = {
    id: row.id,
    text: row.text,
    category_slug: row.category_slug,
    match_type: matchType,
    confidence,
  }
  if (includeHarmonics) {
    out.harmonics = safeParseJSON<Record<string, number>>(row.harmonics, {})
  }
  return out
}

export async function resolvePhrasesToAtoms(
  phrases: string[],
  env: Env,
  options?: { minConfidence?: number; includeHarmonics?: boolean }
): Promise<ResolveResponse> {
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const includeHarmonics = options?.includeHarmonics ?? false

  if (phrases.length > MAX_PHRASES) {
    throw new ResolveError(`phrases array exceeds max of ${MAX_PHRASES}`)
  }

  const tokenized = phrases.map(tokenizePhrase)
  const totalTokens = tokenized.reduce((sum, p) => sum + p.tokens.length, 0)
  if (totalTokens > MAX_TOKENS) {
    throw new ResolveError(`total tokens (${totalTokens}) exceed max of ${MAX_TOKENS}`)
  }

  // --- Pass 1: exact match (tokens + bigrams) ---
  const allTokens: string[] = []
  const allBigrams: string[] = []
  for (const p of tokenized) {
    allTokens.push(...p.tokens)
    for (const bg of p.bigrams) allBigrams.push(bg.joined)
  }

  const tokenExact = await lookupByTextLower(env.DB, allTokens)
  const bigramExact = await lookupByTextLower(env.DB, allBigrams)

  // Per-phrase resolution state. Index parallels `tokenized`.
  interface PerPhraseState {
    matchedAtoms: Array<{ row: AtomLookupRow; type: ResolveMatchType; confidence: number; key: string }>
    consumedTokens: Set<number>  // token indexes already explained
  }

  const states: PerPhraseState[] = tokenized.map(() => ({
    matchedAtoms: [],
    consumedTokens: new Set<number>(),
  }))

  // Bigrams first (longer match wins): consume both component tokens.
  tokenized.forEach((p, phraseIdx) => {
    const state = states[phraseIdx]
    p.bigrams.forEach((bg, bigramIdx) => {
      const tokenIdx = bigramIdx
      if (state.consumedTokens.has(tokenIdx) || state.consumedTokens.has(tokenIdx + 1)) return
      const row = bigramExact.get(bg.joined)
      if (!row) return
      state.matchedAtoms.push({ row, type: 'exact', confidence: EXACT_CONFIDENCE, key: `bg:${bg.joined}` })
      state.consumedTokens.add(tokenIdx)
      state.consumedTokens.add(tokenIdx + 1)
    })
  })

  // Then tokens (exact).
  tokenized.forEach((p, phraseIdx) => {
    const state = states[phraseIdx]
    p.tokens.forEach((tok, tokenIdx) => {
      if (state.consumedTokens.has(tokenIdx)) return
      const row = tokenExact.get(tok)
      if (!row) return
      state.matchedAtoms.push({ row, type: 'exact', confidence: EXACT_CONFIDENCE, key: `tok:${tok}` })
      state.consumedTokens.add(tokenIdx)
    })
  })

  // --- Pass 2: prefix/stem on still-unresolved tokens ---
  const stemUnresolved = new Set<string>()
  tokenized.forEach((p, phraseIdx) => {
    const state = states[phraseIdx]
    p.tokens.forEach((tok, tokenIdx) => {
      if (state.consumedTokens.has(tokenIdx)) return
      stemUnresolved.add(tok)
    })
  })

  // Build union of all stem candidates -> map stem -> originating tokens.
  const stemToTokens = new Map<string, Set<string>>()
  for (const tok of stemUnresolved) {
    for (const candidate of stemCandidates(tok)) {
      let set = stemToTokens.get(candidate)
      if (!set) { set = new Set(); stemToTokens.set(candidate, set) }
      set.add(tok)
    }
  }

  const stemHits = await lookupByTextLower(env.DB, Array.from(stemToTokens.keys()))

  // For each unresolved token, pick the longest stem candidate that hit.
  const tokenStemMatch = new Map<string, AtomLookupRow>()
  for (const tok of stemUnresolved) {
    let bestCandidate: string | null = null
    let bestRow: AtomLookupRow | null = null
    for (const candidate of stemCandidates(tok)) {
      const row = stemHits.get(candidate)
      if (!row) continue
      if (!bestCandidate || candidate.length > bestCandidate.length) {
        bestCandidate = candidate
        bestRow = row
      }
    }
    if (bestRow) tokenStemMatch.set(tok, bestRow)
  }

  tokenized.forEach((p, phraseIdx) => {
    const state = states[phraseIdx]
    p.tokens.forEach((tok, tokenIdx) => {
      if (state.consumedTokens.has(tokenIdx)) return
      const row = tokenStemMatch.get(tok)
      if (!row) return
      state.matchedAtoms.push({ row, type: 'prefix', confidence: PREFIX_CONFIDENCE, key: `stem:${tok}` })
      state.consumedTokens.add(tokenIdx)
    })
  })

  // --- Pass 3: semantic via Vectorize on what's left ---
  const semanticUnresolved = new Set<string>()
  tokenized.forEach((p, phraseIdx) => {
    const state = states[phraseIdx]
    p.tokens.forEach((tok, tokenIdx) => {
      if (state.consumedTokens.has(tokenIdx)) return
      semanticUnresolved.add(tok)
    })
  })

  const semanticMatches = await passSemantic(Array.from(semanticUnresolved), minConfidence, env)

  tokenized.forEach((p, phraseIdx) => {
    const state = states[phraseIdx]
    p.tokens.forEach((tok, tokenIdx) => {
      if (state.consumedTokens.has(tokenIdx)) return
      const hit = semanticMatches.get(tok)
      if (!hit) return
      state.matchedAtoms.push({ row: hit.atom, type: 'semantic', confidence: hit.score, key: `sem:${tok}` })
      state.consumedTokens.add(tokenIdx)
    })
  })

  // --- Assemble response ---
  const results: ResolvedPhrase[] = tokenized.map((p, phraseIdx) => {
    const state = states[phraseIdx]
    const seen = new Set<string>()
    const atoms: ResolvedAtom[] = []
    for (const m of state.matchedAtoms) {
      if (seen.has(m.key)) continue
      seen.add(m.key)
      atoms.push(toResolvedAtom(m.row, m.type, m.confidence, includeHarmonics))
    }
    const unresolvedTokens = p.tokens.filter((_, i) => !state.consumedTokens.has(i))
    return { phrase: p.phrase, atoms, unresolved_tokens: unresolvedTokens }
  })

  let fully = 0, partial = 0, none = 0
  results.forEach((r, i) => {
    const tokenCount = tokenized[i].tokens.length
    const unresolvedCount = r.unresolved_tokens.length
    if (tokenCount === 0) { fully++; return }
    if (unresolvedCount === 0) fully++
    else if (unresolvedCount === tokenCount) none++
    else partial++
  })

  return {
    results,
    stats: {
      total_phrases: phrases.length,
      fully_resolved: fully,
      partially_resolved: partial,
      unresolved: none,
    },
  }
}

export const resolveApp = new Hono<{ Bindings: Env }>()

resolveApp.post('/', async (c) => {
  try {
    const body = await c.req.json<ResolveRequest>()
    if (!body || !Array.isArray(body.phrases)) {
      return c.json({ error: 'phrases must be an array of strings' }, 400)
    }
    if (body.phrases.some(p => typeof p !== 'string')) {
      return c.json({ error: 'every phrase must be a string' }, 400)
    }
    if (body.min_confidence !== undefined && (typeof body.min_confidence !== 'number' || body.min_confidence < 0 || body.min_confidence > 1)) {
      return c.json({ error: 'min_confidence must be a number between 0 and 1' }, 400)
    }
    const result = await resolvePhrasesToAtoms(body.phrases, c.env, {
      minConfidence: body.min_confidence,
      includeHarmonics: body.include_harmonics,
    })
    return c.json(result)
  } catch (err) {
    if (err instanceof ResolveError) {
      return c.json({ error: err.message }, err.status)
    }
    console.error('Error in /api/v1/resolve:', err)
    return c.json({ error: 'Resolution failed' }, 500)
  }
})
