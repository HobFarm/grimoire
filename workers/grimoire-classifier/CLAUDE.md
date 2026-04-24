# Grimoire Classifier Worker

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

Bulk classification and harmonization of atoms in the Grimoire. Assigns category_slug and harmonic profiles to uncategorized atoms. Workers AI (Nemotron) primary with Gemini fallback, circuit breaker via shared PROVIDER_HEALTH KV. Manual trigger only (no crons, no queues). Run it, watch logs, iterate on prompt quality.

This is the exception to the Grimoire's single-writer rule: it writes directly to GRIMOIRE_DB alongside the grimoire worker. This is a pragmatic choice for bulk operations, not a pattern to replicate elsewhere.

## Worker Bindings

Verify against `wrangler.toml` before making changes. If this list and wrangler.toml disagree, wrangler.toml wins.

| Binding | Type | Purpose |
|---------|------|---------|
| GRIMOIRE_DB | D1 (grimoire-db) | Direct read/write to atoms table |
| AI | Workers AI | Primary classification provider (Nemotron) |
| PROVIDER_HEALTH | KV | Circuit breaker state (shared across workers) |
| GEMINI_API_KEY | Secrets Store | Gemini API auth (fallback) |
| AI_GATEWAY_TOKEN | Secrets Store | Cloudflare AI Gateway auth |

### Environment Variables

| Var | Purpose |
|-----|---------|
| AI_GATEWAY_ACCOUNT_ID | Cloudflare account for AI Gateway routing |
| AI_GATEWAY_NAME | Gateway instance name ("hobfarm") |

### Notable

- **No service bindings.** Fully standalone, talks only to D1 and AI providers.
- **Shared PROVIDER_HEALTH KV.** Same KV namespace as the grimoire worker. Circuit breaker state is shared: if Nemotron trips in the grimoire worker, this worker also skips it.

## HTTP Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /status | Classification progress stats (total, categorized, uncategorized, by collection) |
| POST | /classify | Classify uncategorized atoms |
| POST | /harmonize | Add harmonics to already-categorized atoms (preserves existing category_slug) |
| GET | / (default) | Returns endpoint documentation |

### Query Parameters

| Param | Route | Default | Purpose |
|-------|-------|---------|---------|
| batch_size | /classify, /harmonize | 50 | Atoms per batch (capped at 100) |
| collection | /classify | all | Filter by collection_slug |
| dry_run | /classify | false | Preview classifications without writing |

## AI Call Sites

| Function | File | Task | Primary Model | Fallback | Context |
|----------|------|------|--------------|----------|---------|
| classifyBatch() | src/index.ts | Bulk classification + harmonics | Workers AI (Nemotron) | Gemini Flash | ~2000 tok/batch |

Model strings are imported from the shared registry (`HobBot/src/shared/models.ts`). Check there for current values, not this file.

### Provider Routing

All AI calls go through `callClassifier()` in `src/ai.ts`:
- **Primary:** Workers AI (Nemotron) via `env.AI.run()` with JSON mode (`response_format: { type: 'json_object' }`)
- **Fallback:** Gemini via AI Gateway, then direct Google API on 401
- **Circuit breaker:** Checks PROVIDER_HEALTH KV before each provider. 3 failures in 5 min triggers 15 min cooldown.
- **Think-block stripping:** Removes `<think>...</think>` from Nemotron output before JSON parse
- **Timeout:** 30s on Workers AI (via Promise.race), 15s on Gemini fetch calls

### Classification Output Schema

The model returns a JSON array. Each element:
```json
{"id": "atom_id", "cat": "category_slug", "h": {"hardness": "...", "temperature": "...", "weight": "...", "formality": "...", "era_affinity": "..."}}
```

Post-parse validation:
- Category validated against live D1 query via `getCategoryMetadata()` (fetched at runtime, not hardcoded). Invalid categories are silently dropped.
- Each harmonic dimension is validated with `clampScore()` (clamps 0.0-1.0, defaults to 0.5 on invalid)

### Harmonic Dimensions (numeric 0.0-1.0)

This worker outputs numeric 0.0-1.0 harmonic scores, matching the grimoire worker's queue-based classifier.

| Dimension | 0.0 | 1.0 |
|-----------|-----|-----|
| hardness | soft, organic, flowing | hard, geometric, rigid |
| temperature | cool, clinical, detached | warm, intimate, organic |
| weight | light, airy, minimal | heavy, dense, substantial |
| formality | organic, natural, irregular | structured, geometric, precise |
| era_affinity | ancient, historical | contemporary, futuristic |

## Database Operations

All writes target the `atoms` table only. Categories are read from the `categories` table at runtime for validation.

| Endpoint | Operation | Fields Written |
|----------|-----------|----------------|
| /classify | UPDATE | category_slug, harmonics |
| /harmonize | UPDATE | harmonics only (preserves category_slug) |

D1 batch limit is 100 statements. The worker chunks writes into groups of 50.

## Known Issues and Tech Debt

**Inline prompt.** The CLASSIFICATION_PROMPT is a ~100-line template literal in the main file. Should be extracted to a dedicated prompt file or constant module.

**Single-file worker.** Core logic is in index.ts (~300 lines) with ai.ts as provider utility (~200 lines). Acceptable for the worker's focused scope.

## File Structure

```
workers/grimoire-classifier/
  src/
    index.ts              # Types, prompt, classify/harmonize endpoints, routes
    ai.ts                 # Provider utility: callClassifier(), circuit breaker, Workers AI + Gemini
  wrangler.toml
  CLAUDE.md               # This file
```

The `ai.ts` provider utility is local to this worker, modeled on the custodian's `ai.ts` pattern but enhanced with circuit breaker and AI Gateway support. It borrows patterns from `workers/grimoire/src/provider.ts`, `gemini.ts`, and `circuit-breaker.ts` but does not import them directly (they are tightly coupled to the grimoire worker's types).

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings
3. If touching classification logic, also read workers/grimoire/src/atom-classify.ts (the queue-based equivalent)
4. If touching categories, query GRIMOIRE_DB: `SELECT slug FROM categories ORDER BY slug`
5. If touching AI calls, read src/ai.ts and workers/grimoire/src/provider.ts for reference patterns

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- File references must be repo-root relative (e.g. workers/grimoire-classifier/src/index.ts)

### Code Rules

- All AI calls through `callClassifier()` in `src/ai.ts`. No raw fetch() or env.AI.run() in index.ts.
- Model strings from shared registry (`HobBot/src/shared/models.ts`). No local model constants.
- Named constants for batch sizes and limits
- Categories queried from D1 at runtime via `getCategoryMetadata()`. Never hardcoded.
- Validate all model JSON output (already done, maintain this pattern)
- D1 batch writes must stay chunked at 50 (D1 limit is 100, leave headroom)
- Accept both short keys (cat, h) and full keys (category_slug, harmonics) from model output

### What NOT To Do

- Do not add cron triggers. This worker is intentionally manual-trigger only.
- Do not add queue consumers. Use the grimoire worker's queues for automated classification.
- Do not write to any table other than atoms.
- Do not remove the dry_run capability.
- Do not hardcode model strings. They live in the shared registry.
- Do not hardcode category lists. They are queried from D1.
- Do not bypass the circuit breaker by calling providers directly.

## Build and Deploy

```bash
cd workers/grimoire-classifier
npm run build
npx wrangler deploy
```

No crons, no queues, no post-deploy verification needed beyond confirming the worker responds at /status.

## Relationship to Other Workers

| Worker | Relationship |
|--------|-------------|
| grimoire | Shares GRIMOIRE_DB. Both write to atoms table. grimoire handles queue-based continuous classification; this worker handles manual bulk operations. |
| hobbot-pipeline | No direct relationship. Pipeline atoms flow through grimoire worker's queues, not this worker. |
| All others | No relationship. |
