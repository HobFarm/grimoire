-- Dimensional vocabulary pilot (v2)
-- Three independent tables shipped together:
--   1. dimension_axes          - names an axis, points at a harmonic_key
--   2. dimension_memberships   - curator-asserted atom membership in axis poles
--   3. moodboard_dropped_atoms - observability for atoms the aggregator discards
--
-- Seeds body-mass axis with active=0. Flip via UPDATE post-validation.
-- Post-apply: run ANALYZE on atoms and dimension_memberships (partial-index planner hint).

-- Dimension axes (one row per named axis)
CREATE TABLE dimension_axes (
  slug TEXT PRIMARY KEY,
  label_low TEXT NOT NULL,
  label_high TEXT NOT NULL,
  harmonic_key TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Atom membership in axis poles (curator-asserted)
-- PK (atom_id, axis_slug) enforces one pole per atom per axis; multi-axis supported.
CREATE TABLE dimension_memberships (
  atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  axis_slug TEXT NOT NULL REFERENCES dimension_axes(slug) ON DELETE CASCADE,
  pole TEXT NOT NULL CHECK (pole IN ('low','high')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (atom_id, axis_slug)
);
CREATE INDEX idx_dimmem_axis ON dimension_memberships(axis_slug, pole);

-- Aggregation drop capture
-- Previously the aggregator console.logged and discarded atoms with invalid
-- suggested_category. Persist them for "which categories do we keep missing"
-- signal volume across moodboards.
CREATE TABLE moodboard_dropped_atoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moodboard_id TEXT NOT NULL REFERENCES moodboards(moodboard_id),
  atom_name TEXT NOT NULL,
  suggested_category TEXT NOT NULL,
  bucket TEXT NOT NULL,
  frequency REAL,
  mean_confidence REAL,
  utility TEXT,
  modality TEXT,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX idx_dropped_unique
  ON moodboard_dropped_atoms(moodboard_id, atom_name, bucket);
CREATE INDEX idx_dropped_by_category
  ON moodboard_dropped_atoms(suggested_category);

-- Seed body-mass axis. active=0 until verification gates pass.
INSERT INTO dimension_axes
  (slug, label_low, label_high, harmonic_key, description, active)
VALUES
  ('body-mass', 'body-light', 'body-heavy', 'weight',
   'Body mass axis: members are body-form descriptors. Position = atoms.harmonics.weight.',
   0);
