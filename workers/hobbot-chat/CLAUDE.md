# HobBot Chat Worker

> CC: Read this file completely before starting any task.
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What This Worker Does

Chat backend for the Grimoire conversational interface at hob.farm/grimoire. Powered by Anthropic Claude with streaming SSE and an 8-tool Grimoire function calling loop. Authenticated via session cookies (anonymous UUID sessions, not Cloudflare Access).

No RPC entrypoint. Plain fetch handler, proxied from the gateway via `env.HOBBOT_CHAT.fetch(request)`.

## Worker Bindings

Verify against `wrangler.toml` before making changes.

| Binding | Type | Purpose |
|---------|------|---------|
| GRIMOIRE_DB | D1 (grimoire-db) | Read-only. Direct Grimoire queries for tool execution. |
| HOBBOT_DB | D1 (hobbot-db) | Read-write. Chat state: sessions, conversations, messages, feedback. |
| ANTHROPIC_API_KEY | Secrets Store | Anthropic API auth |
| MESSAGE_RATE_LIMIT | Rate Limit (namespace 1001) | 10 messages/min per key |
| SESSION_RATE_LIMIT | Rate Limit (namespace 1002) | 5 new sessions/min per key |

### Environment Variables

| Var | Value | Purpose |
|-----|-------|---------|
| ENVIRONMENT | "production" | Environment flag |

### Notable Missing Bindings

- **No AI binding.** Cannot use Workers AI models. All chat goes through Anthropic via HTTP.
- **No PROVIDER_HEALTH KV.** No circuit breaker. If Anthropic is down, requests fail.
- **No GRIMOIRE service binding.** GrimoireHandle queries D1 directly (intentional: avoids extra network hop for read-only tool execution).
- **No Gemini, no Grok, no R2.** Single-provider worker.

## Scheduled Tasks

| Schedule | Handler | Purpose |
|----------|---------|---------|
| Daily 4am UTC | purgeOldSessions() | Delete sessions, conversations, and messages older than 30 days |

Purge uses chunked deletes to stay within D1 CPU limits. Logs deleted counts for users, conversations, and messages.

## Authentication

**Session cookie auth**, not Cloudflare Access JWT.

- Anonymous identity via `grimoire_session` UUID cookie
- Identity stored as `{uuid}@session.hob.farm` in HOBBOT_DB users table
- No login required. Sessions created on first visit.
- Rate limiting per IP (message and session creation)
- Session quotas: 20 conversations per session, 100 messages per conversation, 4000 chars max per message

> **STALE DOCUMENTATION WARNING:** Earlier versions of this file referenced Cloudflare Access JWT auth
> (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, jwt-auth.ts). That auth model was removed. If you find
> references to JWT auth, CF Access, or JWKS in code or docs, they are dead code and should be cleaned up.

## HTTP Routes

All routes under `/api/chat/`. Proxied from hobbot-worker gateway.

| Method | Route | Purpose |
|--------|-------|---------|
| POST | /api/chat/conversations | Create new conversation |
| GET | /api/chat/conversations | List user's conversations |
| GET | /api/chat/conversations/:id | Get conversation with history |
| POST | /api/chat/conversations/:id/messages | Send message, receive SSE stream |
| POST | /api/chat/messages/:id/feedback | Submit thumbs up/down |

## AI Call Sites

| Function | File | Task | Model | Streaming | Function Calling | Context |
|----------|------|------|-------|-----------|-----------------|---------|
| callAnthropicStreaming() | src/services/chat.ts | Chat completion (1st turn) | claude-sonnet-4-20250514 | Yes (SSE) | Yes (8 tools) | ~1000-2000 tok |
| callAnthropicNonStreaming() | src/services/chat.ts | Tool-use iterations (2nd+) | claude-sonnet-4-20250514 | No | Yes (8 tools) | ~1000-2000 tok |

### Provider Details

- Endpoint: `https://api.anthropic.com/v1/messages`
- Auth: `x-api-key` header
- API version: `anthropic-version: 2023-06-01`
- Max tokens: 4096
- Tool-use loop: max 5 iterations; 1st iteration streaming, subsequent non-streaming

### SSE Event Types

| Event | Payload | Purpose |
|-------|---------|---------|
| token | `{ type: "token", text: "..." }` | Incremental text chunk |
| tool_call | `{ type: "tool_call", name: "...", input: {...} }` | Tool invocation started |
| tool_result | `{ type: "tool_result", name: "...", summary: "..." }` | Tool execution result |
| done | `{ type: "done", content: "...", grimoire_refs: [...] }` | Stream complete |
| error | `{ type: "error", message: "..." }` | Failure |

## Grimoire Tool Catalog

8 read-only tools available to Claude during chat:

| Tool | Purpose |
|------|---------|
| grimoire_search | Text search across atoms |
| grimoire_lookup | Exact term lookup |
| grimoire_recommend | Arrangement-aware recommendations |
| grimoire_correspondences | Correspondence graph traversal (depth 1-5) |
| grimoire_arrangements | List all arrangements |
| grimoire_categories | List all categories |
| grimoire_document_search | Search document chunks |
| grimoire_stats | Grimoire health stats |

Tool definitions in `src/chat/tool-catalog.ts`. Tool executors query GRIMOIRE_DB directly via GrimoireHandle (D1 SQL, no service binding hop).

Note: these duplicate MCP tool definitions from `HobBot/src/mcp/server.ts`. Unifying into a shared registry is flagged as future work.

## Rate Limiting

| Limiter | Scope | Limit | Period |
|---------|-------|-------|--------|
| MESSAGE_RATE_LIMIT | Per IP | 10 messages | 60s |
| SESSION_RATE_LIMIT | Per IP | 5 new sessions | 60s |

Additional application-level limits:
- 20 conversations per user session
- 100 messages per conversation
- 4000 characters max per message
- 40 messages history cap per conversation (truncation, not compaction)

## Database: HOBBOT_DB (Chat State)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| users | Session identities | id, email ({uuid}@session.hob.farm), role, display_name |
| conversations | Chat threads | id, user_id, title, created_at, updated_at |
| messages | Chat messages | id, conversation_id, role, content, provider, grimoire_refs (JSON) |
| feedback | User ratings | id, user_id, message_id, signal (1/-1), grimoire_refs (JSON) |

## Known Issues and Tech Debt

**No Workers AI option.** Every chat completion goes to Anthropic via external HTTP. This is the highest-cost, highest-latency call in the swarm. Adding Nemotron 3 120B or another Workers AI model as a primary (with Anthropic as fallback) would reduce cost and latency significantly, but requires validating function calling quality with the 8-tool catalog.

**No circuit breaker.** Missing PROVIDER_HEALTH KV binding. Anthropic outage = total chat failure with no graceful degradation.

**No fallback chain.** Single provider, no fallback. If Anthropic returns errors, the user gets an error. Every other worker in the swarm has fallback chains.

**Hard truncation instead of compaction.** History capped at 40 messages by simple truncation. Older messages are lost, not summarized. A compaction step (summarize older messages into a context block) would preserve more useful history within the same token budget.

**Hardcoded model string.** `claude-sonnet-4-20250514` appears in the service layer. Not pulled from the shared model registry. Will need updating when model versions change.

**No shared provider abstraction.** Uses raw `fetch()` to api.anthropic.com instead of the shared provider layer. Same pattern as grimoire-classifier: off the grid from the provider abstraction.

**Duplicate tool definitions.** Tool catalog in `src/chat/tool-catalog.ts` duplicates MCP tool definitions from `HobBot/src/mcp/server.ts`. Changes to tool behavior must be synced manually.

**Stale JWT auth references.** Any remaining references to CF Access JWT auth, JWKS, CF_ACCESS_TEAM_DOMAIN, or CF_ACCESS_AUD in code or docs are dead and should be removed.

**Observability partially configured.** Logs enabled with head_sampling_rate=1 and persistence, but top-level observability is disabled. Inconsistent.

## File Structure

```
workers/hobbot-chat/
  src/
    index.ts              # Fetch handler, scheduled handler, route dispatch
    api/
      chat-routes.ts      # Route handler: auth, CRUD, streaming dispatch
    chat/
      types.ts            # ChatUser, ChatConversation, ChatMessage, ChatFeedback
      system-prompt.ts    # System prompt builder (base prompt + tool descriptions)
      tool-catalog.ts     # Anthropic tool_use definitions + GrimoireHandle executors
    services/
      chat.ts             # Claude API: streaming, tool loop, message persistence
    state/
      chat.ts             # D1 SQL layer: conversations, messages, feedback, purge
  wrangler.toml
  CLAUDE.md               # This file
```

Shared code imported via `@shared/*` tsconfig path alias:
- `@shared/grimoire/handle` (createGrimoireHandle)
- `@shared/grimoire/types` (GrimoireHandle, safeJson)
- `@shared/config` (CHAT constants: model, max_tokens, max_tool_iterations)

## Rules for CC

### Before Any Change

1. Read this file
2. Read wrangler.toml to verify bindings
3. If touching chat service, read src/services/chat.ts for the streaming + tool-use loop
4. If touching tools, also read HobBot/src/mcp/server.ts (the MCP equivalent)
5. If touching auth, verify session cookie implementation in chat-routes.ts (NOT JWT)
6. If touching the system prompt, check live atom COUNT by querying GRIMOIRE_DB

### Multi-Agent Safety

- Do not create, apply, or drop git stash entries unless explicitly asked
- Do not switch branches unless explicitly asked
- When committing, scope to your changes only
- File references must be repo-root relative (e.g. workers/hobbot-chat/src/services/chat.ts)

### Code Rules

- Do not add JWT auth or CF Access references. Auth is session cookies.
- Model strings should be pulled from shared config, not hardcoded
- Streaming responses must follow the established SSE event type contract
- Tool results must be serializable JSON (no circular references, no Promises)
- D1 writes only to HOBBOT_DB. GRIMOIRE_DB is read-only.
- Session purge must use chunked deletes (D1 CPU limit protection)

### What NOT To Do

- Do not write to GRIMOIRE_DB. Read-only access.
- Do not add AI, R2, KV, Gemini, or Grok bindings without a clear migration plan
- Do not add GRIMOIRE service binding. Direct D1 is intentional for tool execution latency.
- Do not remove rate limiting
- Do not increase the 40-message history cap without addressing token budget impact
- Do not change the SSE event type contract without updating all consumers (hob.farm frontend)

## Build and Deploy

```bash
cd workers/hobbot-chat
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
| hobbot-worker (gateway) | Proxies /api/chat/* requests to this worker | env.HOBBOT_CHAT.fetch(request) |
| grimoire | Reads GRIMOIRE_DB for tool execution | Direct D1 read binding (not service binding) |
| hobbot-pipeline | No direct relationship | None |
| hobbot-custodian | No direct relationship | None |
| hobbot-agent | No direct relationship | None |
