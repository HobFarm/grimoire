# Grimoire: Layered Knowledge System

> CC: Read this file before working anywhere in the Grimoire monorepo.
> For worker-specific operational details (bindings, routes, queues, AI calls, deploy),
> read the CLAUDE.md inside the relevant worker directory under workers/.
>
> This file describes architecture and behavior, not current state.
> Never cite counts or model version strings from this file.
> Query the actual database or worker config for current values.

## What the Grimoire Is

The Grimoire is a layered knowledge graph that provides contextual vocabulary to AI systems across all HobFarm projects. When StyleFusion compiles a prompt, the Grimoire supplies visual vocabulary. When the blog pipeline drafts a post, the Grimoire supplies domain knowledge. When the chat interface answers a question, the Grimoire supplies structured context.

It is not a database. It is a living knowledge system with ingestion, enrichment, classification, embedding, correspondence discovery, and arrangement-aware retrieval running continuously via cron-driven queues.

## The Knowledge Layers

```
LAYER 5: Relations & Correspondences
        Connections between concepts across all layers.
        Semantic (vector-neighbor) and pipeline-derived (co-occurrence, hierarchy).

LAYER 4: Vocabulary Index (atoms)
        Lookup entries for concepts the system has encountered.
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
        Raw knowledge. Essays, wiki pages, articles, PDFs.
        Origin tracking. The archival layer.
```

**Knowledge flows downward** (documents become chunks). **Indexing flows upward** (chunks produce vocabulary entries only when new concepts appear). **Relations flow laterally** (correspondences link concepts across layers and documents).

## How Consumers Use the Grimoire

When StyleFusion needs vocabulary for "surrealist frottage texture":

1. Query the vocabulary index, find matching entries
2. Those entries point to enriched chunks containing actual knowledge
3. The chunk content (Ernst's wood grain textures, striated landscapes, quasi-random pattern) enriches the compiled prompt
4. Arrangement profiles weight which vocabulary gets priority based on target aesthetic

The vocabulary entry FINDS the knowledge. The chunk CONTAINS the knowledge. The arrangement WEIGHTS the knowledge. The compiled prompt USES the knowledge.

## How New Knowledge Enters

Knowledge enters as documents (essays, wiki pages, articles, PDFs) through HobBot's ingest pipeline. The pipeline processes it:

1. Chunk the document into self-contained knowledge units
2. Enrich each chunk (summary, categories, arrangements, quality score, key concepts)
3. Match chunk concepts against existing vocabulary (exact, FTS5, then AI disambiguation)
4. Create new vocabulary entries ONLY for concepts that don't match anything existing
5. Link chunks to both existing and new vocabulary entries
6. Build relations between concepts

**A healthy ingestion produces many chunk-to-existing-vocabulary links and few new vocabulary entries.** The vocabulary index grows slowly. The knowledge layer grows with every ingestion. If a batch of documents produces hundreds of new vocabulary entries, the matching step isn't working; most concepts should match existing vocabulary.

**Never optimize for vocabulary entry count. Optimize for chunk quality and coverage.**

## Continuous Processing Pipeline

After ingestion, atoms flow through a 6-phase cron-driven pipeline (runs every 15 minutes in the grimoire worker):

1. **Classification**: New atoms get category assignment
2. **Vectorization**: Classified atoms get embeddings (768-dim, bge-base-en-v1.5)
3. **Harmonics enrichment**: Classified atoms get scored on 6 harmonic dimensions
4. **Arrangement tagging**: Atoms with harmonics get matched to arrangement profiles
5. **Register classification**: Atoms get register dimension scoring
6. **Correspondence discovery**: Embedded atoms get semantic neighbors linked

Each phase has its own queue with independent concurrency and retry settings. A 30-minute re-enqueue guard prevents duplicate processing. See `workers/grimoire/CLAUDE.md` for queue configuration details.

## Harmonic Dimensions

Every atom carries six harmonic scores (0.0 to 1.0):

| Dimension | Low (0.0) | High (1.0) |
|-----------|-----------|------------|
| hardness | soft, organic, flowing | hard, geometric, rigid |
| temperature | cool, clinical, detached | warm, intimate, organic |
| weight | light, airy, minimal | heavy, dense, substantial |
| formality | casual, raw, spontaneous | formal, refined, structured |
| era_affinity | ancient, historical | contemporary, futuristic |
| register | vernacular, folk | academic, elevated |

These enable arrangement matching: StyleFusion queries for vocabulary whose harmonic profile matches the target arrangement's ranges.

## Database Ownership

**GRIMOIRE_DB is owned exclusively by the grimoire worker.** All other workers access it through service binding RPC or shared D1 read bindings.

Exception: grimoire-classifier has a direct D1 write binding for bulk classification operations. This is a pragmatic exception, not a pattern to replicate.

Table groups by layer:

**Layer 1:** documents, sources, source_atoms
**Layer 2:** document_chunks (content, summary, categories, arrangement_slugs, quality_score)
**Layer 3:** categories, category_relations, collections, arrangements, category_contexts
**Layer 4:** atoms (term, category_slug, description, harmonics, status, embedding_status, register, tag_version, last_enqueued_at)
**Layer 5:** atom_relations, correspondences
**Operational:** exemplars, incantations, incantation_slots, discovery_queue, validation_log, integrity_scans, usage_log, evolve_reports, provider_behaviors, ingest_log, agent_budgets

Query the database for the actual schema. This list may be incomplete.

## Worker Topology

| Worker | Role | CLAUDE.md |
|--------|------|-----------|
| workers/grimoire | Knowledge graph owner. Classification, vectorization, search, taxonomy, queues, workflows. | workers/grimoire/CLAUDE.md |
| workers/grimoire-classifier | Bulk classification and harmonization. Manual trigger only. | workers/grimoire-classifier/CLAUDE.md |

### How Other HobBot Workers Interact

| HobBot Worker | How It Uses Grimoire | Access Pattern |
|---------------|---------------------|----------------|
| hobbot-pipeline | Ingests documents, enriches chunks, creates vocabulary entries, builds correspondences | Service binding RPC to grimoire worker |
| hobbot-chat | Searches atoms, looks up terms, traverses correspondences, lists arrangements/categories | Direct D1 read binding to GRIMOIRE_DB |
| hobbot-agent | Curates atoms for content pipeline | Service binding to grimoire worker |
| hobbot-custodian | Triggers knowledge ingestion via pipeline (no direct Grimoire access) | Indirect via hobbot-pipeline |
| hobbot-worker (gateway) | Routes MCP tools that ultimately call pipeline or grimoire | Service binding chain |

## Shared Code

All Grimoire workers import shared code from `HobBot/src/shared/` via tsconfig path aliases:

| Module | Purpose |
|--------|---------|
| providers/gemini.ts | GeminiProvider (HTTP to Google AI Studio) |
| providers/workers-ai.ts | WorkersAIProvider (edge-native env.AI.run) |
| providers/index.ts | getProvider factory, callWithFallback utility |
| models.ts | Model registry, task-to-model mapping, fallback chains |
| immune.ts | AI duplicate detection (semantic equivalence check) |

The model registry is the single source of truth for all model strings and fallback chains. If a model string appears hardcoded in a handler instead of pulled from the registry, that's a bug.

## Key Principles

1. **Knowledge-first.** Documents and chunks are the knowledge. Vocabulary entries are indexing signals that help the system find relevant chunks. Never invert this.
2. **Vocabulary entries only for new concepts.** If the Grimoire already knows a concept, link to the existing entry. Don't create duplicates.
3. **Chunk quality is the metric.** Not vocabulary entry count.
4. **Arrangement context informs, never overrides.** When StyleFusion extracts from a reference image, the extraction is ground truth. Grimoire enrichment adds vocabulary; it never replaces observation.
5. **Single source of truth.** The grimoire worker owns GRIMOIRE_DB. Other workers read through service bindings or shared D1 read bindings.
6. **Query, never assume.** All counts, lists, and distributions change constantly.
7. **Workers AI primary, Workers AI fallback.** New AI call sites must use a Workers AI model as primary with a different Workers AI model as fallback. External providers (Gemini, Anthropic, xAI) only when the task requires a capability Workers AI cannot provide; document the justification in code comments at the call site.

## What NOT To Do

- Do not insert atoms directly to "seed" the Grimoire. Submit knowledge documents through HobBot's ingest pipeline.
- Do not treat vocabulary entry count as a quality metric.
- Do not write to GRIMOIRE_DB from workers outside the Grimoire topology (grimoire + grimoire-classifier).
- Do not hardcode model version strings. They belong in the shared model registry.
- Do not reference specific counts in documentation or comments.
- Do not change embedding models or vector dimensions without explicit approval and a re-vectorization plan.
