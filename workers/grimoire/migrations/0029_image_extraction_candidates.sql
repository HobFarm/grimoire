-- Image extraction candidate review queue
-- Stores vision model extraction results for human review before atom/correspondence creation

CREATE TABLE IF NOT EXISTS image_extraction_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  source_attribution TEXT,
  candidate_type TEXT NOT NULL CHECK(candidate_type IN ('atom', 'correspondence')),
  candidate_data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'merged')),
  review_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE INDEX idx_iec_status ON image_extraction_candidates(status);
CREATE INDEX idx_iec_source ON image_extraction_candidates(source_url);
