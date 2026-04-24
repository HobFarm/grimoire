// Phase 6: Content validation (Llama Guard + inline rules).

import type { HobBotAgent } from '../agent'
import { runLlamaGuard } from '../providers/workers-ai'
import type { PostDraft } from './compose'

export interface ValidationResult {
  safe: boolean
  onBrand: boolean
  meetsFormat: boolean
  reasons: string[]
}

const BANNED_PHRASES = [
  'as an ai',
  'as a language model',
  'i cannot',
  'i\'m sorry, but',
  'it\'s important to note',
  'in conclusion',
  'let me help you',
  'here\'s a',
  'here is a',
  'delve into',
  'it is worth noting',
  'certainly!',
  'absolutely!',
  'great question',
]

function checkFormat(draft: PostDraft): { passes: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (draft.text.length > 280) {
    reasons.push(`Text too long: ${draft.text.length}/280 chars`)
  }

  if (draft.text.length < 20) {
    reasons.push(`Text too short: ${draft.text.length} chars`)
  }

  const lower = draft.text.toLowerCase()
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      reasons.push(`Contains banned phrase: "${phrase}"`)
    }
  }

  // No excessive hashtags
  const hashtags = (draft.text.match(/#\w+/g) || []).length
  if (hashtags > 2) {
    reasons.push(`Too many hashtags: ${hashtags}`)
  }

  return { passes: reasons.length === 0, reasons }
}

function checkBrand(draft: PostDraft): { passes: boolean; reasons: string[] } {
  const reasons: string[] = []

  // Check for em dashes (brand rule)
  if (draft.text.includes('\u2014') || draft.text.includes('\u2013')) {
    reasons.push('Contains em dash or en dash')
  }

  // Alt text should exist if we have visual direction
  if (!draft.altText || draft.altText.length < 10) {
    reasons.push('Missing or too short alt text')
  }

  return { passes: reasons.length === 0, reasons }
}

export async function validatePost(
  agent: HobBotAgent,
  draft: PostDraft,
  imageUrl: string | null
): Promise<ValidationResult> {
  const reasons: string[] = []

  // Llama Guard safety check
  let safe = true
  try {
    const safety = await runLlamaGuard(agent.bindings.AI, draft.text)
    safe = safety.safe
    if (!safe) {
      reasons.push(`Safety check failed: ${safety.categories?.join(', ') ?? 'unknown'}`)
    }
  } catch (e) {
    // If Llama Guard fails, fall back to inline rules only (fail open)
    console.log(`[validate] Llama Guard failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Format rules
  const format = checkFormat(draft)
  if (!format.passes) reasons.push(...format.reasons)

  // Brand consistency
  const brand = checkBrand(draft)
  if (!brand.passes) reasons.push(...brand.reasons)

  return {
    safe,
    onBrand: brand.passes,
    meetsFormat: format.passes,
    reasons,
  }
}
