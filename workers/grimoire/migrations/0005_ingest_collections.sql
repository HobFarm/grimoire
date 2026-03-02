-- Migration 0005: Add collection slugs used by ingest pipeline
-- These slugs are referenced in ingest.mjs CATEGORY_TO_COLLECTION but were
-- never added to the collections table, causing FK violations on insert.

INSERT OR IGNORE INTO collections (slug, name, description, parent_slug) VALUES
  ('animals', 'Animals', 'Wildlife, pets, marine life, insects, dinosaurs', NULL),
  ('references', 'References', 'Film, technique, person, location, character, game references', NULL),
  ('nature', 'Nature', 'Natural features, terrain, water, vegetation, weather', 'environment'),
  ('colors', 'Colors', 'Color palettes, grades, temperature', NULL),
  ('photography', 'Photography', 'Camera angles, lens types, shot compositions', NULL),
  ('scenes', 'Scenes', 'Multi-element scene descriptions', NULL),
  ('composition', 'Composition', 'Compositional rules and framing principles', NULL),
  ('effects', 'Effects', 'Post-processing and optical effects', NULL),
  ('uncategorized', 'Uncategorized', 'Atoms awaiting classification', NULL),
  ('render-negative', 'Render Negative', 'Negative prompt filters', 'filters');
