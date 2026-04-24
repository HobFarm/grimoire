-- Moodboard artifact registry
-- Each row represents one moodboard (9 source images from a single aesthetic source like aesthetics.fandom.com)
-- producing one aggregate IR. Source images, per-image analyses, and the aggregate IR all live in R2.

CREATE TABLE IF NOT EXISTS moodboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moodboard_id TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT,
  source_url TEXT,
  source_description TEXT,
  license TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  composite_r2_key TEXT,
  manifest_r2_key TEXT,
  ir_r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'extracted', 'aggregated', 'reviewed', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE INDEX idx_moodboards_source ON moodboards(source);
CREATE INDEX idx_moodboards_status ON moodboards(status);
CREATE INDEX idx_moodboards_slug ON moodboards(source, slug);

ALTER TABLE image_extraction_candidates ADD COLUMN moodboard_id TEXT;
CREATE INDEX idx_iec_moodboard
  ON image_extraction_candidates(moodboard_id)
  WHERE moodboard_id IS NOT NULL;
