-- Add default_modality column to categories table.
-- Eliminates the hardcoded CATEGORY_MODALITY map in constants.ts.
-- Values match the existing map exactly.

ALTER TABLE categories ADD COLUMN default_modality TEXT NOT NULL DEFAULT 'both';

-- Visual-only categories (23)
UPDATE categories SET default_modality = 'visual' WHERE slug IN (
  'camera.lens', 'camera.shot', 'color.palette', 'composition.rule',
  'covering.accessory', 'covering.clothing', 'covering.footwear',
  'covering.headwear', 'covering.material', 'covering.outfit',
  'effect.post', 'lighting.source', 'negative.filter',
  'object.drink', 'object.held', 'pose.interaction', 'pose.position',
  'style.medium', 'subject.expression', 'subject.face',
  'subject.feature', 'subject.form', 'subject.hair'
);

-- Narrative-only categories (16)
UPDATE categories SET default_modality = 'narrative' WHERE slug IN (
  'domain.academia', 'domain.athletics', 'domain.aviation',
  'domain.chemistry', 'domain.cuisine', 'domain.folklore',
  'domain.law', 'domain.maritime', 'domain.medicine',
  'domain.military', 'domain.occult', 'domain.technology',
  'narrative.action', 'narrative.archetype', 'narrative.concept',
  'narrative.phrase'
);

-- Remaining 15 categories keep 'both' (the default)
