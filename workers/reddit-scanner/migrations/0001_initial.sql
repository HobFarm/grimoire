CREATE TABLE topic_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  subreddit TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  intensity REAL NOT NULL,
  pain_points TEXT,
  feature_requests TEXT,
  tools_mentioned TEXT,
  sample_post_ids TEXT,
  scan_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_topic_date ON topic_signals(topic, scan_date);
CREATE INDEX idx_subreddit_date ON topic_signals(subreddit, scan_date);
CREATE INDEX idx_scan_date ON topic_signals(scan_date);
