/**
 * Initialize SQLite schema for HobBot Agent state.
 * Uses this.sql tagged template from Agent class (synchronous).
 */
export function initSchema(sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown): void {
  sql`CREATE TABLE IF NOT EXISTS calendar (
    id TEXT PRIMARY KEY,
    scheduled_at TEXT NOT NULL,
    theme TEXT,
    arrangement_slug TEXT,
    narrative_thread TEXT,
    status TEXT DEFAULT 'planned',
    created_at TEXT DEFAULT (datetime('now'))
  )`

  sql`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    calendar_id TEXT REFERENCES calendar(id),
    text TEXT NOT NULL,
    alt_text TEXT,
    image_url TEXT,
    image_provider TEXT,
    text_provider TEXT,
    atoms_used TEXT,
    arrangement_slug TEXT,
    posted_at TEXT,
    x_post_id TEXT,
    engagement TEXT,
    engagement_updated_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`

  sql`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active',
    posts_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`

  sql`CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    signal_type TEXT,
    data TEXT NOT NULL,
    relevance_score REAL,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`

  sql`CREATE TABLE IF NOT EXISTS knowledge_cache (
    query TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
  )`
}
