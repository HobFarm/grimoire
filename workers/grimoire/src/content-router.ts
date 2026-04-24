/**
 * Content Router
 *
 * Routes incoming content to the correct layer:
 * - atom: short, recombinable vocabulary (3-80 chars, <= 6 words)
 * - document_chunk: longer descriptive knowledge
 * - reject: invalid content
 */

import { isValidAtom } from './migration'

export interface RoutingResult {
  destination: 'atom' | 'document_chunk' | 'reject'
  reason: string
  suggested_document?: string
  suggested_tags?: string[]
}

const CATEGORY_DOCUMENT_MAP: Array<{
  test: (text: string, category?: string) => boolean
  document: string
}> = [
  {
    test: (_, cat) => !!cat && cat.endsWith('.aesthetic'),
    document: 'Aesthetic Definitions',
  },
  {
    test: (text) => text.includes('__') && text.includes('/'),
    document: 'Art and Reference Taxonomy',
  },
  {
    test: (_, cat) => !!cat && cat.startsWith('reference.'),
    document: 'Character Briefs Collection',
  },
  {
    test: (_, cat) => !!cat && cat.startsWith('narrative.'),
    document: 'Scene Compositions',
  },
  {
    test: (_, cat) => !!cat && cat.startsWith('environment.'),
    document: 'Setting and Environment Descriptions',
  },
  {
    test: (_, cat) => !!cat && cat.startsWith('covering.'),
    document: 'Costume and Outfit Descriptions',
  },
]

export function routeContent(text: string, category?: string): RoutingResult {
  const trimmed = text.trim()

  // Step 1: check if it's a valid atom
  const validation = isValidAtom(trimmed)
  if (validation.valid) {
    return { destination: 'atom', reason: 'valid_atom' }
  }

  // Step 2: genuinely invalid content (not just too long/wordy)
  const hardRejects = ['emoticon', 'non_text', 'stock_caption', 'comment', 'too_short']
  if (validation.reason && hardRejects.includes(validation.reason)) {
    return { destination: 'reject', reason: validation.reason! }
  }

  // Step 3: valid text but too long/wordy for atom -> route to document_chunk
  // Remaining reasons: too_long, multiline, too_many_words
  for (const rule of CATEGORY_DOCUMENT_MAP) {
    if (rule.test(trimmed, category)) {
      return {
        destination: 'document_chunk',
        reason: `${validation.reason}_routed`,
        suggested_document: rule.document,
      }
    }
  }

  // Fallback: uncategorized knowledge
  return {
    destination: 'document_chunk',
    reason: `${validation.reason}_routed`,
    suggested_document: 'Uncategorized Knowledge',
    suggested_tags: ['needs-review'],
  }
}
