# HobBot Pipeline Worker

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

All AI-heavy, long-running operations in the HobBot swarm: knowledge ingestion (URL, text, image, PDF, RSS feed entries), blog content generation, chunk enrichment, and StyleFusion outcome processing. The gateway (hobbot-worker) delegates to this worker via typed RPC (WorkerEntrypoint).

This is the most AI-intensive worker in the swarm: 8 AI call sites across 5 providers (Gemini, Workers AI Qwen3, Workers AI Granite, Workers AI BGE embeddings, Workers AI toMarkdown). It also has the self-chaining enrichment pattern for processing large backlogs without hitting D1 CPU limits.

## Worker Bindings

Verify against `wrangler.toml` before making changes.

| Binding | Type | Purpose |
|---------|------|---------|
| GRIMOIRE_DB | D1 (grimoire-db) | Read-write. Sources, documents, chunks, atoms, relations. |
| HOBBOT_DB | D1 (hobbot-db) | Read-write. Blog posts, feed entries, session ledger. |
| R2 | R2 (hobfarm-cdn) | Image uploads for ingest and blog |
| AI | Workers AI | Text generation, embeddings, PDF extraction |
| GEMINI_API_KEY | Secrets Store | Gemini API auth (enrichment agents, image analysis, blog compose) |
| PROVIDER_HEALTH | KV | Circuit breaker state (shared across workers) |
| GRIMOIRE | Service binding | Grimoire worker (search, taxonomy, classify) |
| GITHUB_TOKEN | Wrangler secret | GitHub API token for blog publish (NOT Secrets Store) |

### Environment Variables

| Var | Value | Purpose |
|-----|-------|---------|
| ENVIRONMENT | "development" | Environment flag (note: set to development, not production) |
| STYLEFUSION_URL | "https://sf.hob.farm" | StyleFusion endpoint for outcome export |
| SELF_URL | "https://hobbot-pipeline.damp-violet-bf89.workers.dev" | Self-referencing URL for enrichment chaining |
| INTERNAL_SECRET | "enrich-chain-2026" | Auth token for internal enrichment continuation endpoint |

## Cron Schedules

| Cron | Schedule | What Runs |
|------|----------|-----------|
| `0 */6 * * *` | Every 6 hours | 3 concurrent tasks: chunk enrichment + SF outcome processing + RSS ingest queue |
| `0 5 * * *` | Daily 5am UTC | Blog bridge: scan Grimoire for blog-worthy topics, queue candidates |
| `0 8 * * *` | Daily 8am UTC | Blog compose: pick queued candidate, compose + validate + draft |

### 6-Hour Cron Detail

Three independent `ctx.waitUntil()` tasks, each with its own error handling:

1. **Chunk enrichment** (`enrichChunksBatched`): summaries, categories, arrangement_slugs, quality scores. Self-chains via /internal/enrich-continue for large backlogs.
2. **StyleFusion outcomes** (`processStyleFusionOutcomes`): export SF generation results to Grimoire
3. **RSS ingest queue** (`processRssIngestQueue`): process pending feed_entries written by custodian

## HTTP Endpoints

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | /internal/enrich-continue | x-internal-secret header | Self-chaining enrichment continuation |
| GET | / | none | Health check |

The `/internal/enrich-continue` endpoint is called by the worker itself via `ctx.waitUntil(fetch(SELF_URL + '/internal/enrich-continue'))` to chain enrichment batches with fresh CPU budgets. Accepts `depth` and `total` query params. Max depth 20, 10 chunks per invocation, 6s delay between chunks.

## RPC Surface: PipelineEntrypoint

Gateway delegates these methods via Service Binding RPC:

| Method | Purpose |
|--------|---------|
| ingestFromUrl(params) | Fetch URL, normalize via adapter, run full knowledge pipeline |
| ingestFromText(params) | Accept raw text, run full knowledge pipeline |
| ingestBatch(params) | Process up to 10 URLs sequentially with 1s spacing |
| ingestFromImage(params) | Analyze image via Gemini vision, store to R2, run knowledge pipeline |
| ingestFromPdf(params) | Extract PDF via env.AI.toMarkdown(), run knowledge pipeline |
| classifyImage(params) | Analyze image without ingesting (returns classification only) |
| runBlogPipeline(channel?) | Compose, validate, and draft a blog post |
| runBridge() | Scan Grimoire for blog-worthy knowledge, queue candidates |
| publishDraft(id) | Promote a draft blog post to GitHub via API |

## Adapter Pattern

Five input adapters normalize content into `NormalizedDocument`:

| Adapter | File | Input | AI Used |
|---------|------|-------|---------|
| fromUrl | src/adapters/from-url.ts | URL fetch, content extraction, dedup | None (parsing only) |
| fromText | src/adapters/from-text.ts | Raw text/title/source_type | None (passthrough) |
| fromImage | src/adapters/from-image.ts | Base64 image, Gemini vision analysis, R2 upload | Gemini (vision) |
| fromPdf | src/adapters/from-pdf.ts | PDF blob, env.AI.toMarkdown() extraction | Workers AI (toMarkdown) |
| fromFeedEntry | src/adapters/from-feed-entry.ts | RSS feed row, delegates to fromUrl or fromPdf | Depends on delegate |

After normalization, the orchestrator (`pipeline/run.ts`) runs shared pipeline stages:

```
chunk → extract → match → index → relate → vectorize
```

- **chunk**: Create source + document + chunk rows in GRIMOIRE_DB
- **extract**: Per-chunk enrichment + concept extraction via AI agents
- **match**: Match concepts against existing vocabulary (exact → FTS5 → AI disambiguation)
- **index**: Create new atoms for unmatched concepts
- **relate**: Build correspondences between concepts
- **vectorize**: Enqueue chunks for embedding generation

Arrangement aggregation runs after extraction to score the source against arrangement profiles.

## AI Call Sites

| Function | File | Task | Primary Model | Fallback | Context |
|----------|------|------|--------------|----------|---------|
| analyzeImage() | src/services/image-analysis.ts | Image analysis (vision) | @cf/meta/llama-4-scout-17b-16e-instruct | gemini-2.5-flash, gemini-2.5-flash-lite | ~1500 tok |
| enrichChunksBatched() | src/services/chunk-enrichment.ts | Chunk enrichment (cron) | @cf/qwen/qwen3-30b-a3b-fp8 | gemini-2.5-flash | ~1300 tok/chunk |
| runEnrichmentAgent() | src/pipeline/agents/enrichment.ts | Pipeline chunk enrichment | @cf/qwen/qwen3-30b-a3b-fp8 | gemini-2.5-flash | ~1300 tok/chunk |
| runVocabularyMatchAgent() | src/pipeline/agents/vocabulary-match.ts | Concept disambiguation | @cf/ibm-granite/granite-4.0-h-micro | gemini-2.5-flash | ~700 tok/batch |
| runIndexingAgent() | src/pipeline/agents/indexing.ts | New vocabulary creation | @cf/qwen/qwen3-30b-a3b-fp8 | gemini-2.5-flash | ~1000 tok/batch |
| runCorrespondenceAgent() | src/pipeline/agents/correspondence.ts | Semantic relation ID | @cf/ibm-granite/granite-4.0-h-micro | gemini-2.5-flash | ~1100 tok/batch |
| composePost() | src/blog/compose.ts | Blog post generation | @cf/nvidia/nemotron-3-120b-a12b | gemini-2.5-flash | ~2000 tok |
| fromPdf() | src/adapters/from-pdf.ts | PDF to markdown | Workers AI (toMarkdown) | none | N/A |

### Provider Pattern

All text-based AI call sites use **Workers AI primary, Gemini fallback** via `callWithJsonParse()` from `pipeline/agents/types.ts`. This includes pipeline agents (enrichment, vocabulary-match, indexing, correspondence), the cron chunk enrichment safety net, and blog composition.

`analyzeImage` is the exception: it uses raw Gemini API fetch with `inline_data` multipart format for vision. Workers AI vision integration deferred to Brief 6B. It has a Gemini model fallback chain (flash -> flash-lite).

Both enrichment paths (inline pipeline and cron safety net) now share the same model config (`pipeline.enrichment`), prompt (`buildEnrichmentPrompt`), and output schema (summary, category_slug, arrangement_slugs, quality_score, key_concepts).

### Special: Qwen3 Think Block Stripping

Qwen3-30b produces `<think>...</think>` blocks before JSON output. The `callWithJsonParse()` utility strips these automatically via `extractJson()`. Any new call site using Qwen3 must go through this utility.

### Circuit Breaker

Shared KV namespace PROVIDER_HEALTH. Used by pipeline agents via `callWithFallback()`. The `callWithJsonParse()` utility does not directly use the circuit breaker but gets implicit protection through the retry+fallback chain.

## Self-Chaining Enrichment Pattern

For processing large chunk backlogs without hitting D1 CPU limits:

1. Cron triggers `enrichChunksBatched(env, ctx, depth=0, total=0)`
2. Processes 10 chunks per invocation with 6s delay between
3. If more chunks remain, calls `ctx.waitUntil(fetch(SELF_URL + '/internal/enrich-continue?depth=N&total=M'))` with INTERNAL_SECRET auth
4. New Worker invocation gets fresh CPU budget
5. Max depth: 20 (prevents infinite chaining)

This pattern resolves the structural D1 CPU limit bottleneck on large document ingestions.

## Blog Pipeline

Lives in `src/blog/` with multi-stage flow:

| File | Purpose |
|------|---------|
| bridge.ts | Scan Grimoire for blog candidates, queue them |
| source.ts | Gather knowledge context for a topic |
| compose.ts | Draft post via Gemini (temp 0.8, creative) |
| enrich.ts | Add metadata, tags, arrangement links |
| validate.ts | Content quality checks |
| draft.ts | Write draft to HOBBOT_DB |
| publish.ts | Promote draft to GitHub (hobfarm repo) via API |
| character.ts | Blog voice/tone configuration (BLOG_CHARACTER_BRIEF) |

## Known Issues and Tech Debt

**Enrichment code paths remain separate but aligned.** enrichChunksBatched (cron) and runEnrichmentAgent (pipeline) share the same model, prompt, and output schema via callWithJsonParse, but maintain separate orchestration logic due to the self-chaining pattern. The cron path passes empty string for chunk heading (DB doesn't store it).

**INTERNAL_SECRET is a plaintext env var.** The self-chaining auth token is in wrangler.toml as a var, not a secret. Anyone who can read wrangler.toml has the token. Should be a wrangler secret or Secrets Store binding.

**ENVIRONMENT set to "development".** Same as hobbot-custodian. Verify whether this is intentional or a deploy oversight.

**GITHUB_TOKEN is a wrangler secret, not Secrets Store.** Different pattern from every other secret in the swarm. Works fine but inconsistent.

**`env as any` casts in blog pipeline calls.** `runBlogPipeline(env as any)` and `runBridge(env as any)` in the scheduled handler indicate a type mismatch between the pipeline Env and what the blog modules expect. Should be resolved with proper typing.

## File Structure

```
workers/hobbot-pipeline/
  src/
    index.ts              # PipelineEntrypoint RPC + scheduled handler + /internal/enrich-continue
    adapters/
      from-url.ts         # URL fetch, content extraction, dedup
      from-text.ts        # Raw text passthrough
      from-image.ts       # Gemini vision analysis, R2 upload
      from-pdf.ts         # env.AI.toMarkdown() extraction
      from-feed-entry.ts  # RSS feed row, delegates to fromUrl or fromPdf
    pipeline/
      run.ts              # Orchestrator: chunk → extract → match → index → relate → vectorize
      agents/
        enrichment.ts     # Chunk summary, categories, quality (Qwen3 primary, Gemini fallback)
        vocabulary-match.ts # Concept matching (Granite primary, Gemini fallback)
        indexing.ts        # New atom creation (Qwen3 primary, Gemini fallback)
        correspondence.ts  # Relation building (Granite primary, Gemini fallback)
        embedding.ts       # Embedding enqueue (posts to grimoire worker)
        types.ts           # AgentContext type
    services/
      image-analysis.ts   # analyzeImage() - Gemini vision
      chunk-enrichment.ts # enrichChunksBatched() - Gemini, self-chaining
      rss-ingest-queue.ts # processRssIngestQueue()
      sf-outcome.ts       # processStyleFusionOutcomes()
    blog/
      pipeline.ts         # runBlogPipeline()
      bridge.ts           # runBridge()
      source.ts           # Knowledge context gathering
      compose.ts          # Post composition (Gemini)
      enrich.ts           # Metadata enrichment
      validate.ts         # Quality checks
      draft.ts            # Write to HOBBOT_DB
      publish.ts          # GitHub API publish
      character.ts        # Voice/tone config
      types.ts            # BlogChannel, etc.
  wrangler.toml
  CLAUDE.md               # This file
```

Shared code imported via `@shared/*` tsconfig path alias:
- providers/gemini.ts, providers/workers-ai.ts, providers/index.ts (shared provider layer)
- models.ts (shared model registry)
- grimoire/handle.ts (GrimoireHandle for D1 operations)
- rpc/pipeline-types.ts (NormalizedDocument, PipelineResult, param types)
- state/ modules (documents, sources, ingest-log, discovery)
- ledger.ts (session logging)
- config.ts (constants)

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings
3. If touching pipeline agents, read HobBot/src/shared/providers/ and HobBot/src/shared/models.ts
4. If touching adapters, understand the NormalizedDocument contract in @shared/rpc/pipeline-types.ts
5. If touching the self-chaining enrichment, understand the depth counter and CPU budget pattern
6. If touching blog publish, verify GITHUB_TOKEN resolution (wrangler secret, not Secrets Store)

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- File references must be repo-root relative (e.g. workers/hobbot-pipeline/src/pipeline/agents/enrichment.ts)

### Code Rules

- Pipeline agents must use the shared provider abstraction (getProvider, callWithFallback)
- New AI call sites must have Workers AI primary with Gemini fallback
- Strip `<think>...</think>` blocks from Qwen3/DeepSeek responses before JSON parsing
- JSON mode responses: try/catch parse, retry with stricter prompt on failure
- Named constants for batch sizes, retry counts, delay timers. No magic numbers.
- All adapters must produce NormalizedDocument. No shortcutting the contract.
- Self-chaining calls must include INTERNAL_SECRET header and respect max depth

### What NOT To Do

- Do not add MCP tools. The gateway owns MCP serving.
- Do not add HTTP API routes (except internal endpoints). User-facing routes go through the gateway.
- Do not write to GRIMOIRE_DB outside the pipeline stages. Use @shared/state/ modules through GrimoireHandle.
- Do not delete shared code in HobBot/src/. All swarm workers depend on @shared/*.
- Do not call AI providers with raw fetch() in pipeline agents. Use the shared provider layer.
- Do not hardcode model version strings. Use @shared/models.ts.
- Do not increase self-chaining max depth above 20 without understanding CPU budget implications.

## Build and Deploy

```bash
cd workers/hobbot-pipeline
npm run build
npx wrangler deploy
wrangler secret put GITHUB_TOKEN   # one-time setup
```

Always build before deploy. Always `--remote` for D1 commands.

Deploy order (children first, gateway last):
```
hobbot-chat → hobbot-custodian → hobbot-pipeline → hobbot-worker
```

## Relationship to Other Workers

| Worker | Relationship | Communication |
|--------|-------------|---------------|
| hobbot-worker (gateway) | Delegates all pipeline RPC (ingest, blog, classify) | WorkerEntrypoint RPC |
| grimoire | Calls for knowledge graph writes/reads, search, taxonomy | GRIMOIRE service binding + direct D1 |
| hobbot-custodian | Custodian writes feed_entries; this worker processes them | Decoupled via HOBBOT_DB |
| hobbot-chat | No direct relationship | None |
| hobbot-agent | No direct relationship | None |
| grimoire-classifier | No direct relationship | None |
