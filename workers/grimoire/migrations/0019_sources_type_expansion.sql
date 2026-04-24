-- Drop CHECK constraint on sources.type to allow new source types (film, dataset, feed_item, etc.)
-- D1/SQLite requires table recreation to modify CHECK constraints.
-- Follows the same pattern as HobBot/migrations/006_extend_relation_checks.sql.
-- Pre-migration baseline: 94 sources rows, 1349 source_atoms rows.

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  r2_key TEXT,
  source_url TEXT,
  metadata TEXT DEFAULT '{}',
  aesthetic_tags TEXT DEFAULT '[]',
  arrangement_matches TEXT DEFAULT '[]',
  harmonic_profile TEXT DEFAULT '{}',
  atom_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  content_type TEXT,
  document_id TEXT,
  status TEXT DEFAULT 'pending',
  extraction_model TEXT,
  extraction_prompt_version TEXT
);

INSERT INTO sources_new SELECT * FROM sources;

DROP TABLE sources;

ALTER TABLE sources_new RENAME TO sources;

CREATE INDEX idx_sources_type ON sources(type);
CREATE INDEX idx_sources_content_type ON sources(content_type);
CREATE INDEX idx_sources_status ON sources(status);
CREATE INDEX idx_sources_document ON sources(document_id);
