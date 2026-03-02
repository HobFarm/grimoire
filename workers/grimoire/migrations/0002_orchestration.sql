-- Phase 3: Orchestration layer
-- Applied to remote grimoire-db on 2026-02-18
-- DO NOT re-run on existing remote -- columns/table already exist
-- For fresh/local DB instances only

-- Harmonic classification columns on atoms
ALTER TABLE atoms ADD COLUMN category_slug TEXT;
ALTER TABLE atoms ADD COLUMN harmonics TEXT DEFAULT '{}';

CREATE INDEX idx_atoms_category_slug ON atoms(category_slug);

-- Arrangements: cymatics frequency patterns for StyleFusion composition
CREATE TABLE arrangements (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  harmonics TEXT NOT NULL DEFAULT '{}',
  category_weights TEXT NOT NULL DEFAULT '{}',
  context_key TEXT NOT NULL DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now'))
);
