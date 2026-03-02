import { VALID_CATEGORIES } from './constants'

export { VALID_CATEGORIES }

/**
 * Canonical mapping from category_slug to collection_slug.
 * Single source of truth. Gemini returns category_slug only;
 * collection_slug is always derived from this map.
 */
export const CATEGORY_TO_COLLECTION: Record<string, string> = {
  // Subject
  'subject.form': 'attributes',
  'subject.expression': 'features-expression',
  'subject.face': 'features-face',
  'subject.feature': 'features-body',
  'subject.hair': 'features-hair',
  'subject.animal': 'animals',
  // Environment
  'environment.setting': 'environment',
  'environment.atmosphere': 'environment-atmosphere',
  'environment.prop': 'environment-props',
  'environment.natural': 'nature',
  // Lighting
  'lighting.source': 'lighting',
  // Color
  'color.palette': 'colors',
  // Composition
  'composition.rule': 'composition',
  // Covering
  'covering.clothing': 'clothing',
  'covering.material': 'clothing',
  'covering.accessory': 'clothing-accessories',
  'covering.headwear': 'clothing',
  'covering.footwear': 'clothing-footwear',
  'covering.outfit': 'clothing-full',
  // Pose
  'pose.position': 'poses',
  'pose.interaction': 'poses',
  // Object
  'object.held': 'props-held',
  'object.drink': 'props-held-vessels',
  // Style
  'style.genre': 'styles',
  'style.era': 'styles',
  'style.medium': 'style-medium',
  // Camera
  'camera.lens': 'photography',
  'camera.shot': 'photography',
  // Effect
  'effect.post': 'effects',
  // Negative
  'negative.filter': 'filters',
  // Reference
  'reference.film': 'references',
  'reference.technique': 'references',
  'reference.person': 'references',
  'reference.location': 'references',
  'reference.character': 'references',
  'reference.game': 'references',
  // Narrative (visual collections exist for scene/mood)
  'narrative.scene': 'scenes',
  'narrative.mood': 'scenes',
  // Narrative (no visual collection)
  'narrative.action': 'uncategorized',
  'narrative.archetype': 'uncategorized',
  'narrative.concept': 'uncategorized',
  'narrative.phrase': 'uncategorized',
  // Domain (narrative-only)
  'domain.academia': 'uncategorized',
  'domain.athletics': 'uncategorized',
  'domain.aviation': 'uncategorized',
  'domain.chemistry': 'uncategorized',
  'domain.cuisine': 'uncategorized',
  'domain.folklore': 'uncategorized',
  'domain.law': 'uncategorized',
  'domain.maritime': 'uncategorized',
  'domain.medicine': 'uncategorized',
  'domain.military': 'uncategorized',
  'domain.occult': 'uncategorized',
  'domain.technology': 'uncategorized',
}

/** Derive collection_slug from category_slug. Falls back to 'uncategorized'. */
export function collectionFromCategory(cat: string): string {
  return CATEGORY_TO_COLLECTION[cat] || 'uncategorized'
}

const GENERIC_TERMS = new Set([
  'prominent', 'beautiful', 'large', 'nice', 'good', 'bad',
  'small', 'big', 'pretty', 'ugly', 'simple', 'complex',
  'detailed', 'amazing', 'interesting', 'cool', 'awesome',
  'realistic', 'perfect', 'great', 'fine', 'strong', 'weak',
  'normal', 'regular', 'basic', 'standard', 'typical',
  'high', 'low', 'medium', 'long', 'short', 'wide', 'narrow',
])

/** Reject single bare generic adjectives that have no specific visual meaning. */
export function isGenericTerm(text: string): boolean {
  const words = text.trim().split(/\s+/)
  return words.length === 1 && GENERIC_TERMS.has(words[0].toLowerCase())
}
