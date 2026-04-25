# Grimoire Worker

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

The Grimoire is the knowledge graph for all HobFarm projects. It owns GRIMOIRE_DB exclusively. Handles classification, vectorization, search, taxonomy, correspondence discovery, and arrangement tagging. Every other worker reads and writes through this worker's service binding API or shared D1 read binding.

When StyleFusion needs vocabulary, it queries here. When the pipeline enriches chunks, it calls here. When the chat interface searches, it hits here. Single source of truth.

## Worker Bindings

Verify against `wrangler.toml` before making changes. If this list and wrangler.toml disagree, wrangler.toml wins.

| Binding | Type | Purpose |
|---------|------|---------|
| DB | D1 (grimoire-db) | All five knowledge layers |
| HOBBOT_DB | D1 (hobbot-db) | Read-only access for cross-worker queries |
| AI | Workers AI | Embeddings, reranking, classification fallback |
| VECTORIZE | Vectorize (grimoire-atoms) | Semantic search index (bge-base-en-v1.5) |
| R2 | R2 (hobfarm-cdn) | Daily review markdown output |
| GRIMOIRE_R2 | R2 (grimoire) | Manifests, specs, moodboards, image refs, analysis docs |
| PROVIDER_HEALTH | KV | Circuit breaker state (shared across workers) |
| CONNECTIVITY_KV | KV | Phase 8 event queue, sweep watermark, daily stats, `manifests:last_build` |
| GEMINI_API_KEY | Secrets Store | Gemini API auth |
| AI_GATEWAY_TOKEN | Secrets Store | Cloudflare AI Gateway auth |
| SERVICE_TOKENS | Secrets Store | CSV of `name:secret` pairs guarding `/admin/*` and `/api/v1/*` |
| CLASSIFY_QUEUE | Queue producer | grimoire-classify |
| DISCOVERY_QUEUE | Queue producer | grimoire-discovery |
| VECTORIZE_QUEUE | Queue producer | grimoire-vectorize |
| ENRICH_QUEUE | Queue producer | grimoire-enrich |
| BULK_RETAG_WORKFLOW | Workflow | BulkRetagWorkflow |
| BULK_CORRESPONDENCES_WORKFLOW | Workflow | BulkCorrespondencesWorkflow |

### Environment Variables

| Var | Purpose |
|-----|---------|
| AI_GATEWAY_ACCOUNT_ID | Cloudflare account for AI Gateway routing |
| AI_GATEWAY_NAME | Gateway instance name ("hobfarm") |
| ALLOWED_ORIGINS | CORS allowlist (comma-separated) |

## Scheduled Task: scanAndEnqueue

Runs every 15 minutes. Scans D1 for unprocessed atoms and dispatches to queues, plus runs Phase 8 inline. Phases 1–6 use the `last_enqueued_at` 30-minute re-enqueue guard to prevent duplicate processing. Phase numbering jumps from 6 to 8 (no Phase 7).

| Phase | What It Finds | Queue Target | Limit |
|-------|--------------|--------------|-------|
| 1 | Unclassified atoms (no category_slug) | grimoire-classify | 200 |
| 2 | Pending atom embeddings | grimoire-vectorize | 100 |
| 2b | Pending document_chunk embeddings | grimoire-vectorize | 100 |
| 3 | Missing harmonics (empty or null) | grimoire-classify (enrich-harmonics) | 10 |
| 4 | Stale arrangement tags (tag_version < current) | grimoire-enrich (tag-arrangements) | 50 |
| 5 | Missing register classification | grimoire-classify (classify-register) | 10 |
| 6 | Atoms with no semantic correspondences | grimoire-enrich (discover-correspondences) | 200 |
| 8 | Connectivity Agent: drains `CONNECTIVITY_KV` event queue, then runs a watermark-based sweep | inline, KV queue only | batch sized in `connectivity.ts` |

Queue sendBatch max is 100 messages. Phase 1 and 6 chunk into batches of 100.

Phase 8 also triggers the **Manifest Builder** when its sweep wraps around the atom table (watermark resets to `''`). Guarded by a 24-hour floor in the `manifests:last_build` KV key so quiet-period rapid wraps don't thrash the build. The trigger uses `ctx.waitUntil()` so the cron tick returns immediately while the build runs in background.

All cron phase queries depend on D1 indexes for performance. See "D1 Query Performance" under Rules for CC before modifying any phase query.

## Connectivity Agent (Phase 8)

Maintains graph density as new atoms arrive. Fully event-driven with a sweep fallback:

- **Event path:** `createAtomWithHooks`, `bulkInsertAtomsWithHooks`, and `encounterAtomWithHooks` in `src/atoms.ts` enqueue atom IDs into the `CONNECTIVITY_KV` queue at confirmation time. Phase 8 drains a batch each tick.
- **Sweep path:** when the event queue is empty, Phase 8 walks the atoms table by `id > watermark` using `connectivity:watermark` in KV. Already-connected atoms are skipped inside `processConnectivityBatch`. Sweep failures advance the watermark anyway (poison-atom protection) and log to `connectivity:failed:{date}`.

Three algorithmic scorers per atom (no LLM):
- **Tag propagation** — if 3+ of an atom's nearest vector neighbors share a tag, apply it
- **Dimensional membership** — score against pole centroids cached in `connectivity:axis:{slug}:centroids`
- **Correspondence discovery** — connect under-connected atoms to high-similarity neighbors

## Manifest Builder

Packages domain-specific slices of the graph into pre-computed JSON files in R2. See `src/manifests.ts`, `src/routes/manifests.ts`.

| Endpoint | Purpose |
|---|---|
| `POST /admin/manifests/build` | Build all specs found under `specs/manifests/` |
| `POST /admin/manifests/build/:slug` | Rebuild a single manifest |
| `GET /admin/manifests` | List built manifests (reads `.meta.json` sidecars, not the multi-MB JSON files) |

Outputs `grimoire://manifests/{slug}.json` (gzipped, served with `Content-Encoding: gzip`) plus a small `.meta.json` sidecar. Default correspondence-provenance filter is `[harmonic, semantic]` — `co_occurrence` is excluded by default to keep the in-memory snapshot under the worker memory ceiling. Specs can opt in via `correspondence_filter.provenances`.

Auto-rebuilds on Connectivity Agent sweep wrap-around (24h KV floor in `manifests:last_build`).

## Queues

| Queue | Consumer | Batch Size | Concurrency | Retries | DLQ |
|-------|----------|-----------|-------------|---------|-----|
| grimoire-classify | handleClassifyBatch | 10 | 1 | 3 | grimoire-classify-dlq |
| grimoire-discovery | handleClassifyBatch | 5 | 1 | 3 | grimoire-classify-dlq |
| grimoire-vectorize | handleVectorizeBatch | 20 | 2 | 3 | grimoire-vectorize-dlq |
| grimoire-enrich | handleEnrichBatch | 50 | 5 | 3 | grimoire-enrich-dlq |

DLQ consumers log failures to D1. All three DLQs use batch size 10.

### Queue Message Types

| Message Type | Queue | Handler Action |
|-------------|-------|----------------|
| classify | grimoire-classify | Classify atom category |
| enrich-harmonics | grimoire-classify | Score harmonic dimensions |
| classify-register | grimoire-classify | Classify register dimension |
| vectorize | grimoire-vectorize | Generate embedding, upsert to Vectorize |
| tag-arrangements | grimoire-enrich | Tag atom with matching arrangements |
| discover-correspondences | grimoire-enrich | Find semantic neighbors, create correspondences |

## Workflows

| Workflow | Class | Purpose |
|----------|-------|---------|
| grimoire-bulk-retag | BulkRetagWorkflow | Bulk arrangement retagging |
| grimoire-bulk-correspondences | BulkCorrespondencesWorkflow | Bulk correspondence discovery |

Exported from `src/workflows.ts`. Cloudflare requires class exports from the main entry point.

## HTTP Routes

### Core API

| Method | Route | Handler | Purpose |
|--------|-------|---------|---------|
| GET | /health | inline | Health check |
| POST | /classify | classifyText | Single text classification |
| POST | /classify/batch | classifyText (parallel) | Batch text classification |
| GET | /categories | listCategories | List all categories |
| GET | /categories/:slug/contexts | getCategoryContexts | Category context entries |

### Cache Management

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /cache/stats | Classification cache stats |
| DELETE | /cache | Clear all cache |
| DELETE | /cache/:slug | Clear cache by category |

### Collections

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /collections | List all |
| GET | /collections/tree | Hierarchical tree |
| POST | /collections | Create |
| GET | /collections/:slug | Get one |
| PUT | /collections/:slug | Update |
| DELETE | /collections/:slug | Delete |

### Atoms (Vocabulary)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /atoms | List (paginated, filterable) |
| GET | /atoms/review | Atoms pending review |
| GET | /atoms/stats | Atom statistics |
| POST | /atoms | Create single |
| POST | /atoms/bulk | Bulk insert |
| GET | /atoms/:id | Get one |
| PUT | /atoms/:id | Full update |
| PATCH | /atoms/:id | Partial update |
| DELETE | /atoms/:id | Delete |
| POST | /atoms/:id/encounter | Record encounter |

### Search

| Method | Route | Purpose |
|--------|-------|---------|
| POST | /search | Semantic atom search (vectorize) |

### Discovery & Decomposition

| Method | Route | Purpose |
|--------|-------|---------|
| POST | /discover | Discover new atoms from text |
| POST | /decompose | Decompose concept into sub-concepts |

### Routing (StyleFusion integration)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | /routing | Set routing for atom |
| GET | /routing/:app | Get routing for app |
| POST | /routing/bulk | Bulk set routing |
| DELETE | /routing/:app/:atomId | Delete routing |

### Content Router

| POST | /content/route | Route content to appropriate handler |

### Arrangements

| GET | /arrangements | List all |
| GET | /arrangements/manifest | Compact reference for ingest agents |
| GET | /arrangements/:slug | Get one with contexts |

### Admin

All `/admin/*` and `/api/v1/*` routes require `Authorization: Bearer <secret>` matching one of the entries in the `SERVICE_TOKENS` Secrets Store CSV. The server splits each `name:secret` pair on the colon and compares against just the `secret` portion — clients send only that bare secret, **not** the `name:secret` pair.

| Method | Route | Purpose |
|--------|-------|---------|
| POST | /admin/tag-arrangements | Bulk arrangement tagging (one-shot) |
| POST | /admin/manifests/build | Rebuild all manifests |
| POST | /admin/manifests/build/:slug | Rebuild a single manifest |
| GET | /admin/manifests | List built manifests with metadata |
| * | /admin/* | Admin sub-app (see `src/admin.ts`) |
| * | /admin/moodboard/* | Moodboard sub-apps (see `src/routes/moodboard.ts`, `routes/moodboard-analysis.ts`) |
| * | /admin/dimension/* | Dimensional vocab sub-app |
| * | /knowledge/* | Knowledge sub-app (see `src/knowledge.ts`) |
| * | /image/* | Image extraction sub-app |
| POST | /api/v1/resolve | Phrase-to-atom resolver (used by StyleFusion) |
| GET | /review/daily | Daily review markdown (no auth; service-binding-only access in practice) |

### Service Binding RPC (invoke)

The `invoke()` function handles typed RPC calls from other workers via service binding. See `src/invoke.ts` for the full action list.

## AI Call Sites

Every AI call in this worker routes through the model registry at `HobBot/src/shared/models.ts`. The registry maps task names (`grimoire.classify`, `grimoire.classify-register`, `grimoire.discover`, `grimoire.decompose`, `moodboard.aggregate`, etc.) to a primary model + fallback chain. **Don't list specific model strings here** — they change. Read `models.ts` for current values.

Functions performing AI calls:

| Function | File | Task | Notes |
|----------|------|------|-------|
| `vectorizeAtomBatch()` | `src/vectorize.ts` | Atom embeddings | Batch of ~100 texts via `env.AI.run()` |
| `vectorizeChunkBatch()` | `src/vectorize.ts` | Chunk embeddings | Batch of ~100 texts |
| `searchAtoms()` / `searchDocumentChunks()` | `src/vectorize.ts` | Query embedding | Single text |
| `rerankCandidates()` | `src/reranker.ts` | Cross-encoder rerank | Query + candidates |
| `classifyAtom()` | `src/atom-classify.ts` | Category + harmonics | Reads task `grimoire.classify` from registry |
| `classifyRegister()` | `src/atom-classify.ts` | Register scoring | Reads task `grimoire.classify-register` |
| `discoverAtom()` / `decomposeAtom()` | `src/suggest.ts` | New term discovery | Reads task `grimoire.discover` / `grimoire.decompose` |
| `classifyText()` | `src/classify.ts` | REST text classification | Reads task `grimoire.classify-text` |
| Moodboard analysis | `src/routes/moodboard-analysis.ts`, `src/vision-provider.ts` | Per-image IR + aggregate | Reads task `moodboard.aggregate` and vision tasks |

### Provider Routing

Workers AI calls use `env.AI.run()` (edge-native, no external HTTP). Think blocks (`<think>...</think>`) are stripped in `callWorkersAI()` for Nemotron/Qwen3.

Gemini fallback calls route through AI Gateway first, fall back to direct API on 401:
- Gateway: `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/hobfarm/google-ai-studio/...`
- Direct: `https://generativelanguage.googleapis.com/v1beta/models/...`
- Auth: `cf-aig-authorization: Bearer {AI_GATEWAY_TOKEN}` header on gateway calls

Workers AI calls use `env.AI.run()` (edge-native, no external HTTP).

### Circuit Breaker

Shared KV namespace PROVIDER_HEALTH. Key format: `provider:health:{provider}:{model}`.
Three failures in 5 minutes triggers 15-minute cooldown (900s TTL).
The `callWithFallback()` utility in the shared provider layer handles this automatically.

### Model Registry

All model strings and fallback chains should trace back to `HobBot/src/shared/models.ts`. If you find a model string hardcoded in a handler instead of pulled from the registry, that's a bug. Fix it.

## Embedding Configuration

| Setting | Value |
|---------|-------|
| Model | @cf/baai/bge-base-en-v1.5 |
| Dimensions | 768 |
| Vectorize index | grimoire-atoms |
| Atom namespace | collection_slug |
| Chunk namespace | type: 'document_chunk' filter |
| Batch size | Up to 100 texts per env.AI.run() call |
| Status tracking | embedding_status column on atoms (pending, processing, complete, failed) |
| Chunk tracking | None (fire-and-forget) |

Changing the embedding model requires re-vectorizing everything. Do not swap models without explicit approval.

## The Knowledge Layers

```
LAYER 5: Relations & Correspondences
        Connections between concepts across all layers.

LAYER 4: Vocabulary Index (atoms)
        Lookup entries for encountered concepts.
        Only created when incoming knowledge introduces concepts
        that don't match existing vocabulary. Grows slowly.

LAYER 3: Taxonomy & Arrangements
        Categories, collections, arrangement profiles.
        Arrangements carry harmonic score ranges for aesthetic matching.

LAYER 2: Enriched Chunks
        The searchable knowledge units. Content, summary,
        categories, arrangement tags, quality score, vocabulary links.
        This is what consumers actually use.

LAYER 1: Documents & Sources
        Raw knowledge. Essays, wiki pages, articles.
        Origin tracking. The archival layer.
```

Knowledge flows downward (documents become chunks). Indexing flows upward (chunks produce vocabulary entries only when new concepts appear). Relations flow laterally (correspondences link concepts across layers and documents).

### Harmonic Dimensions

Every atom carries six harmonic scores (0.0 to 1.0):

| Dimension | Low (0.0) | High (1.0) |
|-----------|-----------|------------|
| hardness | soft, organic, flowing | hard, geometric, rigid |
| temperature | cool, clinical, detached | warm, intimate, organic |
| weight | light, airy, minimal | heavy, dense, substantial |
| formality | casual, raw, spontaneous | formal, refined, structured |
| era_affinity | ancient, historical | contemporary, futuristic |
| register | vernacular, folk | academic, elevated |

## Database: GRIMOIRE_DB

Key table groups by layer:

**Layer 1:** documents, sources, source_atoms
**Layer 2:** document_chunks (content, summary, categories, arrangement_slugs, quality_score)
**Layer 3:** categories, category_relations, collections, arrangements, category_contexts
**Layer 4:** atoms (term, category_slug, description, harmonics, status, embedding_status, register, tag_version, last_enqueued_at)
**Layer 5:** atom_relations, correspondences
**Operational:** exemplars, incantations, incantation_slots, discovery_queue, validation_log, integrity_scans, usage_log, evolve_reports, provider_behaviors, ingest_log, agent_budgets

Query the database for the actual schema. This list may be incomplete.

## File Structure

Verify against actual directory before assuming.

```
workers/grimoire/
  migrations/             # 0001-0033+, owned by this worker
  src/
    index.ts              # Hono router, scheduled() handler, queue dispatcher
    cron.ts               # scanAndEnqueue: 7 phases (1-6, 8) + Manifest Builder trigger
    types.ts              # All type definitions
    classify.ts           # classifyText() REST endpoint
    atom-classify.ts      # classifyAtom(), classifyRegister()
    suggest.ts            # discoverAtom(), decomposeAtom()
    vectorize.ts          # Embedding generation + semantic search
    reranker.ts           # Cross-encoder reranking
    atoms.ts              # CRUD for atoms; createAtomWithHooks/bulkInsertAtomsWithHooks/encounterAtomWithHooks (Phase 8 enqueue points)
    collections.ts        # CRUD for collections
    db.ts                 # Category queries, context lookups
    cache.ts              # Classification cache management
    routing.ts            # StyleFusion routing configuration
    knowledge.ts          # Knowledge sub-app (Hono)
    admin.ts              # Admin sub-app (Hono)
    manifests.ts          # Manifest Builder: loadFullGraph, buildManifest, buildAllManifests, gzip + R2 write
    routes/               # Sub-app modules (atoms, classify, dimension, ingest, manifests, moodboard, moodboard-analysis, routing, search, taxonomy)
    state/                # SQL state files (e.g. moodboards.ts)
    prompts/              # Prompt templates extracted from handlers
    invoke.ts             # Service binding RPC handler
    resolve.ts            # POST /api/v1/resolve phrase-to-atom resolver
    dimension-resolver.ts # Center-of-mass + dimensional pole resolution
    queue-consumers.ts    # handleClassifyBatch, handleVectorizeBatch, handleEnrichBatch, handleDlqBatch
    workflows.ts          # BulkRetagWorkflow, BulkCorrespondencesWorkflow (rowid-cursor pattern)
    connectivity.ts       # Phase 8 Connectivity Agent: KV queue, watermark sweep, three scorers
    daily-review.ts       # Daily review markdown generator (writes to R2)
    quality-gate.ts       # Atom promotion provisional -> confirmed
    arrangement-tagger.ts # tagAllAtoms(), safeParseJSON, scoring helpers
    content-router.ts     # routeContent()
    fromImage.ts          # Image extraction pipeline (Gemini Vision)
    fromImage-review.ts   # Image extraction candidate review/promotion
    vision-provider.ts    # Vision model dispatch
    r2-analysis.ts        # R2-stored analysis docs
    wildcard-bootstrap.ts # Wildcard tag/correspondence bootstrap
    migration.ts          # buildFilterQuery, migrateAtoms, rejectAtoms (atom migration utility)
    models.ts             # buildModelContext()
    provider.ts           # Provider abstraction wrapper
    circuit-breaker.ts    # Circuit-breaker state types
  wrangler.toml
  CLAUDE.md               # This file
```

Files are kept under 500 lines per repo convention. Split when approaching the limit.

Shared code imported from `HobBot/src/shared/` via tsconfig paths:
- providers/gemini.ts (GeminiProvider)
- providers/workers-ai.ts (WorkersAIProvider)
- providers/index.ts (getProvider factory)
- models.ts (model registry, task-to-model mapping)
- immune.ts (AI duplicate detection)

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings match this doc
3. If touching AI calls, read HobBot/src/shared/models.ts and HobBot/src/shared/providers/
4. If touching database, query GRIMOIRE_DB schema directly
5. If the task involves model strings, verify they exist in the shared registry

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- When you see unrecognized files or uncommitted changes, leave them alone
- File references in output must be repo-root relative (e.g. workers/grimoire/src/vectorize.ts)

### D1 Query Performance

Every query that runs on a cron path (scanAndEnqueue, retention, daily review) executes 96 times/day at the 15-minute interval. At current atom-table size, a single full table scan per tick compounds to tens of millions of row-reads per day. A scan-on-cron-path was the root cause of a $35+ D1 billing spike in April 2026.

**Before deploying any new or modified D1 query on a cron path:**
1. Run `EXPLAIN QUERY PLAN` on the query against the remote database
2. Confirm the output shows `SEARCH ... USING INDEX`, not `SCAN TABLE`
3. If it scans, create an appropriate index before deploying

**OR conditions on different columns** (e.g., `WHERE atom_a_id = ? OR atom_b_id = ?`) defeat SQLite's optimizer. Split into two separate subqueries, each hitting its own index.

Key indexes that must not be dropped (see grimoire-db for full list):
- `idx_atoms_embedding_status` / `idx_atoms_embedding_cat`: cron Phase 2, Phase 6
- `idx_atoms_register`: cron Phase 5
- `idx_chunks_embedding_status` / `idx_chunks_summary`: chunk vectorization and enrichment
- `idx_corr_a_provenance` / `idx_corr_b_provenance`: Phase 6 correspondence discovery (covering composites that replaced the OR scan)
- `idx_integrity_scans_created`: retention cleanup
- Partial index on atoms for Phase 3 harmonics enrichment (`WHERE harmonics IS NULL`)
- `idx_atom_tags_atom_id`, `idx_dimension_memberships_atom_id`: Connectivity Agent + Manifest Builder reads

### Code Rules

- All model strings from the shared registry (HobBot/src/shared/models.ts), never hardcoded
- All AI calls through the shared provider abstraction (getProvider, callWithFallback), never raw env.AI.run() or raw fetch()
- New AI call sites must have a fallback chain. No single-provider calls without a fallback.
- Strip `<think>...</think>` blocks from any model that produces them (Qwen3, DeepSeek) before JSON parsing
- JSON mode responses: always try/catch the parse, retry with stricter prompt on failure
- Named constants for batch sizes, retry counts, delay timers, depth limits, token limits. No magic numbers.
- Prompt text in dedicated template constants or files, not inline in handler functions
- Files under 500 lines. Split when approaching the limit.
- Queue message types must be defined in types.ts

### What NOT To Do

- Do not insert atoms directly to "seed" the Grimoire. Submit knowledge through HobBot's ingest pipeline.
- Do not bypass `createAtomWithHooks` / `bulkInsertAtomsWithHooks` / `encounterAtomWithHooks` — they're the Phase 8 enqueue points. New atoms inserted by other paths won't get Connectivity-Agent processing.
- Do not treat atom count as a quality metric
- Do not write to GRIMOIRE_DB from any other worker (except grimoire-classifier, which shares the D1 binding)
- Do not reference specific counts in documentation or comments
- Do not change embedding models or vector dimensions without explicit approval
- Do not hardcode model version strings, category slugs, arrangement lists, or tag slugs. Query at runtime.
- Do not add Gemini-only call sites. New AI calls need a Workers AI primary with a different Workers AI model as fallback. Gemini only when Workers AI cannot do the task; document the justification.
- Do not bypass the circuit breaker by calling providers directly
- Do not modify queue batch sizes or concurrency without understanding downstream CPU budget impact
- Do not drop or rename D1 indexes without verifying no cron query depends on them (see D1 Query Performance section)
- Do not query composite-PK tables (`atom_tags`, `dimension_memberships`) with `WHERE atom_id > ?` cursor pagination — it skips rows. Use `rowid > ?` instead, see `BulkRetagWorkflow` and `manifests.ts` for the pattern.

## Build and Deploy

```bash
cd workers/grimoire
npm run build
npx wrangler deploy
npx wrangler d1 execute grimoire-db --remote --file=query.sql
```

Always --remote for D1 commands. Always build before deploy.

After deploying, verify queue consumers are active in the Cloudflare dashboard (Queues tab). If the MCP tool list in claude.ai is stale, reconnect the MCP client.

## Relationship to Other Workers

| Worker | Relationship | Communication |
|--------|-------------|---------------|
| hobbot-worker (gateway) | Routes MCP tools to pipeline; pipeline calls this worker | Indirect via service binding chain |
| hobbot-pipeline | Calls this worker for all knowledge graph writes and reads | Service binding RPC (invoke) |
| hobbot-custodian | No direct dependency (uses pipeline for ingestion) | Indirect |
| hobbot-chat | Reads GRIMOIRE_DB directly for Grimoire tool queries | Shared D1 read binding |
| hobbot-agent | Queries for atom curation in content pipeline | Service binding |
| grimoire-classifier | Reads/writes GRIMOIRE_DB directly for bulk classification | Shared D1 binding (exception to single-writer rule) |
