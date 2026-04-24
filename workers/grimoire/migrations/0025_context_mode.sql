-- Add context_mode column to category_contexts table.
-- Three modes: enrich (default, additive), replace (skip exemplars, use guidance only), translate (reserved).
ALTER TABLE category_contexts ADD COLUMN context_mode TEXT DEFAULT 'enrich';

-- Seed context_mode overrides for 6 arrangements (15 pairs total).

-- technical-illustration: 4 replace (suppress normal extraction for these categories)
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'technical-illustration' AND category_slug = 'lighting.source';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'technical-illustration' AND category_slug = 'environment.atmosphere';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'technical-illustration' AND category_slug = 'style.medium';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'technical-illustration' AND category_slug = 'color.palette';

-- blueprint-gothic: 4 replace
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'blueprint-gothic' AND category_slug = 'lighting.source';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'blueprint-gothic' AND category_slug = 'environment.atmosphere';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'blueprint-gothic' AND category_slug = 'style.medium';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'blueprint-gothic' AND category_slug = 'color.palette';

-- comic-book: 1 replace, 2 translate
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'comic-book' AND category_slug = 'style.medium';
UPDATE category_contexts SET context_mode = 'translate' WHERE context = 'comic-book' AND category_slug = 'lighting.source';
UPDATE category_contexts SET context_mode = 'translate' WHERE context = 'comic-book' AND category_slug = 'environment.atmosphere';

-- atomic-noir: 1 replace, 1 translate
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'atomic-noir' AND category_slug = 'color.palette';
UPDATE category_contexts SET context_mode = 'translate' WHERE context = 'atomic-noir' AND category_slug = 'lighting.source';

-- noir: 2 replace, 1 translate
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'noir' AND category_slug = 'lighting.source';
UPDATE category_contexts SET context_mode = 'replace' WHERE context = 'noir' AND category_slug = 'color.palette';
UPDATE category_contexts SET context_mode = 'translate' WHERE context = 'noir' AND category_slug = 'environment.atmosphere';
