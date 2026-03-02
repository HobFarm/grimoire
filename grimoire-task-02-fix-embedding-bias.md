# Task Brief 02: Fix Embedding Category Bias

## Depends On

Task 01 (post-ingest automation) should be complete first so the re-vectorization can be triggered automatically. If not, the manual vectorize-batch endpoint works fine.

## Problem

The `buildEmbeddingText()` function (or equivalent) currently constructs embedding input as:

```typescript
`${atom.text} ${atom.collection_slug} ${atom.category_slug}`
```

Including `category_slug` in the embedding text causes atoms in the same category to cluster together in vector space regardless of semantic meaning. "neon glow" (lighting.source) and "spotlight beam" (lighting.source) end up closer to each other than "neon glow" and "cyberpunk cityscape" (environment.setting), even though the second pair is semantically richer for composition.

This forces the semantic correspondence discovery to use topK=50 + client-side cross-category filtering as a workaround. It also degrades `grimoire_recommend` and any future semantic search.

## Solution

Remove `category_slug` from the embedding text. Optionally keep `collection_slug` (it's broader and adds useful context without the clustering problem). Then re-vectorize all 154K atoms.

### Step 1: Fix buildEmbeddingText

Find the function that constructs text for the embedding model. It's in the grimoire worker, likely in the vectorization service or a shared utility.

Change from:
```typescript
function buildEmbeddingText(atom: AtomRow): string {
  return [atom.text, atom.collection_slug, atom.category_slug].filter(Boolean).join(' ');
}
```

Change to:
```typescript
function buildEmbeddingText(atom: AtomRow): string {
  return atom.text;
  // collection_slug and category_slug intentionally excluded
  // to prevent same-category clustering bias in vector space.
  // Category filtering happens at query time via metadata, not embedding similarity.
}
```

If you want to keep collection_slug for broad context (reasonable), use:
```typescript
function buildEmbeddingText(atom: AtomRow): string {
  return atom.collection_slug ? `${atom.text} ${atom.collection_slug}` : atom.text;
}
```

I'd start with text-only. You can always re-vectorize again if collection context turns out to help.

### Step 2: Re-vectorize all atoms

Set all atoms to `embedding_status = 'pending'`:

```sql
UPDATE atoms SET embedding_status = 'pending' WHERE embedding_status = 'complete';
```

**WARNING:** This is a 154K row update. Run it on remote D1:

```powershell
cd C:\Users\xkxxk\grimoire\workers\grimoire
npx wrangler d1 execute grimoire-db --remote --command "UPDATE atoms SET embedding_status = 'pending' WHERE embedding_status = 'complete'"
```

### Step 3: Process the backlog

If Task 01 is complete, the cron will automatically process 100 atoms per 15-min tick. At that rate, 154K atoms takes ~384 hours (16 days). Too slow.

Use the manual vectorize-batch endpoint in a loop:

```powershell
# PowerShell loop to re-vectorize in batches
$headers = @{ "Authorization" = "Bearer YOUR_SERVICE_TOKEN" }
$url = "https://grimoire.damp-violet-bf89.workers.dev/admin/vectorize-batch"

for ($i = 0; $i -lt 1540; $i++) {
    $response = Invoke-RestMethod -Uri $url -Method POST -Headers $headers
    Write-Host "Batch $i : $($response | ConvertTo-Json -Compress)"
    Start-Sleep -Seconds 2  # Rate limit buffer
}
```

Adjust batch size inside the vectorize-batch handler if needed. At 100 per batch with 2s delay: 1540 batches * 2s = ~51 minutes. Workers AI rate limits may require longer delays; adjust if you hit 429s.

### Step 4: Verify

After re-vectorization completes:

```sql
SELECT embedding_status, COUNT(*) as count FROM atoms GROUP BY embedding_status;
```

Expected: all `complete` (except the 1 previously failed atom).

Test cross-category search quality:

```
grimoire_search(q: "neon glow", limit: 20)
```

Results should include atoms from multiple categories (lighting.source, color.palette, environment.atmosphere, style.genre) rather than clustering heavily in one category.

### Step 5: Re-run semantic correspondence discovery (optional, recommended)

The existing semantic correspondences (70K evokes, 38K resonates) were computed with the biased embeddings. For maximum benefit, re-run:

```bash
curl -X POST https://grimoire.damp-violet-bf89.workers.dev/admin/discover-semantic-correspondences
```

This will find better cross-category relationships now that the embeddings aren't category-biased. Expect the topK=50 workaround in the discovery code to become less necessary, though it's harmless to keep.

## Files Changed

| File | Action |
|------|--------|
| Vectorization function (embedding text builder) | MODIFY: Remove category_slug from embedding text |

## What NOT to Change

- Vectorize index configuration (768-dim cosine stays the same)
- Correspondence discovery logic (the topK=50 workaround is harmless, can optimize later)
- Atom schema (category_slug stays on the atom, just not in the embedding)
- Classification pipeline (unrelated to embeddings)

## Risk

**Low.** The Vectorize index handles upserts. Re-vectorizing the same atom IDs with new embeddings replaces the old vectors. No data loss. If the new embeddings somehow perform worse (unlikely), you can revert buildEmbeddingText and re-vectorize again.

The only real risk is Workers AI rate limiting during the 154K re-embed. Monitor for 429 responses and add delays as needed.
