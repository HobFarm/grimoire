-- Cron execution tracking for observability and staleness detection.
CREATE TABLE execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker TEXT NOT NULL,
  phase TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  items_processed INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  metadata_json TEXT DEFAULT '{}',
  success INTEGER DEFAULT 1
);

CREATE INDEX idx_execlog_worker_phase ON execution_log(worker, phase, completed_at);
