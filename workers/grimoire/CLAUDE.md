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
| AI | Workers AI | Embeddings, reranking, classification fallback |
| VECTORIZE | Vectorize (grimoire-atoms) | Semantic search index (768-dim) |
| PROVIDER_HEALTH | KV | Circuit breaker state (shared across workers) |
| GEMINI_API_KEY | Secrets Store | Gemini API auth |
| AI_GATEWAY_TOKEN | Secrets Store | Cloudflare AI Gateway auth |
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

Runs every 15 minutes. Scans D1 for unprocessed atoms and dispatches to queues. Six phases, each with a 30-minute re-enqueue guard (`last_enqueued_at` check) to prevent duplicate processing.

| Phase | What It Finds | Queue Target | Limit |
|-------|--------------|--------------|-------|
| 1 | Unclassified atoms (no category_slug) | grimoire-classify | 200 |
| 2 | Pending embeddings (embedding_status='pending') | grimoire-vectorize | 100 |
| 3 | Missing harmonics (empty or null) | grimoire-classify (enrich-harmonics) | 10 |
| 4 | Stale arrangement tags (tag_version < current) | grimoire-enrich (tag-arrangements) | 50 |
| 5 | Missing register classification | grimoire-classify (classify-register) | 10 |
| 6 | Atoms with no semantic correspondences | grimoire-enrich (discover-correspondences) | 200 |

Queue sendBatch max is 100 messages. Phase 1 and 6 chunk into batches of 100.

All cron phase queries depend on D1 indexes for performance. See "D1 Query Performance" under Rules for CC before modifying any phase query.

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

| POST | /admin/tag-arrangements | Bulk arrangement tagging (one-shot) |
| * | /admin/* | Admin sub-app (see src/admin.ts) |
| * | /knowledge/* | Knowledge sub-app (see src/knowledge.ts) |

### Service Binding RPC (invoke)

The `invoke()` function handles typed RPC calls from other workers via service binding. See `src/invoke.ts` for the full action list.

## AI Call Sites

Every AI call in this worker. If you add, remove, or change a model, update this section.

| Function | File | Task | Primary Model | Fallback Chain | Context |
|----------|------|------|--------------|----------------|---------|
| vectorizeAtomBatch() | src/vectorize.ts | Embedding generation | @cf/baai/bge-base-en-v1.5 | none | ~100 texts/batch |
| vectorizeChunkBatch() | src/vectorize.ts | Chunk embeddings | @cf/baai/bge-base-en-v1.5 | none | ~100 texts/batch |
| searchAtoms() | src/vectorize.ts | Query embedding | @cf/baai/bge-base-en-v1.5 | none | 1 query |
| searchDocumentChunks() | src/vectorize.ts | Query embedding | @cf/baai/bge-base-en-v1.5 | none | 1 query |
| rerankCandidates() | src/reranker.ts | Cross-encoder rerank | @cf/baai/bge-reranker-base | none | query + candidates |
| classifyAtom() | src/atom-classify.ts | Category + harmonics | @cf/nvidia/nemotron-3-120b-a12b | gemini-2.5-flash-lite, gemini-2.5-flash | ~600 tok |
| classifyRegister() | src/atom-classify.ts | Register scoring | @cf/ibm-granite/granite-4.0-h-micro | gemini-2.5-flash-lite, gemini-2.5-flash | ~400 tok |
| discoverAtom() | src/suggest.ts | New term discovery | @cf/nvidia/nemotron-3-120b-a12b | gemini-2.5-flash, qwen3-30b | ~500 tok |
| decomposeAtom() | src/suggest.ts | Concept decomposition | @cf/nvidia/nemotron-3-120b-a12b | gemini-2.5-flash, qwen3-30b | ~600 tok |
| classifyText() | src/classify.ts | Text classification | @cf/qwen/qwen3-30b-a3b-fp8 | gemini-2.5-flash (gateway, direct) | ~500 tok |

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
  src/
    index.ts              # Hono router, scanAndEnqueue cron, queue dispatcher
    types.ts              # All type definitions
    classify.ts           # classifyText() REST endpoint
    atom-classify.ts      # classifyAtom(), classifyRegister()
    suggest.ts            # discoverAtom(), decomposeAtom()
    vectorize.ts          # Embedding generation + semantic search
    reranker.ts           # Cross-encoder reranking
    atoms.ts              # CRUD for atoms
    collections.ts        # CRUD for collections
    db.ts                 # Category queries, context lookups
    cache.ts              # Classification cache management
    routing.ts            # StyleFusion routing configuration
    knowledge.ts          # Knowledge sub-app (Hono)
    admin.ts              # Admin sub-app (Hono)
    invoke.ts             # Service binding RPC handler
    queue-consumers.ts    # handleClassifyBatch, handleVectorizeBatch, handleEnrichBatch, handleDlqBatch
    workflows.ts          # BulkRetagWorkflow, BulkCorrespondencesWorkflow
    arrangement-tagger.ts # tagAllAtoms()
    content-router.ts     # routeContent()
    models.ts             # buildModelContext()
  wrangler.toml
  CLAUDE.md               # This file
```

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

Every query that runs on a cron path (scanAndEnqueue, retention, daily review) executes 96 times/day at the 15-minute interval. A single full table scan on the atoms table (178K rows) costs ~600K row reads per tick, compounding to ~57M rows/day. This was the root cause of a $35+ D1 billing spike in April 2026.

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
- Do not treat atom count as a quality metric
- Do not write to GRIMOIRE_DB from any other worker (except grimoire-classifier, which shares the D1 binding)
- Do not reference specific counts in documentation or comments
- Do not change embedding models or vector dimensions without explicit approval
- Do not hardcode model version strings, provider URLs, or API keys
- Do not add Gemini-only call sites. New AI calls need a Workers AI primary with Gemini as fallback.
- Do not bypass the circuit breaker by calling providers directly
- Do not modify queue batch sizes or concurrency without understanding downstream CPU budget impact
- Do not drop or rename D1 indexes without verifying no cron query depends on them (see D1 Query Performance section)

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
