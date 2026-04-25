# Grimoire

A self-enriching visual knowledge graph for creative AI. 170K+ atoms connected by harmonic dimensions, semantic correspondences, and tag-based relationships. Built on Cloudflare Workers, D1, R2, and Vectorize.

The Grimoire serves as the foundational vocabulary layer for [HobFarm](https://hob.farm), powering structured knowledge retrieval across image generation (StyleFusion), content orchestration (HobBot), and interactive fiction (XKXXKX).

## What It Does

The Grimoire maintains a graph of **atoms** (discrete creative vocabulary: "chiaroscuro", "brutalist", "gossamer", "patina") with structured metadata:

- **Six harmonic dimensions** (hardness, temperature, weight, formality, era_affinity, register) that position every atom in aesthetic space as continuous 0.0-1.0 values
- **Correspondences** linking atoms by harmonic similarity, semantic proximity, and co-occurrence
- **Tags** and **dimensional memberships** that cluster atoms into navigable groups (art movements, body types, aesthetic weight classes)
- **Arrangements** that define curated vocabulary profiles for specific creative contexts

An LLM generating a "goblincore forest scene" can load a single manifest file and immediately access structured vocabulary with relationships, harmonic positions, and domain context. No prompt engineering gymnastics, no hoping the model remembers the right words.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Grimoire Worker                    │
│                                                      │
│  Cron Pipeline (*/15 min, 8 phases)                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │
│  │  P1  │ │ P2/3 │ │  P4  │ │  P6  │ │  P8  │      │
│  │Class.│ │Enrich│ │Arrang│ │Corr. │ │Conn. │      │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘      │
│                                                      │
│  Admin API         Manifest Builder                  │
│  /admin/*          /admin/manifests/*                 │
│                                                      │
│  Resolver          Chat (via hobbot-chat)            │
│  /api/v1/resolve   hob.farm/grimoire                 │
└──────────┬──────────────────────────────┬────────────┘
           │                              │
     ┌─────▼─────┐                 ┌──────▼──────┐
     │  D1 (SQL) │                 │  R2 (Object) │
     │           │                 │              │
     │ atoms     │                 │ manifests/   │
     │ corresp.  │                 │ specs/       │
     │ tags      │                 │ images/      │
     │ dim_memb. │                 │ analysis/    │
     └───────────┘                 └──────────────┘
                        │
                  ┌─────▼─────┐
                  │ Vectorize │
                  │ (BGE 768) │
                  └───────────┘
```

### Cron Pipeline

Eight phases run every 15 minutes, processing atoms through classification, embedding, enrichment, and connectivity scoring:

| Phase | Name | What It Does |
|-------|------|-------------|
| 1 | Classification | Categorize unclassified atoms (Workers AI) |
| 2 | Vectorization | Generate BGE embeddings for new atoms |
| 3 | Harmonic Enrichment | Score atoms on 6 harmonic dimensions |
| 4 | Arrangement Tagging | Associate atoms with relevant arrangements |
| 5 | Register Classification | Score the register dimension |
| 6 | Correspondence Discovery | Find semantic neighbors via vector similarity |
| 8 | Connectivity Agent | Propagate tags, score dimensional memberships, discover correspondences for newly confirmed atoms |

### Connectivity Agent (Phase 8)

Maintains graph density as new atoms arrive. Event-driven (KV queue populated at atom confirmation) with a watermark-based sweep for catch-up. Three algorithmic scorers run per atom:

- **Tag propagation**: if 3+ of an atom's nearest vector neighbors share a tag, apply it
- **Dimensional membership**: score against pole centroids for each active axis
- **Correspondence discovery**: connect isolated atoms to high-similarity neighbors

### Manifest Builder

Packages the graph into domain-specific JSON files in R2. Consumers load a single file and get structured vocabulary with relationships, harmonics, and tags. Five manifests ship by default:

| Manifest | Atoms | Description |
|----------|-------|-------------|
| `character-generation` | ~65K | Body, hair, face, expression, clothing, pose |
| `environment-generation` | ~28K | Environments, lighting, locations |
| `style-transfer` | ~25K | Art movements, styles, camera, color, composition |
| `narrative-generation` | ~24K | Lore, domains, characters, games |
| `prompt-compilation` | ~151K | Full StyleFusion vocabulary (union of all visual categories) |

Manifests rebuild automatically when the Connectivity Agent completes a full sweep of the atom table, or on-demand via `POST /admin/manifests/build`.

Served gzip-compressed from R2 at `ref.hob.fm/manifests/{slug}.json`.

## Key Concepts

**Atoms** are the fundamental units: single words or short phrases representing creative vocabulary. Each atom has a category, harmonic profile, and connections to other atoms.

**Correspondences** are weighted, typed edges between atoms. Four provenance types: `harmonic` (similar harmonic profiles), `semantic` (vector proximity), `exemplar` (curated), `co_occurrence` (appeared together in source material).

**Arrangements** are curated vocabulary profiles (e.g. "dark-academia", "solarpunk") that define a creative context through weighted atom associations.

**Harmonic dimensions** position atoms in a continuous 6D aesthetic space. "Brutalist" scores high on hardness, low on temperature. "Gossamer" scores low on weight, high on era_affinity. These values drive arrangement matching and correspondence discovery.

## Stack

- **Compute**: Cloudflare Workers (TypeScript, Hono framework)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **Object Storage**: Cloudflare R2 (manifests, specs, images, analysis files)
- **Vector Search**: Cloudflare Vectorize (BGE Base EN v1.5, 768 dimensions)
- **AI Models**: Workers AI (Nemotron, Qwen3, Granite, Gemma 4), with external fallbacks
- **Queue**: Cloudflare Queues (classification, enrichment pipelines)
- **Cache**: Cloudflare KV (provider health, connectivity queue, centroid cache)

## Related Projects

- **[HobBot](https://github.com/HobFarm/HobBot)**: Multi-agent content orchestration swarm that consumes Grimoire vocabulary
- **[hob.farm](https://hob.farm)**: Platform frontend with Grimoire chat interface
- **StyleFusion**: Multi-provider image generation pipeline using Grimoire for prompt compilation

## License

Private project. Source code is viewable for reference and transparency. Not licensed for reuse.
