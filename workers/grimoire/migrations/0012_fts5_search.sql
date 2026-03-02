-- FTS5 virtual table for atom text search
-- text-only index: category/collection filtering via JOIN on atoms table
-- content='atoms' = external content table (no data duplication)
-- tokenize='porter unicode61' = stemming + unicode support

CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(
  text,
  content='atoms',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Populate from existing data (154K atoms, may take 10-30s)
INSERT INTO atoms_fts(rowid, text)
SELECT rowid, text FROM atoms WHERE status != 'rejected';

-- Triggers to keep FTS in sync with atoms table
CREATE TRIGGER IF NOT EXISTS atoms_fts_insert AFTER INSERT ON atoms
WHEN NEW.status != 'rejected'
BEGIN
  INSERT INTO atoms_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS atoms_fts_delete AFTER DELETE ON atoms
BEGIN
  INSERT INTO atoms_fts(atoms_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
END;

CREATE TRIGGER IF NOT EXISTS atoms_fts_update AFTER UPDATE OF text, status ON atoms
BEGIN
  INSERT INTO atoms_fts(atoms_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
  INSERT INTO atoms_fts(rowid, text)
  SELECT NEW.rowid, NEW.text WHERE NEW.status != 'rejected';
END;
