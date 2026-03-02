# Task Brief 01: Post-Ingest Automation

## Problem

After knowledge ingest (or any atom creation path) adds new atoms, they land with `embedding_status = 'pending'` and may need classification. Currently this requires manual curl calls to the grimoire worker:

```bash
# Manual step 1: classify unclassified atoms
curl -X POST https://grimoire.damp-violet-bf89.workers.dev/admin/classify-batch

# Manual step 2: vectorize pending atoms
curl -X POST https://grimoire.damp-violet-bf89.workers.dev/admin/vectorize-batch
```

This kills momentum during bulk loading. Every knowledge ingest, every discovery queue accept, every batch admin import requires remembering to trigger these manually.

## Solution

Wire the grimoire worker's existing 15-minute cron to automatically pick up and process pending atoms. The cron handler already exists. Add two processing steps to it.

## Implementation

### Locate the cron handler

File: `C:\Users\xkxxk\grimoire\workers\grimoire\src\index.ts` (or wherever the `scheduled` export lives)

The grimoire worker already has a `scheduled(event, env, ctx)` handler registered. Find it.

### Add auto-classification

After any existing cron logic, add:

```typescript
// Auto-classify atoms missing category_slug
const unclassified = await env.GRIMOIRE_DB.prepare(
  "SELECT COUNT(*) as count FROM atoms WHERE (category_slug IS NULL OR category_slug = '') AND status != 'rejected'"
).first<{ count: number }>();

if (unclassified && unclassified.count > 0) {
  // Call the existing classify-batch logic internally
  // Don't use HTTP self-call; invoke the function directly
  // The classify-batch endpoint handler already has the batch logic
  // Extract it into a shared function if it isn't already
  console.log(`[cron] ${unclassified.count} atoms need classification`);
  
  // Process in batches of 50 (match existing classify-batch behavior)
  // Use the same Gemini Flash call pattern already in the classify-batch handler
  // Limit to 200 per cron tick to avoid timeout (15-min cron, ~3s per Gemini call)
  await classifyBatch(env, { limit: 200 });
}
```

### Add auto-vectorization

After classification:

```typescript
// Auto-vectorize atoms with pending embeddings
const pendingEmbeddings = await env.GRIMOIRE_DB.prepare(
  "SELECT COUNT(*) as count FROM atoms WHERE embedding_status = 'pending'"
).first<{ count: number }>();

if (pendingEmbeddings && pendingEmbeddings.count > 0) {
  console.log(`[cron] ${pendingEmbeddings.count} atoms need vectorization`);
  
  // Process in batches of 100 (match existing vectorize-batch behavior)
  // bge-base-en-v1.5 via Workers AI is fast; 100 per tick is conservative
  await vectorizeBatch(env, { limit: 100 });
}
```

### Refactor if needed

If `classify-batch` and `vectorize-batch` are currently only accessible as HTTP endpoint handlers, extract the core logic into standalone functions:

```typescript
// src/services/classify.ts (or wherever the logic lives)
export async function classifyBatch(env: Env, opts: { limit: number }): Promise<{ classified: number; errors: number }> {
  // ... existing classify-batch logic, extracted from the route handler
}

// src/services/vectorize.ts
export async function vectorizeBatch(env: Env, opts: { limit: number }): Promise<{ vectorized: number; errors: number }> {
  // ... existing vectorize-batch logic, extracted from the route handler
}
```

Both the cron handler and the REST endpoints call these same functions. No logic duplication.

### Guard against overlapping cron runs

The 15-min cron interval is long enough that overlap is unlikely, but add a simple guard:

```typescript
// At the start of the cron handler
const lockKey = 'cron:processing';
const lock = await env.GRIMOIRE_DB.prepare(
  "SELECT value FROM _cf_KV WHERE key = ?"
).bind(lockKey).first();

if (lock) {
  console.log('[cron] Previous run still in progress, skipping');
  return;
}

// Set lock
await env.GRIMOIRE_DB.prepare(
  "INSERT OR REPLACE INTO _cf_KV (key, value) VALUES (?, ?)"
).bind(lockKey, new Date().toISOString()).run();

try {
  // ... classification + vectorization logic
} finally {
  // Release lock
  await env.GRIMOIRE_DB.prepare(
    "DELETE FROM _cf_KV WHERE key = ?"
  ).bind(lockKey).run();
}
```

If `_cf_KV` isn't being used for this pattern, a simpler alternative: just check if there are pending atoms and process them. At 200 classify + 100 vectorize per tick, the worst case for duplicate processing is wasted Gemini calls, not data corruption.

## Limits Per Cron Tick

| Operation | Limit | Reasoning |
|-----------|-------|-----------|
| Classification | 200 atoms | ~3s per Gemini call, batches of 50 = 4 batches = ~12s total |
| Vectorization | 100 atoms | bge-base-en-v1.5 is fast, 100 is conservative |

At 15-min intervals: classification backlog of 1000 atoms clears in ~75 minutes. Vectorization backlog of 1000 clears in ~2.5 hours. For bulk loads of 10K+ atoms, the manual endpoints still exist as a fast path.

## Verification

1. Ingest a test atom via MCP: `grimoire_ingest(text: "test-auto-process", collection_slug: "uncategorized", source_app: "test")`
2. Confirm it has `embedding_status = 'pending'` and no `category_slug`
3. Wait for cron tick (or trigger manually via wrangler)
4. Verify the atom now has `category_slug` assigned and `embedding_status = 'complete'`
5. Clean up: delete the test atom

## Files Changed

| File | Action |
|------|--------|
| Cron handler (index.ts or scheduled.ts) | MODIFY: Add classify + vectorize calls |
| Classify logic | MODIFY or EXTRACT: Make callable from both REST and cron |
| Vectorize logic | MODIFY or EXTRACT: Make callable from both REST and cron |

## What NOT to Change

- REST endpoints stay as-is (they're the fast path for bulk operations)
- Existing cron jobs (integrity scan, evolve report) stay untouched
- No changes to HobBot worker
- No changes to atom schema
