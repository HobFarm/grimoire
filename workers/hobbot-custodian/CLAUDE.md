# HobBot Custodian Worker

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

Background maintenance and knowledge acquisition for the HobBot swarm. Owns harvesters (RSS, Getty AAT, Wikidata), integrity scanning, evolve reports, correspondence building, discovery queue processing, the Conductor (gap analysis + knowledge request generation), and the Archive.org agent (PDF source discovery and queuing).

## Worker Bindings

Verify against `wrangler.toml` before making changes.

| Binding | Type | Purpose |
|---------|------|---------|
| GRIMOIRE_DB | D1 (grimoire-db) | Read-write. Integrity scans, atoms, correspondences. |
| HOBBOT_DB | D1 (hobbot-db) | Read-write. Sources, feed_entries, sync_runs, knowledge_requests. |
| PROVIDER_HEALTH | KV | Circuit breaker state (shared across workers) |
| GRIMOIRE | Service binding | Grimoire worker |
| SERVICE_TOKENS | Secrets Store | Service auth tokens |
| GEMINI_API_KEY | Secrets Store | Gemini API auth |

### Environment Variables

| Var | Value | Purpose |
|-----|-------|---------|
| ENVIRONMENT | "production" | Environment flag |

| Binding | Type | Purpose |
|---------|------|---------|
| AI | Workers AI | Primary provider for conductor + archive.org agent |

## Cron Schedules

| Cron | Schedule | What Runs |
|------|----------|-----------|
| `0 */6 * * *` | Every 6 hours | Integrity scan + RSS harvest + Conductor + Archive.org agent (4 concurrent ctx.waitUntil tasks) |
| `0 0 * * 1` | Monday midnight UTC | Weekly evolve report |
| `0 2 * * 1` | Monday 2am UTC | Getty AAT harvest (100 items) + correspondence building |
| `0 3 * * 3` | Wednesday 3am UTC | Wikidata harvest (50 items) + correspondence building |

### 6-Hour Cron Detail

The primary cron runs four independent tasks concurrently via `ctx.waitUntil()`. Each task catches its own errors (one failure does not block others):

1. **Integrity scan** (`runIntegrityScan`): drift detection, bulk import detection, circular relation detection, atom promotion, tier recalculation, discovery queue drain, maintenance cleanup
2. **RSS harvest** (`RssHarvester.harvest`, 50 items): poll feeds, score relevance, write to feed_entries
3. **Conductor** (`runConductor`): gap analysis, knowledge request generation, stale request release, completion detection
4. **Archive.org agent** (`runArchiveOrgAgent`): claim knowledge requests, search Internet Archive, score candidates, queue PDFs

## RPC Surface (CustodianEntrypoint)

Gateway delegates admin operations via `WorkerEntrypoint<Env>` RPC:

| Method | Purpose |
|--------|---------|
| harvest(sourceType, batchSize) | Run harvester: 'getty-aat', 'wikidata-visual-arts', 'rss-feeds' |
| buildCorrespondences(sourceId) | Build correspondence links for a source |
| processDiscovery() | Drain and resolve discovery queue |
| harvestHealth(collectionSlug) | Generate harvest health report for a collection |
| runConductor() | Manual conductor trigger |
| runAgent(agentName) | Run named agent ('archive-org') |
| listKnowledgeRequests(status?) | List knowledge requests, optionally filtered by status |

## AI Call Sites

| Function | File | Task | Primary Model | Fallback | Context |
|----------|------|------|--------------|----------|---------|
| generateSearchIntent() | src/conductor.ts | Gap to search intent | @cf/nvidia/nemotron-3-120b-a12b | gemini-2.5-flash | ~400 tok |
| generateSearchQueries() | src/agents/archive-org.ts | IA query generation | @cf/qwen/qwen3-30b-a3b-fp8 | gemini-2.5-flash | ~500 tok |
| scoreCandidate() | src/agents/archive-org.ts | Relevance scoring | @cf/ibm-granite/granite-4.0-h-micro | gemini-2.5-flash | ~300 tok |

### Provider Details

All three call sites use `callWithJsonParse()` from `src/ai.ts`, modeled on the pipeline agents' pattern. Workers AI is primary, Gemini is fallback.

- Workers AI primary calls use `env.AI.run()` (edge-native)
- Gemini fallback calls go direct (not through AI Gateway)
- All use JSON mode, low temperature (0.1-0.3)
- scoreCandidate runs up to 30 times per 6h cron cycle (3 requests x 10 candidates)
- Model strings live in `src/models.ts` (task-based registry)
- Three-attempt strategy per call: primary -> retry with stricter prompt -> Gemini fallback
- Think block stripping for Qwen3/Nemotron responses before JSON parsing

### Notes

- **No AI Gateway routing.** Gemini fallback goes direct, not through gateway. Gateway routing could be added via the shared GeminiProvider but is not a priority.
- **No circuit breaker.** PROVIDER_HEALTH KV is bound but not used by `callWithJsonParse` (reactive try/catch pattern, not proactive health checks). Matches the pipeline agents' pattern.

## Conductor

Gap analysis system that identifies thin areas in the Grimoire and generates knowledge acquisition requests.

Flow:
1. SQL query finds arrangement/category pairs with low atom coverage
2. AI translates gaps into search intents with target source agent (Nemotron primary, Gemini fallback)
3. Knowledge requests written to `knowledge_requests` table in HOBBOT_DB
4. Stale requests (claimed but not completed) are released
5. Completed requests (all feed_entries ingested) are marked done

Runs every 6 hours. Max 5 new requests per run.

## Archive.org Agent

Claims knowledge requests, searches Internet Archive, evaluates candidates, and queues PDFs for ingestion.

Flow:
1. Claims unclaimed knowledge requests from HOBBOT_DB
2. AI generates 2-3 search queries per request (Qwen3 primary, Gemini fallback)
3. Searches Internet Archive Advanced Search API
4. AI scores candidates for relevance 0.0-1.0 (Granite micro primary, Gemini fallback)
5. High-scoring candidates written to feed_entries with knowledge_request_id FK
6. Pipeline worker picks up pending feed_entries on its own cycle

### External Non-AI APIs

| Service | Endpoint | Schedule | Purpose |
|---------|----------|----------|---------|
| Getty AAT SPARQL | `http://vocab.getty.edu/sparql` | Mon 2am UTC | Art vocabulary harvesting |
| Wikidata SPARQL | `https://query.wikidata.org/sparql` | Wed 3am UTC | Visual arts entity harvesting |
| RSS/Atom feeds | Per-source URLs in HOBBOT_DB | Every 6h | Content feed polling |
| Internet Archive | `https://archive.org/advancedsearch.php` | Every 6h | PDF source discovery |
| Internet Archive | `https://archive.org/metadata/{id}/files` | Every 6h | PDF file metadata |

## RSS Decoupling Pattern

The custodian does NOT call pipeline RPC for ingestion. RSS is decoupled through the `feed_entries` table:

1. RSS harvester polls enabled feeds from `sources` table (HOBBOT_DB)
2. Each item scored for relevance against Grimoire vocabulary keywords
3. High-scoring items inserted into `feed_entries` with `ingested=0`, `extraction_status='pending'`
4. Pipeline worker picks up pending entries on its own cron cycle via `processRssIngestQueue`

Same pattern for Archive.org agent: candidates go into `feed_entries` with `knowledge_request_id` FK for completion tracking.

## Integrity Scan Stages

The 6-hour scan runs four isolated stages:

1. **Detection**: drift (stale categories, orphaned collections, arrangement mismatches, embedding gaps, orphaned correspondence refs, empty categories), bulk import patterns, circular relations
2. **Promotion**: atoms meeting all quality gates (classified + embedded + harmonics + arrangement-tagged) promoted from `provisional` to `confirmed`
3. **Discovery queue**: drain and resolve queued items
4. **Tier recalculation**: fix stale/null tier values on confirmed atoms based on exemplar and correspondence presence

Results saved to `integrity_scans` table via `saveScanResult`.

## File Structure

```
workers/hobbot-custodian/
  src/
    index.ts                  # CustodianEntrypoint RPC + scheduled handler
    integrity.ts              # runIntegrityScan, runEvolveReport
    maintenance.ts            # promoteQualifiedAtoms, recalculateTiers
    models.ts                 # CustodianTaskType, CUSTODIAN_MODELS registry
    ai.ts                     # callWithJsonParse, extractJson, resolveApiKey
    conductor.ts              # runConductor, generateSearchIntent
    agents/
      archive-org.ts          # runArchiveOrgAgent, generateSearchQueries, scoreCandidate
    harvesters/
      base.ts                 # Harvester interface, sync run helpers, sleep
      rss.ts                  # RSS/Atom polling, relevance scoring, feed_entries writes
      getty-aat.ts             # Getty AAT SPARQL harvester
      wikidata.ts             # Wikidata SPARQL harvester
    transforms/
      rss.ts                  # XML parsing for RSS/Atom feeds
      relevance.ts            # Keyword loading, item scoring, threshold calculation
      getty-aat.ts             # AAT response transforms
      wikidata.ts             # SPARQL result transforms
    pipeline/
      drift-detect.ts         # Category/collection/arrangement/embedding drift
      attack-patterns.ts      # Bulk import detection, circular relation detection
      cleanup.ts              # Maintenance cleanup
      correspondence-builder.ts  # Cross-source correspondence links
      harvest-health.ts       # Per-collection harvest health reports
    state/
      discovery-processor.ts  # Discovery queue drain and resolution
  wrangler.toml
  CLAUDE.md                   # This file
```

Shared code imported via `@shared/*` tsconfig path alias:
- `@shared/ledger` (logAction)
- `@shared/models` (TaskConfig, ModelEntry types)
- `@shared/providers/gemini` (GeminiProvider, used by ai.ts for fallback)
- `@shared/providers/workers-ai` (WorkersAIProvider, used by ai.ts for primary)
- `@shared/state/grimoire` (getAtomCounts, saveScanResult, getArrangements)
- `@shared/state/graph` (getCorrespondenceStats, getOrphanedAtoms)
- `@shared/grimoire/types` (IntegrityIssue)

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings match this doc
3. If touching AI calls (conductor, archive-org agent), read HobBot/src/shared/providers/ for the migration target pattern
4. If touching harvesters, understand the feed_entries decoupling (custodian writes metadata, pipeline does extraction)
5. If touching integrity scans, understand that stages are isolated (one failure must not block others)

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- File references must be repo-root relative (e.g. workers/hobbot-custodian/src/conductor.ts)

### Code Rules

- Harvesters must not call pipeline RPC. Use feed_entries table for handoff.
- Each ctx.waitUntil task must have its own try/catch. No shared error boundary.
- Integrity scan stages must remain isolated. One stage failing cannot block others.
- AI calls use callWithJsonParse() from src/ai.ts with the local CUSTODIAN_MODELS registry
- Model strings from src/models.ts, not hardcoded
- Gemini API key resolution: handle both string and Secrets Store binding formats (the Env type declares `string | { get: () => Promise<string> }`)

### What NOT To Do

- Do not call pipeline RPC for ingestion. Use feed_entries table.
- Do not add heavy processing that exceeds Worker CPU limits. Use ctx.waitUntil for concurrent work.
- Do not merge integrity scan stages into a single try/catch block.
- Do not claim this worker has no AI. It has 3 AI call sites (Workers AI primary, Gemini fallback).
- New AI calls must use callWithJsonParse() with a CUSTODIAN_MODELS entry. No direct provider instantiation in handlers.
- Do not bypass the feed_entries decoupling pattern for knowledge acquisition.

## Build and Deploy

```bash
cd workers/hobbot-custodian
npm run build
npx wrangler deploy
```

Always build before deploy. Always `--remote` for D1 commands.

Deploy order (children first, gateway last):
```
hobbot-chat → hobbot-custodian → hobbot-pipeline → hobbot-worker
```

## Relationship to Other Workers

| Worker | Relationship | Communication |
|--------|-------------|---------------|
| hobbot-worker (gateway) | Delegates admin RPC (harvest, conductor, agents) | WorkerEntrypoint RPC |
| hobbot-pipeline | Custodian writes feed_entries; pipeline picks them up for extraction | Decoupled via HOBBOT_DB (no direct call) |
| grimoire | Integrity scans read/write GRIMOIRE_DB; correspondence builder reads atoms | Direct D1 + GRIMOIRE service binding |
| hobbot-chat | No direct relationship | None |
| hobbot-agent | No direct relationship | None |
