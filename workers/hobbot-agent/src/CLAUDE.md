# HobBot Agent Worker

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

Autonomous content agent for X (Twitter). Gathers trending signals, curates Grimoire knowledge, composes posts with AI-generated text and images, validates content safety, and publishes to X. Also serves an MCP endpoint for tool access.

This is a Durable Object worker using the Cloudflare Agents SDK. The stateless worker (server.ts) handles routing and secrets relay. The Durable Object (agent.ts, HobBotAgent class) holds persistent SQLite state, manages schedules, and runs the content pipeline.

## Architecture: Stateless Worker + Durable Object

```
Request → server.ts (stateless worker)
            ├── Resolves Secrets Store → caches to KV
            └── routeAgentRequest() → HobBotAgent DO
                                        ├── onStart(): init schema, resolve secrets, register schedules
                                        ├── onRequest(): HTTP routes (health, admin, MCP)
                                        └── scheduled callbacks: pipeline, signals, engagement
```

### Secrets Relay Pattern

Secrets Store bindings are RPC proxies inside Durable Objects and cannot be resolved directly. The stateless worker resolves them to plain strings and caches in KV (key: `_hobbot_resolved_secrets`, TTL: 24h). The DO reads from KV on startup via `resolveSecrets()`.

Strategy order in `resolveSecrets()`:
1. Try `.get()` directly on binding (works if binding supports RPC)
2. Fall back to KV cache (populated by stateless worker)
3. Throw if neither works ("Hit any HTTP endpoint first")

This means the first request after a cold start must hit the stateless worker before the DO can function. The agent's `onStart()` calls `resolveSecrets()`.

## Worker Bindings

Verify against `wrangler.toml` before making changes.

| Binding | Type | Purpose |
|---------|------|---------|
| HOBBOT | Durable Object | HobBotAgent class |
| AI | Workers AI | Image generation, tweet composition, content safety |
| CDN | R2 (hobfarm-cdn) | Generated image storage |
| PROVIDER_HEALTH | KV | Circuit breaker state + secrets relay cache |
| GRIMOIRE | Service binding | Grimoire worker (atom curation, search) |
| ANTHROPIC_API_KEY | Secrets Store | Anthropic API auth (compose fallback) |
| XAI_API_KEY | Secrets Store | Grok API auth (signals) |
| GEMINI_API_KEY | Secrets Store | Gemini API auth (classify) |
| AI_GATEWAY_TOKEN | Secrets Store | Cloudflare AI Gateway auth |
| X_CONSUMER_KEY | Secrets Store | X OAuth 1.0a |
| X_CONSUMER_SECRET | Secrets Store | X OAuth 1.0a |
| X_ACCESS_TOKEN | Secrets Store | X OAuth 1.0a |
| X_ACCESS_SECRET | Secrets Store | X OAuth 1.0a |

### Environment Variables

| Var | Purpose |
|-----|---------|
| ACCOUNT_ID | Cloudflare account for AI Gateway routing |
| GATEWAY_NAME | Gateway instance name ("hobfarm") |

## Schedules (Agent SDK, not wrangler crons)

Registered in `onStart()` via the Agents SDK scheduler. All times UTC.

| Cron | Callback | PT Time | Purpose |
|------|----------|---------|---------|
| 0 15 * * * | contentMorning | 8am | Content pipeline run |
| 0 20 * * * | contentAfternoon | 1pm | Content pipeline run |
| 0 2 * * * | contentEvening | 7pm | Content pipeline run |
| 0 13 * * * | gatherSignals | 6am | X trending signal analysis |
| 0 */4 * * * | updateEngagement | Every 4h | Engagement metrics polling |
| 0 17 * * 0 | reviewCalendar | Sun 10am | Calendar review/planning |

Schedules persist in the DO. Registration is idempotent (checks existing callbacks before adding).

## Durable Object SQLite Schema

State persists across requests in the DO's embedded SQLite.

| Table | Purpose | Key Fields |
|-------|---------|------------|
| calendar | Content schedule slots | id, scheduled_at, theme, arrangement_slug, narrative_thread, status |
| posts | Published content history | id, calendar_id, text, alt_text, image_url, image_provider, text_provider, atoms_used, x_post_id, engagement |
| threads | Narrative thread tracking | id, name, description, status, posts_count |
| signals | Trending signals from X | id, source, signal_type, data, relevance_score, expires_at |
| knowledge_cache | RAG result cache | query (PK), result, expires_at |

## HTTP Routes

All routes are handled in `HobBotAgent.onRequest()`. Path prefix is stripped by the Agents SDK routing.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /health, / | Health check |
| POST | /admin/trigger | Manual content pipeline run |
| GET | /admin/schedules | List registered schedules |
| POST | /admin/seed-calendar | Seed calendar with planned slots |
| POST | /admin/reseed-calendar | Clear planned slots and reseed |
| POST | /admin/pull-forward | Pull next 3 planned slots to now |
| GET | /admin/state | Full state dump (calendar, posts, threads, signals) |
| * | /mcp, /mcp/* | MCP server endpoint (see src/mcp/server.ts) |

## 7-Phase Content Pipeline

Executed by `runContentPipeline()` in `src/pipeline/`. Each phase produces structured output for the next.

| Phase | Function | Provider | Model | Purpose |
|-------|----------|----------|-------|---------|
| 1. Signal | gatherSignals() | xAI (Grok) | grok-4.1-fast | X trending analysis |
| 2. Knowledge | retrieveKnowledge() | CF AI Search | autorag binding | RAG knowledge retrieval |
| 3. Curate | curateAtoms() | Grimoire (svc binding) | N/A (DB lookup) | Top 20 atoms for context |
| 4. Compose | composePost() | Workers AI / Anthropic | llama-3.3-70b / claude-sonnet-4-6 | Tweet text generation |
| 5. Visualize | generateVisual() | Workers AI | flux-2-dev / flux-1-schnell / lucid-origin | Image generation |
| 6. Validate | validatePost() | Workers AI | llama-guard-3-8b | Content safety check |
| 7. Post | publishPost() | X API | N/A | OAuth 1.0a tweet + media upload |

### Pipeline Failure Behavior

- Signal phase: `onAllFail: 'skip'` (pipeline continues without signals)
- Validate phase: fail-open (returns safe=true if Llama Guard errors)
- Other phases: failure halts pipeline, returns partial result with phase status

## Model Registry (Local)

This worker has its **own** model registry at `src/models.ts`, separate from `HobBot/src/shared/models.ts`. Five task types:

| Task | Primary | Fallbacks | Notes |
|------|---------|-----------|-------|
| compose | Workers AI: llama-3.3-70b-instruct-fp8-fast | Anthropic: claude-sonnet-4-6 | JSON mode on primary |
| signal | xAI: grok-4.1-fast | none | onAllFail: skip |
| validate | Workers AI: llama-guard-3-8b | inline rules-only | Fail-open |
| classify | Gemini: gemini-3.1-flash-lite-preview | Workers AI: llama-3.1-8b-instruct | thinkingBudget: 0 |
| visualize | Workers AI: flux-2-dev | flux-1-schnell, lucid-origin | All Workers AI |

### Provider Routing

External API calls route through AI Gateway with direct fallback:
- Gateway: `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_NAME}/{provider_slug}/...`
- Direct fallback on 401
- Provider slugs: `anthropic`, `grok`, `google-ai-studio`

Workers AI calls use `env.AI.run()` (edge-native).

### Circuit Breaker

Shared KV namespace PROVIDER_HEALTH (same as other workers). Key format: `provider:health:{provider}:{model}`. Three failures in 5 minutes triggers 15-minute cooldown.

## X API Integration

| Endpoint | Purpose | Auth |
|----------|---------|------|
| POST https://api.x.com/2/tweets | Tweet posting | OAuth 1.0a HMAC-SHA1 |
| POST https://upload.twitter.com/1.1/media/upload.json | Media upload (INIT/APPEND/FINALIZE) | OAuth 1.0a HMAC-SHA1 |
| GET https://api.x.com/2/tweets/{id} | Engagement metrics | OAuth 1.0a |

Image upload flow: generate PNG → upload to R2 (`agents/hobbot/images/{timestamp}.png`) → upload to X media endpoint → attach media_id to tweet.

## Inline Validation Rules (Phase 6)

Applied alongside Llama Guard:
- Text length: 20-280 characters
- Banned phrases: "as an ai", "i cannot", "here's a", etc. (14 phrases)
- Max 2 hashtags
- No em dashes
- Alt text required (min 10 chars)

## Known Issues and Tech Debt

**Separate model registry.** This worker has `src/models.ts` independent from `HobBot/src/shared/models.ts`. The two registries have different schemas (this one uses `TaskType`/`TaskConfig` from local `providers/types.ts`). Model changes must be synced manually between the two. Consider migrating to the shared registry.

**Secrets relay via KV.** The KV-based secrets cache works but has a cold-start race: the DO can fail to start if no HTTP request has hit the stateless worker to populate secrets. The 24h TTL means secrets go stale daily. Also, PROVIDER_HEALTH KV is dual-purposed (circuit breaker + secrets relay), which is messy.

**No wrangler cron triggers.** All scheduling is through the Agents SDK. If the DO resets or loses state, schedules need to be re-registered on the next `onStart()`. The idempotent registration handles this, but there's no external trigger to ensure the DO wakes up.

**classify task references gemini-3.1-flash-lite-preview.** This is a preview model string that may not exist long-term. Other workers use gemini-2.5-flash-lite. Verify the model is still available.

**FLUX-2 Dev multipart FormData.** The primary image generation model requires multipart FormData (not JSON params), while the fallbacks use JSON. The provider abstraction must handle both formats.

## File Structure

```
workers/hobbot-agent/
  src/
    server.ts             # Stateless worker: routing + secrets relay
    agent.ts              # HobBotAgent Durable Object class
    env.ts                # Env interface, secrets resolution, SECRET_KEYS
    schema.ts             # SQLite schema initialization
    models.ts             # Local model registry (5 task types)
    providers/            # Provider implementations + types
    pipeline/             # Content pipeline phases
      signal.ts           # gatherSignals()
      ...                 # Other pipeline phases
    scheduling/
      engagement.ts       # updateEngagement()
      calendar.ts         # reviewCalendar(), seedCalendar()
    mcp/
      server.ts           # MCP server factory
  wrangler.toml
  CLAUDE.md               # This file
```

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings
3. If touching models, read src/models.ts AND HobBot/src/shared/models.ts (they're separate)
4. If touching the pipeline, understand the 7-phase dependency chain
5. If touching secrets, understand the stateless-worker-to-DO relay pattern
6. If touching schedules, check existing schedules via /admin/schedules before modifying

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- File references must be repo-root relative (e.g. workers/hobbot-agent/src/agent.ts)

### Code Rules

- Model strings in src/models.ts registry, not hardcoded in pipeline phases
- All external AI calls through the local provider abstraction (src/providers/)
- Workers AI calls through env.AI.run() via the provider layer
- New pipeline phases must follow the existing structured output pattern
- SQLite schema changes go in schema.ts using CREATE TABLE IF NOT EXISTS
- X API calls must use OAuth 1.0a HMAC-SHA1 signing
- Image uploads to R2 use the path pattern `agents/hobbot/images/{timestamp}.png`

### What NOT To Do

- Do not add wrangler cron triggers. This worker uses Agent SDK schedules exclusively.
- Do not access Secrets Store bindings directly in the DO. Use this.secrets (resolved via KV relay).
- Do not write to GRIMOIRE_DB. Access Grimoire through the GRIMOIRE service binding.
- Do not dual-purpose PROVIDER_HEALTH KV for anything beyond circuit breaker state and secrets relay.
- Do not remove the fail-open behavior on validation without explicit approval.
- Do not change X API OAuth credentials or signing logic without testing against the live API.

## Build and Deploy

```bash
cd workers/hobbot-agent
npm run build
npx wrangler deploy
```

After deploying, hit any endpoint (e.g. /health) to trigger secrets relay from stateless worker to DO. Verify schedules are registered via /admin/schedules.

## Relationship to Other Workers

| Worker | Relationship | Communication |
|--------|-------------|---------------|
| grimoire | Queries atoms for content curation | Service binding (GRIMOIRE) |
| hobbot-worker (gateway) | No direct relationship. This worker runs independently. | None |
| hobbot-pipeline | No direct relationship | None |
| hobbot-chat | No direct relationship | None |
| hobbot-custodian | No direct relationship | None |
