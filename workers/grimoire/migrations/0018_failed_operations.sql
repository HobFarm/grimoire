CREATE TABLE failed_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  atom_id TEXT,
  message_type TEXT,
  error TEXT,
  failed_at TEXT DEFAULT (datetime('now')),
  retried INTEGER DEFAULT 0
);
