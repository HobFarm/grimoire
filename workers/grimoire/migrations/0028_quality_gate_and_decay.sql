-- Quality gate audit log
CREATE TABLE IF NOT EXISTS quality_gate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_text TEXT NOT NULL,
  specificity_score REAL,
  similar_atom_id TEXT,
  similarity_score REAL,
  result TEXT NOT NULL CHECK(result IN ('pass','reject','flag','redirect_merge')),
  rejection_reason TEXT,
  source TEXT,
  checked_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_qgl_result ON quality_gate_log(result);
CREATE INDEX idx_qgl_checked ON quality_gate_log(checked_at);

-- Correspondence decay tracking
ALTER TABLE correspondences ADD COLUMN last_reinforced_at TEXT;
UPDATE correspondences SET last_reinforced_at = created_at;

-- Intra-category correspondence scope
ALTER TABLE correspondences ADD COLUMN scope TEXT DEFAULT 'cross_category';

-- Pipeline latency tracking
ALTER TABLE atoms ADD COLUMN fully_enriched_at TEXT;
