// Vocabulary Match Agent: three-tier matching (exact -> FTS5 -> AI disambiguation)
// Model: Granite (Workers AI), only for ambiguous FTS5 matches
// Core innovation: match vocabulary before creating, keeping the index lean

import type { AgentContext, KeyConcept, VocabularyMatchResult, VocabularyMatch } from './types'
import { callWithJsonParse } from '@shared/providers/call-with-json-parse'
import { MODELS } from '@shared/models'
import { buildVocabularyMatchPrompt, buildVocabularyMatchUserMessage } from '../../prompts/pipeline-vocabulary'

interface DisambiguationCandidate {
  term: string
  ftsResults: { id: string; text: string; category: string | null }[]
}

/**
 * Run vocabulary matching on a set of key concepts.
 * Three-tier strategy, cheapest first:
 * 1. Exact match (free): handle.lookup(term)
 * 2. FTS5 fuzzy (free): handle.search(term) for plural/variant matches
 * 3. AI disambiguation (Granite): only when FTS5 returns candidates but no exact hit
 */
export async function runVocabularyMatchAgent(
  ctx: AgentContext,
  concepts: KeyConcept[],
): Promise<{ result: VocabularyMatchResult; modelUsed: string | null }> {
  // Deduplicate by lowercase term
  const seen = new Set<string>()
  const unique: KeyConcept[] = []
  for (const c of concepts) {
    const key = c.term.toLowerCase().trim()
    if (!seen.has(key) && key.length > 0) {
      seen.add(key)
      unique.push(c)
    }
  }

  const matched: VocabularyMatch[] = []
  const unmatched: KeyConcept[] = []
  const needsDisambiguation: DisambiguationCandidate[] = []

  // Tier 1 + 2: exact lookup then FTS5 for each concept
  for (const concept of unique) {
    // Tier 1: exact match
    const exact = await ctx.handle.lookup(concept.term)
    if (exact) {
      matched.push({ term: concept.term, atomId: exact.id, confidence: 1.0 })
      continue
    }

    // Tier 2: FTS5 fuzzy search
    const ftsResults = await ctx.handle.search(concept.term, { limit: 5 })
    if (ftsResults.length === 0) {
      // No candidates at all, genuinely new
      unmatched.push(concept)
      continue
    }

    // Check if any FTS result is an exact case-insensitive match
    const exactFts = ftsResults.find(r =>
      r.text.toLowerCase().trim() === concept.term.toLowerCase().trim()
    )
    if (exactFts) {
      matched.push({ term: concept.term, atomId: exactFts.id, confidence: 0.95 })
      continue
    }

    // Single FTS result with high text similarity: skip AI, accept directly
    if (ftsResults.length === 1) {
      const fts = ftsResults[0]
      const termLower = concept.term.toLowerCase().trim()
      const ftsLower = fts.text.toLowerCase().trim()
      const lenRatio = Math.min(termLower.length, ftsLower.length) / Math.max(termLower.length, ftsLower.length)
      if (lenRatio > 0.6 && (ftsLower.includes(termLower) || termLower.includes(ftsLower))) {
        matched.push({ term: concept.term, atomId: fts.id, confidence: 0.85 })
        continue
      }
    }

    // Has candidates but no exact or high-confidence match: needs AI disambiguation
    needsDisambiguation.push({
      term: concept.term,
      ftsResults: ftsResults.map(r => ({
        id: r.id,
        text: r.text,
        category: r.category_slug ?? null,
      })),
    })
  }

  // Tier 3: AI disambiguation for ambiguous cases
  let modelUsed: string | null = null

  if (needsDisambiguation.length > 0) {
    // Batch disambiguation in groups of 10 to keep context manageable
    const BATCH_SIZE = 10

    for (let i = 0; i < needsDisambiguation.length; i += BATCH_SIZE) {
      const batch = needsDisambiguation.slice(i, i + BATCH_SIZE)

      try {
        const systemPrompt = buildVocabularyMatchPrompt()
        const userMessage = buildVocabularyMatchUserMessage(batch)

        const { result: aiResult, modelUsed: model } = await callWithJsonParse<{
          matches: { term: string; matched_atom_id: string | null; confidence: number }[]
        }>(
          'pipeline.vocabulary',
          systemPrompt,
          userMessage,
          ctx.ai,
          ctx.geminiKey,
          MODELS['pipeline.vocabulary'],
          { onUsage: ctx.onUsage },
        )

        modelUsed = model

        // Process AI results
        const aiMatches = aiResult.matches ?? []
        const aiMatchMap = new Map(aiMatches.map(m => [m.term.toLowerCase(), m]))

        for (const candidate of batch) {
          const aiMatch = aiMatchMap.get(candidate.term.toLowerCase())

          if (aiMatch?.matched_atom_id) {
            // Verify the matched ID exists in the FTS results (prevent hallucination)
            const validMatch = candidate.ftsResults.find(r => r.id === aiMatch.matched_atom_id)
            if (validMatch) {
              matched.push({
                term: candidate.term,
                atomId: aiMatch.matched_atom_id,
                confidence: Math.max(0, Math.min(1, aiMatch.confidence ?? 0.8)),
              })
              continue
            }
          }

          // AI said no match or hallucinated an ID: treat as unmatched
          const originalConcept = unique.find(c => c.term.toLowerCase() === candidate.term.toLowerCase())
          if (originalConcept) unmatched.push(originalConcept)
        }
      } catch (err) {
        console.warn(`[vocabulary-match] AI disambiguation failed: ${err instanceof Error ? err.message : err}`)
        // On AI failure, all candidates in this batch go to unmatched
        for (const candidate of batch) {
          const originalConcept = unique.find(c => c.term.toLowerCase() === candidate.term.toLowerCase())
          if (originalConcept) unmatched.push(originalConcept)
        }
      }
    }
  }

  console.log(`[vocabulary-match] total=${unique.length} exact=${matched.filter(m => m.confidence === 1).length} fts=${matched.filter(m => m.confidence === 0.95).length} ai_matched=${matched.filter(m => m.confidence < 0.95 && m.confidence > 0).length} unmatched=${unmatched.length}`)

  return {
    result: { matched, unmatched },
    modelUsed,
  }
}
