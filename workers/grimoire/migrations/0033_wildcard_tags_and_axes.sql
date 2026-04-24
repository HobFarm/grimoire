-- Wildcard bootstrap: tag taxonomy + new dimensional axes
--
-- TAGS are categorical (atom either has the tag or doesn't), distinct from
-- the existing dimension_memberships (positional / pole-bound). Tag slug
-- format is "<category>:<value>", e.g. "body-region:upper-body". This is
-- separate from the legacy atoms.tags TEXT JSON column (free-form) and
-- supersedes it for structured per-atom categorical metadata.
--
-- Two new dimensional axes (body-condition, body-height) are seeded with
-- active=0 per the 0032 convention (flip after validation). Their
-- harmonic_key is a placeholder ('weight') because there is no
-- per-dimension harmonic on atoms today; pole-only queries are the
-- intended use until a Connectivity-Agent harmonic-enrichment pass adds a
-- real signal. resolveDimensionPosition() will return the atom's `weight`
-- harmonic on these axes -- semantically wrong; do not trust position
-- queries on body-condition / body-height yet.
--
-- All inserts/updates from the wildcard apply pipeline use INSERT OR IGNORE,
-- so existing manually-curated rows (44 body-mass + 127 aesthetic-mass
-- dimension_memberships at time of writing) are preserved.

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'wildcard-bootstrap',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tags_category ON tags(category);

CREATE TABLE atom_tags (
  atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'wildcard-bootstrap',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (atom_id, tag_id)
);
CREATE INDEX idx_atom_tags_tag ON atom_tags(tag_id);

INSERT OR IGNORE INTO dimension_axes
  (slug, label_low, label_high, harmonic_key, description, active)
VALUES
  ('body-condition', 'body-poor', 'body-fit', 'weight',
   'Body condition axis: poor (atrophied/weak) to fit (toned/strong). harmonic_key is a placeholder; pole queries only until per-dimension harmonic enrichment exists.',
   0),
  ('body-height', 'body-short', 'body-tall', 'weight',
   'Body height/stature axis. harmonic_key is a placeholder; pole queries only until per-dimension harmonic enrichment exists.',
   0);
