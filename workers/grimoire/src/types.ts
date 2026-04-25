// --- Worker Environment ---

export interface Env {
  DB: D1Database
  HOBBOT_DB?: D1Database
  AI: Ai
  VECTORIZE: Vectorize
  GEMINI_API_KEY: string
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_NAME: string
  AI_GATEWAY_TOKEN?: string
  PROVIDER_HEALTH?: KVNamespace
  // Phase 8: Connectivity Agent work queue (event-driven, populated at atom confirmation)
  CONNECTIVITY_KV: KVNamespace
  ALLOWED_ORIGINS: string
  SERVICE_TOKENS?: string | { get: () => Promise<string> }
  // R2 (daily review output)
  R2?: R2Bucket
  // R2 (grimoire bucket: reference images + analysis docs)
  GRIMOIRE_R2?: R2Bucket
  // DLQ alerting
  DISCORD_WEBHOOK_URL?: string
  // Queues
  CLASSIFY_QUEUE: Queue<ClassifyMessage>
  DISCOVERY_QUEUE: Queue<DiscoveryMessage>
  VECTORIZE_QUEUE: Queue<VectorizeMessage>
  ENRICH_QUEUE: Queue<EnrichMessage>
  // Workflows
  BULK_RETAG_WORKFLOW: Workflow
  BULK_CORRESPONDENCES_WORKFLOW: Workflow
}

// --- Queue Message Types ---

export type ClassifyMessage =
  | { type: 'classify'; atomId: string }
  | { type: 'enrich-harmonics'; atomId: string }
  | { type: 'classify-register'; atomId: string; categorySlug: string }

export type DiscoveryMessage = { type: 'discover'; atomId: string }

export type VectorizeMessage =
  | { type: 'vectorize'; atomId: string }
  | { type: 'vectorize-chunk'; chunkId: string }

export type EnrichMessage =
  | { type: 'tag-arrangements'; atomId: string }
  | { type: 'discover-correspondences'; atomId: string }

export type QueueMessage = ClassifyMessage | DiscoveryMessage | VectorizeMessage | EnrichMessage

// --- Workflow Params ---

export interface BulkRetagParams {
  batchSize?: number
  afterRowid?: number
  dryRun?: boolean
}

export interface BulkCorrespondenceParams {
  batchSize?: number
  afterRowid?: number
  dryRun?: boolean
}

// --- Request/Response shapes ---

export interface ClassifyRequest {
  text: string
  categories: string[]
  contexts?: string[]
  max_results?: number
}

export interface ClassifyBatchRequest {
  items: Array<{
    text: string
    categories: string[]
  }>
  contexts?: string[]
  max_results_per_item?: number
}

export interface ClassificationItem {
  category: string
  result: Record<string, unknown>
  confidence: number
  cached: boolean
}

export interface ClassifyResponse {
  classifications: ClassificationItem[]
  unclassified: string[]
  context_used: string[]
}

// --- Database row types ---

export interface CategoryRow {
  slug: string
  parent: string
  label: string
  description: string
  output_schema: string
  default_modality: string
}

export interface CategoryMetadata {
  slug: string
  description: string
  default_modality: string
}

export interface CategoryValidation {
  slugs: Set<string>
  modalityMap: Map<string, string>
}

export interface ContextRow {
  category_slug: string
  context: string
  guidance: string
}

export interface RelationRow {
  source_slug: string
  target_slug: string
  relation: 'overlaps' | 'contains' | 'excludes' | 'pairs_with'
  note: string
}

export interface CacheRow {
  term_hash: string
  term: string
  category_slug: string
  result: string
  confidence: number
  created_at: string
  accessed_at: string
  access_count: number
  reclassify_count: number
}

// --- Internal working types ---

export interface ResolvedCategory {
  slug: string
  parent: string
  label: string
  description: string
  output_schema: Record<string, string>
}

export interface ResolvedContext {
  category_slug: string
  context: string
  guidance: string
}

export interface GeminiClassificationResult {
  classifications: Array<{
    category: string
    result: Record<string, unknown>
    confidence: number
  }>
  unclassified: string[]
}

export interface CacheStats {
  total_entries: number
  total_hits: number
  low_confidence_count: number
  stale_reclassify_count: number
  categories_cached: number
}

export interface CachedHit {
  result: Record<string, unknown>
  confidence: number
  cached: true
}

// --- Collections ---

export interface CollectionRow {
  slug: string
  name: string
  description: string | null
  parent_slug: string | null
  created_at: string
}

export interface CollectionTree extends CollectionRow {
  children: CollectionTree[]
}

// --- Atoms ---

export type AtomObservation = 'observation' | 'interpretation'
export type AtomStatus = 'provisional' | 'confirmed' | 'rejected'
export type AtomSource = 'seed' | 'ai' | 'manual'

export interface AtomRow {
  id: string
  text: string
  text_lower: string
  collection_slug: string
  observation: AtomObservation
  status: AtomStatus
  confidence: number
  encounter_count: number
  tags: string
  source: AtomSource
  source_app: string | null
  metadata: string
  created_at: string
  updated_at: string
  // Phase 3: Orchestration
  category_slug: string | null
  harmonics: string // JSON HarmonicProfile, default '{}'
  // Phase 4: Vectorize
  embedding_status: string // 'pending' | 'processing' | 'complete' | 'failed'
  // Modality axis
  modality: string // 'visual' | 'narrative' | 'both'
  // Utility classification
  utility: string // 'visual' | 'literary' | 'dual'
  // Phase 1.9: Tier
  tier: number // 1, 2, or 3
  // Phase 1.10: Register dimension
  register: number | null // 0.0 (ethereal) to 1.0 (visceral), NULL = unclassified
  // Arrangement affiliation: [{slug, dist}] from top-N tagger
  arrangement_tags: string // JSON array of {slug: string, dist: number}
}

export interface CreateAtomInput {
  text: string
  collection_slug: string
  observation?: AtomObservation
  status?: AtomStatus
  confidence?: number
  tags?: string[]
  source: AtomSource
  source_app?: string
  metadata?: Record<string, unknown>
  category_slug?: string | null
  harmonics?: string
  modality?: string
  utility?: string
}

export interface UpdateAtomInput {
  text?: string
  collection_slug?: string
  observation?: AtomObservation
  status?: AtomStatus
  confidence?: number
  tags?: string[]
  source_app?: string
  metadata?: Record<string, unknown>
}

export interface BulkAtomResult {
  inserted: number
  duplicates: number
  errors: number
  // Populated by bulkInsertAtoms so WithHooks wrapper can enqueue only confirmed rows.
  inserted_ids?: Array<{ id: string; status: AtomStatus }>
}

export interface AtomListQuery {
  collection_slug?: string
  status?: AtomStatus
  source?: AtomSource
  source_app?: string
  q?: string
  limit?: number
  offset?: number
  after?: string
}

export interface AtomStats {
  total: number
  by_collection: Record<string, number>
  by_status: Record<string, number>
  by_source: Record<string, number>
}

// --- App Routing ---

export interface AppRoutingRow {
  atom_id: string
  app: string
  routing: string
  context: string | null
  created_at: string
}

export interface SetRoutingInput {
  atom_id: string
  app: string
  routing: string
  context?: string
}

// --- Discover (AI classification) ---

export interface DiscoverRequest {
  text: string
  source_app?: string
}

export interface DiscoverResponse {
  atom: AtomRow
  classification: {
    collection_slug: string
    observation: AtomObservation
    confidence: number
    reasoning: string
    is_new: boolean
  }
}

export interface DiscoverRejection {
  rejected: true
  term: string
  reason: string
}

// --- Decompose (concept -> atoms) ---

export interface DecomposeRequest {
  concept: string
  source_app?: string
}

export interface DecomposeAtomResult {
  text: string
  collection_slug: string
  observation: AtomObservation
}

export interface DecomposeResponse {
  concept: string
  description: string
  atoms_created: AtomRow[]
  atoms_existing: AtomRow[]
  collections_needed: string[]
}

// --- Semantic Search ---

export interface SearchRequest {
  query: string
  collection_slug?: string
  category_slug?: string
  limit?: number
}

export interface SearchResult {
  atom: AtomRow
  score: number
}

export interface DocumentChunkSearchResult {
  id: string
  content: string
  category_slug: string | null
  document_id: string
  document_title: string
  similarity: number
}

// --- CSV Ingest ---

export interface IngestCsvRequest {
  rows: Record<string, string>[]
  collection_slug: string
  source_app?: string
  column_map: {
    text: string
    tags?: string
  }
}

// --- Arrangements (orchestration layer) ---

export interface ArrangementRow {
  slug: string
  name: string
  harmonics: string
  category_weights: string
  context_key: string
  register: number | null
  created_at: string
}

// --- Incantations (prompt templates) ---

export interface IncantationRow {
  id: string
  name: string
  slug: string
  description: string | null
  modality: string
  genre: string | null
  template_text: string | null
  metadata: string
  created_at: string
}

export interface IncantationSlotRow {
  id: string
  incantation_id: string
  slot_name: string
  category_filter: string | null
  required: number // 0 or 1
  sort_order: number
}

export interface ExemplarRow {
  id: string
  incantation_id: string
  slot_name: string
  atom_id: string
  frequency: number
  source_file: string | null
  metadata: string
  created_at: string
}

// --- Image Extraction ---

export interface CandidateAtom {
  name: string
  description: string
  suggested_category: string
  utility: 'directive' | 'modifier' | 'descriptor'
  modality: 'visual' | 'narrative' | 'both'
  confidence: number
}

export interface CandidateCorrespondence {
  source_name: string
  target_name: string
  relationship: string
  suggested_strength: number
}

export interface ImageExtractionResult {
  source_url: string
  source_attribution: string
  artist_attribution: string | null
  candidate_atoms: CandidateAtom[]
  candidate_correspondences: CandidateCorrespondence[]
  raw_analysis: string
}

export interface ImageExtractionCandidate {
  id: number
  source_url: string
  source_attribution: string | null
  candidate_type: 'atom' | 'correspondence'
  candidate_data: string
  status: 'pending' | 'approved' | 'rejected' | 'merged'
  review_notes: string | null
  created_at: string
  reviewed_at: string | null
}

// --- Vocabulary Resolution ---

export interface ResolveRequest {
  phrases: string[]
  min_confidence?: number
  include_harmonics?: boolean
}

export type ResolveMatchType = 'exact' | 'prefix' | 'semantic'

export interface ResolvedAtom {
  id: string
  text: string
  category_slug: string | null
  match_type: ResolveMatchType
  confidence: number
  harmonics?: Record<string, number>
}

export interface ResolvedPhrase {
  phrase: string
  atoms: ResolvedAtom[]
  unresolved_tokens: string[]
}

export interface ResolveResponse {
  results: ResolvedPhrase[]
  stats: {
    total_phrases: number
    fully_resolved: number
    partially_resolved: number
    unresolved: number
  }
}

// --- Connectivity Agent (Phase 8) ---

export interface ConnectivityStats {
  source: 'event' | 'sweep'
  atoms_processed: number
  atoms_skipped: number
  tags_applied: number
  tags_ambiguous: number
  memberships_created: number
  memberships_ambiguous: number
  correspondences_created: number
  rows_read_estimate: number
  rows_written: number
  budget_exhausted: boolean
  duration_ms: number
  active_axes_count: number
}

export interface ConnectivityAxisCentroids {
  v: 1
  axis_slug: string
  computed_at: string
  seed_counts: { low: number; high: number }
  insufficient?: boolean
  low?: number[]
  high?: number[]
}

export interface ConnectivityStatsRun {
  at: string
  source: 'event' | 'sweep'
  atoms_processed: number
  atoms_skipped: number
  tags_applied: number
  tags_ambiguous: number
  memberships_created: number
  memberships_ambiguous: number
  correspondences_created: number
  rows_read_estimate: number
  rows_written: number
  budget_exhausted: boolean
  duration_ms: number
  active_axes_count: number
}

export interface ConnectivityStatsDailyTotals {
  atoms_processed: number
  atoms_skipped: number
  tags_applied: number
  tags_ambiguous: number
  memberships_created: number
  memberships_ambiguous: number
  correspondences_created: number
  rows_read_estimate: number
  rows_written: number
  budget_exhausted_count: number
  total_duration_ms: number
}

export interface ConnectivityStatsDaily {
  v: 1
  date: string
  runs: ConnectivityStatsRun[]
  totals: ConnectivityStatsDailyTotals
}

// --- Manifest Builder ---

export interface ManifestSpec {
  v: 1
  slug: string
  name: string
  description: string
  include: {
    category_prefixes: string[]
    category_exact?: string[]
    tag_categories?: string[]
    tags?: string[]
  }
  exclude?: {
    category_prefixes?: string[]
    tags?: string[]
  }
  correspondence_filter?: {
    internal_only?: boolean
    provenances?: string[]
  }
}

export interface HarmonicsCompact {
  h: number
  t: number
  w: number
  f: number
  e: number
  r: number
}

export interface ManifestRelation {
  id: string
  type: string
  s: number
  p: string
}

export interface ManifestAtom {
  id: string
  text: string
  cat: string
  h: HarmonicsCompact
  tags?: string[]
  poles?: Record<string, string>
  rel?: ManifestRelation[]
}

export interface ManifestStats {
  atom_count: number
  correspondence_count: number
  tag_count: number
  membership_count: number
  build_duration_ms: number
}

export interface Manifest {
  v: 1
  slug: string
  name: string
  description: string
  built_at: string
  stats: ManifestStats
  atoms: ManifestAtom[]
}

export interface ManifestMeta {
  slug: string
  name: string
  built_at: string
  stats: ManifestStats
  size_bytes?: number
  gzip_bytes?: number
}

export interface GraphAtom {
  id: string
  text: string
  category_slug: string
  h: HarmonicsCompact
}

export interface GraphCorrespondence {
  target: string
  type: string
  s: number
  p: string
  a_id: string
  b_id: string
}

export interface GraphTag {
  slug: string
  category: string
}

export interface GraphSnapshot {
  atoms: Map<string, GraphAtom>
  atomTags: Map<string, GraphTag[]>
  memberships: Map<string, Record<string, string>>
  correspondences: Map<string, GraphCorrespondence[]>
  loadDurationMs: number
  stats: {
    atoms_loaded: number
    atom_tags_loaded: number
    memberships_loaded: number
    correspondences_loaded: number
    harmonics_parse_failures: number
  }
}

export interface ManifestBuildSummary {
  slug: string
  name: string
  stats: ManifestStats
  bytes: number
  gzip_bytes: number
}

export interface ManifestBuildResult {
  graph_load_ms: number
  total_ms: number
  manifests: ManifestBuildSummary[]
  skipped: Array<{ slug: string; reason: string }>
}
