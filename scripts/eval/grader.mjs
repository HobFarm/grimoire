/**
 * MJ Eval Grader: Pure scoring functions for comparing SF compiled prompts
 * against MJ /describe ground truth.
 *
 * No I/O, no external deps. Input goes in, scores come out.
 */

// ---------------------------------------------------------------------------
// Exclusion patterns (quality boosters, cameras, rendering engines)
// ---------------------------------------------------------------------------

const EXCLUDED_PATTERNS = [
  /\buhd\b/i, /\b\d+k\b/i, /\bhdr\b/i, /\bphotorealistic\b/i,
  /\bhyperrealistic\b/i, /\bultra detailed\b/i, /\bhigh detail\b/i,
  /\bultra hd\b/i, /\b\d+x\d+\b/i,
  /\bnikon\b/i, /\bcanon\b/i, /\bhasselblad\b/i, /\bleica\b/i,
  /\bsony\b/i, /\bpentax\b/i, /\bmamiya\b/i, /\bsigma\b/i,
  /\bunreal engine\b/i, /\boctane render\b/i, /\bcinema 4d\b/i,
  /\bv-ray\b/i, /\bblender\b/i, /\bray tracing\b/i,
]

const ARTIST_PATTERN = /in the style of\s+([^,]+)/gi

const MIN_STEM_LENGTH = 5

const SUFFIXES = ['ing', 'ed', 'ly', 'ness', 'tion', 'es', 's']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a prompt into comma-separated segments, trimmed and lowercased.
 */
export function tokenize(prompt) {
  return prompt
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
}

/**
 * Extract artist names from "in the style of [X]" patterns.
 */
export function extractArtistTokens(prompt) {
  const artists = []
  let match
  const re = new RegExp(ARTIST_PATTERN.source, ARTIST_PATTERN.flags)
  while ((match = re.exec(prompt)) !== null) {
    artists.push(match[1].trim().toLowerCase())
  }
  return artists
}

/**
 * Simple suffix-stripping stemmer. Only strips from words >= MIN_STEM_LENGTH.
 */
export function stem(word) {
  if (word.length < MIN_STEM_LENGTH) return word
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length)
    }
  }
  return word
}

/**
 * Levenshtein edit distance (standard DP).
 */
export function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/**
 * Check if a token matches any exclusion pattern.
 */
export function isExcluded(token) {
  return EXCLUDED_PATTERNS.some(p => p.test(token))
}

/**
 * Check if an MJ token is found in the SF token set using fuzzy matching.
 * Returns 'exact' | 'stemmed' | 'levenshtein' | null
 */
export function fuzzyMatch(mjToken, sfSegments) {
  const mjLower = mjToken.toLowerCase().trim()
  if (!mjLower) return null

  // Level 1: Exact substring match in any SF segment
  for (const seg of sfSegments) {
    if (seg.includes(mjLower)) return 'exact'
  }

  // Level 2: Stemmed match
  const mjStemmed = stem(mjLower)
  for (const seg of sfSegments) {
    // Stem each word in the segment and check
    const segWords = seg.split(/\s+/).map(w => stem(w))
    if (segWords.some(w => w === mjStemmed)) return 'stemmed'
    // Also check if stemmed MJ token is substring of the full stemmed segment
    const segStemmed = segWords.join(' ')
    if (segStemmed.includes(mjStemmed)) return 'stemmed'
  }

  // Level 3: Levenshtein on individual words
  const threshold = mjLower.length < 10 ? 2 : 3
  for (const seg of sfSegments) {
    const words = seg.split(/\s+/)
    for (const word of words) {
      if (levenshtein(mjLower, word) <= threshold) return 'levenshtein'
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Scoring Functions
// ---------------------------------------------------------------------------

/**
 * Axis 1: Vocabulary Overlap (0.0 to 1.0)
 *
 * Measures what fraction of MJ's vocabulary terms appear in the SF prompt.
 */
export function scoreVocabularyOverlap(sfPrompt, mjPrompts, config = {}) {
  const includeArtists = config.includeArtists ?? false

  // Build MJ token set (union across all 4 prompts)
  const mjTokenSet = new Set()
  const artistTokens = new Set()

  for (const mj of mjPrompts) {
    // Collect artist tokens for optional exclusion
    for (const artist of extractArtistTokens(mj)) {
      artistTokens.add(artist)
    }
    for (const token of tokenize(mj)) {
      // Skip the subject description (first token, typically long)
      // Actually keep all tokens; the subject terms are valid vocabulary
      mjTokenSet.add(token)
    }
  }

  // Filter out excluded tokens and optionally artist tokens
  const scorableTokens = [...mjTokenSet].filter(t => {
    if (isExcluded(t)) return false
    if (!includeArtists && artistTokens.has(t)) return false
    // Skip "in the style of X" segments (the full phrase)
    if (t.startsWith('in the style of')) return false
    return true
  })

  if (scorableTokens.length === 0) {
    return { score: 1.0, matched: [], missed: [], total: 0 }
  }

  // Tokenize SF prompt (both comma-split and individual segments)
  const sfSegments = tokenize(sfPrompt)

  const matched = []
  const missed = []

  for (const mjToken of scorableTokens) {
    const matchType = fuzzyMatch(mjToken, sfSegments)
    if (matchType) {
      matched.push({ token: mjToken, matchType })
    } else {
      missed.push(mjToken)
    }
  }

  return {
    score: matched.length / scorableTokens.length,
    matched,
    missed,
    total: scorableTokens.length,
  }
}

/**
 * Axis 2: Length Ratio (unbounded, target 1.0)
 *
 * Measures SF word count relative to MJ average word count.
 */
export function scoreLengthRatio(sfPrompt, mjPrompts) {
  const sfWords = sfPrompt.split(/\s+/).filter(w => w.length > 0).length
  const mjWordCounts = mjPrompts.map(p => p.split(/\s+/).filter(w => w.length > 0).length)
  const mjAvgWords = mjWordCounts.reduce((a, b) => a + b, 0) / mjWordCounts.length

  return {
    ratio: mjAvgWords > 0 ? sfWords / mjAvgWords : 0,
    sfWords,
    mjAvgWords: Math.round(mjAvgWords * 10) / 10,
  }
}

/**
 * Axis 3: Structure Score (0.0 to 1.0)
 *
 * Measures whether SF uses MJ's flat comma-separated format.
 */
export function scoreStructure(sfPrompt, mjPrompts) {
  function commaRatio(text) {
    const commas = (text.match(/,/g) || []).length
    const sentences = (text.match(/[.!?](\s|$)/g) || []).length
    const totalSegments = commas + sentences + 1
    return commas / totalSegments
  }

  const sfRatio = commaRatio(sfPrompt)
  const mjRatios = mjPrompts.map(commaRatio)
  const mjAvgRatio = mjRatios.reduce((a, b) => a + b, 0) / mjRatios.length

  const score = Math.max(0, 1.0 - Math.abs(sfRatio - mjAvgRatio))

  return {
    score,
    sfCommaRatio: Math.round(sfRatio * 1000) / 1000,
    mjCommaRatio: Math.round(mjAvgRatio * 1000) / 1000,
  }
}

/**
 * Combined Score (0.0 to 1.0)
 */
export function scoreCombined(vocabScore, lengthRatio, structureScore, weights = {}) {
  const w = {
    vocabulary: weights.vocabulary ?? 0.5,
    length: weights.length ?? 0.25,
    structure: weights.structure ?? 0.25,
  }

  const lengthScore = 1.0 - Math.min(Math.abs(lengthRatio - 1.0), 1.0)

  return (vocabScore * w.vocabulary) + (lengthScore * w.length) + (structureScore * w.structure)
}

// ---------------------------------------------------------------------------
// Divergence Labeler
// ---------------------------------------------------------------------------

/**
 * Label divergences between SF prompt and MJ reference prompts.
 */
export function labelDivergences(sfPrompt, mjPrompts, config = {}) {
  const divergences = []

  // Vocabulary analysis
  const vocab = scoreVocabularyOverlap(sfPrompt, mjPrompts, config)
  for (const missed of vocab.missed) {
    // Count how many MJ prompts contain this term
    const presentIn = mjPrompts.filter(p => p.toLowerCase().includes(missed)).length
    divergences.push({
      type: 'vocabulary_miss',
      mj_term: missed,
      detail: `Present in ${presentIn}/4 MJ prompts, absent from SF output`,
    })
  }

  // Length analysis
  const length = scoreLengthRatio(sfPrompt, mjPrompts)
  if (length.ratio > 2.0) {
    divergences.push({
      type: 'length_excess',
      detail: `SF: ${length.sfWords} words, MJ avg: ${length.mjAvgWords} words (ratio: ${Math.round(length.ratio * 10) / 10}x)`,
    })
  } else if (length.ratio < 0.5) {
    divergences.push({
      type: 'length_deficit',
      detail: `SF: ${length.sfWords} words, MJ avg: ${length.mjAvgWords} words (ratio: ${Math.round(length.ratio * 10) / 10}x)`,
    })
  }

  // Structure analysis
  const structure = scoreStructure(sfPrompt, mjPrompts)
  if (structure.score < 0.5) {
    divergences.push({
      type: 'structure_prose',
      detail: `SF comma ratio: ${structure.sfCommaRatio}, MJ comma ratio: ${structure.mjCommaRatio}`,
    })
  }

  // Artist analysis
  const mjArtists = new Set()
  for (const mj of mjPrompts) {
    for (const a of extractArtistTokens(mj)) mjArtists.add(a)
  }
  const sfLower = sfPrompt.toLowerCase()
  for (const artist of mjArtists) {
    if (!sfLower.includes(artist)) {
      divergences.push({
        type: 'artist_missing',
        mj_term: artist,
        detail: `MJ references "${artist}", SF does not`,
      })
    }
  }

  // Quality booster analysis (informational)
  for (const mj of mjPrompts) {
    for (const token of tokenize(mj)) {
      if (isExcluded(token) && !sfLower.includes(token)) {
        divergences.push({
          type: 'booster_missing',
          mj_term: token,
          detail: `MJ uses "${token}" (excluded from scoring)`,
        })
        break // one per excluded term is enough
      }
    }
  }

  return divergences
}

/**
 * Score a single image pair (convenience function).
 */
export function scoreImagePair(sfPrompt, mjPrompts, config = {}) {
  const vocab = scoreVocabularyOverlap(sfPrompt, mjPrompts, config)
  const length = scoreLengthRatio(sfPrompt, mjPrompts)
  const structure = scoreStructure(sfPrompt, mjPrompts)
  const combined = scoreCombined(vocab.score, length.ratio, structure.score, config.weights)
  const divergences = labelDivergences(sfPrompt, mjPrompts, config)

  return {
    scores: {
      vocabulary_overlap: Math.round(vocab.score * 1000) / 1000,
      length_ratio: Math.round(length.ratio * 100) / 100,
      structure_score: Math.round(structure.score * 1000) / 1000,
      combined: Math.round(combined * 1000) / 1000,
    },
    detail: {
      vocabulary: { matched: vocab.matched.length, missed: vocab.missed.length, total: vocab.total },
      length: { sf_words: length.sfWords, mj_avg_words: length.mjAvgWords },
      structure: { sf_comma_ratio: structure.sfCommaRatio, mj_comma_ratio: structure.mjCommaRatio },
    },
    divergences,
  }
}
