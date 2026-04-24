// Phase 4: quality gate — schema + content validation

import { BANNED_PHRASES } from './character'
import type { ComposeOutput, ValidateResult } from './types'

export function validatePost(output: ComposeOutput): ValidateResult {
  const errors: string[] = []

  // Required fields
  if (!output.title) errors.push('title is required')
  if (!output.slug) errors.push('slug is required')
  if (!output.excerpt) errors.push('excerpt is required')
  if (!output.body_md) errors.push('body_md is required')
  if (!Array.isArray(output.tags)) errors.push('tags must be an array')
  if (!output.heroDirection) errors.push('heroDirection is required')

  // Length bounds
  if (output.title && (output.title.length < 10 || output.title.length > 100)) {
    errors.push(`title must be 10-100 chars (got ${output.title.length})`)
  }
  if (output.excerpt && (output.excerpt.length < 50 || output.excerpt.length > 200)) {
    errors.push(`excerpt must be 50-200 chars (got ${output.excerpt.length})`)
  }
  if (output.body_md && (output.body_md.length < 200 || output.body_md.length > 5000)) {
    errors.push(`body_md must be 200-5000 chars (got ${output.body_md.length})`)
  }

  // Tags
  if (Array.isArray(output.tags)) {
    if (output.tags.length < 1 || output.tags.length > 8) {
      errors.push(`tags must have 1-8 items (got ${output.tags.length})`)
    }
    if (output.tags.some(t => typeof t !== 'string')) {
      errors.push('all tags must be strings')
    }
  }

  // Slug format
  if (output.slug) {
    if (!/^[a-z0-9-]+$/.test(output.slug)) {
      errors.push('slug must match /^[a-z0-9-]+$/')
    }
    if (output.slug.length > 60) {
      errors.push(`slug must be <= 60 chars (got ${output.slug.length})`)
    }
  }

  // Banned phrase scan
  if (output.body_md) {
    const lower = output.body_md.toLowerCase()
    const found = BANNED_PHRASES.filter(p => lower.includes(p))
    if (found.length > 0) {
      errors.push(`banned phrases found: ${found.join(', ')}`)
    }
  }

  return { valid: errors.length === 0, errors }
}
