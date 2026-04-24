-- Source creators: directors, cinematographers, actors, etc. linked to film sources.
-- Used by the film metadata import pipeline.

CREATE TABLE IF NOT EXISTS source_creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  birth_year INTEGER,
  death_year INTEGER,
  nationality TEXT,
  known_for TEXT,
  wikidata_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, role)
);

CREATE TABLE IF NOT EXISTS source_creator_links (
  source_id TEXT NOT NULL REFERENCES sources(id),
  creator_id INTEGER NOT NULL REFERENCES source_creators(id),
  role TEXT NOT NULL,
  PRIMARY KEY (source_id, creator_id, role)
);

CREATE INDEX idx_source_creators_name ON source_creators(name);
CREATE INDEX idx_source_creators_role ON source_creators(role);
CREATE INDEX idx_source_creator_links_source ON source_creator_links(source_id);
CREATE INDEX idx_source_creator_links_creator ON source_creator_links(creator_id);
