// --- Worker Environment ---

export interface Env {
  DB: D1Database
  AI: Ai
  VECTORIZE: Vectorize
  GEMINI_MODEL: string
  GEMINI_API_KEY: string
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_NAME: string
  AI_GATEWAY_TOKEN?: string
  ALLOWED_ORIGINS: string
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
  // Phase 1.9: Tier
  tier: number // 1, 2, or 3
  // Phase 1.10: Register dimension
  register: number | null // 0.0 (ethereal) to 1.0 (visceral), NULL = unclassified
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
}

export interface AtomListQuery {
  collection_slug?: string
  status?: AtomStatus
  source?: AtomSource
  source_app?: string
  q?: string
  limit?: number
  offset?: number
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
