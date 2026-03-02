-- Phase 2: Learning vocabulary cache
-- Adds: collections hierarchy, atoms with status/encounter lifecycle, app routing

-- Collections hierarchy
CREATE TABLE collections (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  parent_slug TEXT REFERENCES collections(slug),
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO collections (slug, name, description, parent_slug) VALUES
  ('clothing', 'Clothing', 'Garments and wearable items', NULL),
  ('clothing-upper', 'Upper Body Clothing', 'Tops, jackets, corsets, shirts', 'clothing'),
  ('clothing-lower', 'Lower Body Clothing', 'Pants, skirts, shorts', 'clothing'),
  ('clothing-full', 'Full Body Clothing', 'Dresses, jumpsuits, robes', 'clothing'),
  ('clothing-accessories', 'Clothing Accessories', 'Belts, scarves, ties', 'clothing'),
  ('clothing-footwear', 'Footwear', 'Boots, shoes, sandals', 'clothing'),
  ('features', 'Features', 'Distinguishing physical features', NULL),
  ('features-face', 'Facial Features', 'Eyes, expressions, markings', 'features'),
  ('features-hair', 'Hair', 'Hairstyles, color, texture', 'features'),
  ('features-body', 'Body Features', 'Tattoos, scars, piercings, build', 'features'),
  ('features-expression', 'Expression', 'Facial expressions and gaze', 'features'),
  ('environment', 'Environment', 'Scene and setting vocabulary', NULL),
  ('environment-surfaces', 'Surfaces', 'Materials, floors, walls, textures in scene', 'environment'),
  ('environment-atmosphere', 'Atmosphere', 'Physical atmospheric conditions', 'environment'),
  ('environment-props', 'Props', 'Objects in the scene', 'environment'),
  ('lighting', 'Lighting', 'Lighting techniques and conditions', NULL),
  ('style', 'Style', 'Rendering and artistic style vocabulary', NULL),
  ('style-medium', 'Medium', 'Art mediums and rendering approaches', 'style'),
  ('style-texture', 'Texture', 'Surface texture vocabulary', 'style'),
  ('filters', 'Filters', 'Words to strip or flag during compilation', NULL),
  ('filters-interpretation', 'Interpretation Filters', 'Words indicating interpretation not observation', 'filters'),
  ('filters-mood', 'Mood Filters', 'Mood and atmosphere words to strip', 'filters'),
  ('position', 'Position', 'Body position and pose vocabulary', NULL),
  ('props-worn', 'Worn Props', 'Jewelry, accessories worn on body', NULL),
  ('props-held', 'Held Objects', 'Items held by the subject', NULL),
  ('body-regions', 'Body Regions', 'Canonical body zone vocabulary and normalization', NULL);

-- Atoms
CREATE TABLE atoms (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  text_lower TEXT NOT NULL,
  collection_slug TEXT NOT NULL REFERENCES collections(slug),
  observation TEXT NOT NULL DEFAULT 'observation'
    CHECK(observation IN ('observation','interpretation')),
  status TEXT NOT NULL DEFAULT 'provisional'
    CHECK(status IN ('provisional','confirmed','rejected')),
  confidence REAL DEFAULT 0.5,
  encounter_count INTEGER DEFAULT 1,
  tags TEXT DEFAULT '[]',
  source TEXT NOT NULL CHECK(source IN ('seed','ai','manual')),
  source_app TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_atoms_unique ON atoms(text_lower, collection_slug);
CREATE INDEX idx_atoms_collection ON atoms(collection_slug);
CREATE INDEX idx_atoms_status ON atoms(status);
CREATE INDEX idx_atoms_source ON atoms(source);

-- App routing
CREATE TABLE app_routing (
  atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  routing TEXT NOT NULL,
  context TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (atom_id, app)
);

CREATE INDEX idx_app_routing_app ON app_routing(app);
CREATE INDEX idx_app_routing_routing ON app_routing(app, routing);
