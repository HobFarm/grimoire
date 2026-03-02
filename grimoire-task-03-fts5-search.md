# Task Brief 03: FTS5 Full-Text Search

## Depends On

No hard dependencies. Can run in parallel with Task 02 (re-vectorization). Do this before bulk-loading new content so the search index builds incrementally.

## Problem

Atom text search uses LIKE queries:

```sql
SELECT * FROM atoms WHERE text_lower LIKE '%neon%' AND status != 'rejected' LIMIT 20
```

LIKE with leading wildcards cannot use indexes. On 154K rows, every search is a full table scan. Results are unranked (order is insertion order, not relevance). No support for multi-word phrases, prefix matching, or term proximity.

## Solution

Add an FTS5 virtual table. D1 supports FTS5 natively. Keep the existing `text_lower` column and LIKE queries as a fallback; add FTS5 as the primary search path.

### Step 1: Migration

Create migration file: `migrations/XXXX_fts5_search.sql`

```sql
-- FTS5 virtual table for atom text search
-- tokenize='porter unicode61' gives stemming (search "lighting" finds "lit", "lights")
-- content='' makes it an external content table (no data duplication)
-- content_rowid='rowid' links back to atoms table

CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(
  text,
  collection_slug,
  category_slug,
  content='atoms',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Populate from existing data
INSERT INTO atoms_fts(rowid, text, collection_slug, category_slug)
SELECT rowid, text, collection_slug, category_slug FROM atoms WHERE status != 'rejected';

-- Triggers to keep FTS in sync with atoms table
CREATE TRIGGER IF NOT EXISTS atoms_fts_insert AFTER INSERT ON atoms
WHEN NEW.status != 'rejected'
BEGIN
  INSERT INTO atoms_fts(rowid, text, collection_slug, category_slug)
  VALUES (NEW.rowid, NEW.text, NEW.collection_slug, NEW.category_slug);
END;

CREATE TRIGGER IF NOT EXISTS atoms_fts_delete AFTER DELETE ON atoms
BEGIN
  INSERT INTO atoms_fts(atoms_fts, rowid, text, collection_slug, category_slug)
  VALUES ('delete', OLD.rowid, OLD.text, OLD.collection_slug, OLD.category_slug);
END;

CREATE TRIGGER IF NOT EXISTS atoms_fts_update AFTER UPDATE OF text, collection_slug, category_slug, status ON atoms
BEGIN
  -- Remove old entry
  INSERT INTO atoms_fts(atoms_fts, rowid, text, collection_slug, category_slug)
  VALUES ('delete', OLD.rowid, OLD.text, OLD.collection_slug, OLD.category_slug);
  -- Add new entry (only if not rejected)
  INSERT INTO atoms_fts(rowid, text, collection_slug, category_slug)
  SELECT NEW.rowid, NEW.text, NEW.collection_slug, NEW.category_slug
  WHERE NEW.status != 'rejected';
END;
```

**D1 caveat**: Verify D1 supports FTS5 triggers. If triggers don't fire in D1 (some SQLite hosts disable them), the alternative is manual FTS updates in the state layer alongside atom writes. Check by running the migration and testing an insert.

**Alternative if triggers fail**: Skip triggers. Add explicit FTS insert/update/delete calls in the state layer functions that modify atoms (ingestAtom, updateAtom, deleteAtom, etc.). More code, but guaranteed to work.

### Step 2: Query function

Add to the state layer (e.g., `src/state/atoms.ts` or `src/state/search.ts`):

```typescript
interface FtsSearchResult {
  id: string;
  text: string;
  collection_slug: string;
  category_slug: string;
  rank: number;
  // ... other atom fields via JOIN
}

export async function ftsSearch(
  db: D1Database,
  query: string,
  opts?: {
    category?: string;
    collection?: string;
    modality?: string;
    status?: string;
    limit?: number;
  }
): Promise<FtsSearchResult[]> {
  const limit = Math.min(opts?.limit ?? 20, 100);
  
  // FTS5 match syntax supports:
  // - Simple terms: "neon"
  // - Phrases: '"neon glow"'
  // - Prefix: "neo*"
  // - Boolean: "neon AND glow", "neon OR glow", "neon NOT green"
  // - Column filter: "text:neon"
  
  // Sanitize query for FTS5 (escape special characters)
  const safeQuery = sanitizeFtsQuery(query);
  
  let sql = `
    SELECT a.*, fts.rank
    FROM atoms_fts fts
    JOIN atoms a ON a.rowid = fts.rowid
    WHERE atoms_fts MATCH ?
  `;
  const binds: any[] = [safeQuery];
  
  if (opts?.category) {
    sql += ' AND a.category_slug = ?';
    binds.push(opts.category);
  }
  if (opts?.collection) {
    sql += ' AND a.collection_slug = ?';
    binds.push(opts.collection);
  }
  if (opts?.modality) {
    sql += ' AND a.modality = ?';
    binds.push(opts.modality);
  }
  if (opts?.status) {
    sql += ' AND a.status = ?';
    binds.push(opts.status);
  } else {
    sql += " AND a.status != 'rejected'";
  }
  
  sql += ' ORDER BY fts.rank LIMIT ?';
  binds.push(limit);
  
  const result = await db.prepare(sql).bind(...binds).all<FtsSearchResult>();
  return result.results ?? [];
}

function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 special operators if user didn't intend them
  // Keep * for prefix search if at end of a word
  // Strip dangerous characters
  return query
    .replace(/[(){}[\]]/g, '')  // Remove brackets
    .replace(/"/g, '')          // Remove quotes (prevent injection)
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, (m) => m.toLowerCase())  // Lowercase operators to treat as terms
    .trim();
}
```

### Step 3: Wire into grimoire_search MCP tool

In the HobBot MCP server, update the `grimoire_search` tool handler to use FTS5 when available:

```typescript
// In handle.ts or wherever search() is implemented
async search(q, opts) {
  // Try FTS5 first
  try {
    return await ftsSearch(db, q, opts);
  } catch (e) {
    // Fallback to LIKE if FTS5 isn't available
    console.warn('[search] FTS5 failed, falling back to LIKE:', e.message);
    return await likeSearch(db, q, opts);
  }
}
```

Keep the LIKE fallback. If the FTS5 migration hasn't run on a given environment, search still works.

### Step 4: Update grimoire_recommend

The recommend tool also uses text search internally. Route it through the same FTS5 path.

## Verification

```sql
-- Test FTS5 directly
SELECT a.text, a.category_slug, fts.rank
FROM atoms_fts fts
JOIN atoms a ON a.rowid = fts.rowid
WHERE atoms_fts MATCH 'neon'
ORDER BY fts.rank
LIMIT 10;
```

Compare results with the old LIKE query:

```sql
SELECT text, category_slug FROM atoms WHERE text_lower LIKE '%neon%' AND status != 'rejected' LIMIT 10;
```

FTS5 results should be ranked by relevance. Multi-word searches like `'neon glow'` should return better results than LIKE `'%neon glow%'` (which only matches exact substring).

Test via MCP: `grimoire_search(q: "neon glow", limit: 10)` should return ranked results.

## Files Changed

| File | Action |
|------|--------|
| New migration SQL file | NEW: FTS5 table + triggers |
| State layer search function | NEW or MODIFY: Add ftsSearch() |
| GrimoireHandle search method | MODIFY: Route through FTS5 with LIKE fallback |
| MCP search tool handler | NO CHANGE (calls handle.search which is updated) |

## Performance Notes

FTS5 initial population from 154K atoms may take 10-30 seconds on D1. After that, incremental updates via triggers are instant. Query performance should be orders of magnitude faster than LIKE with leading wildcards.

## Risk

**Low.** FTS5 is additive. The atoms table and LIKE queries remain unchanged. If FTS5 causes any issues, remove the virtual table and triggers; everything falls back to the existing behavior.

The one unknown is D1's FTS5 trigger support. Test the migration in a dev environment first if possible. If triggers don't fire, switch to manual FTS updates in the state layer.
