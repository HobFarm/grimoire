// Blog pipeline shared types

export type BlogChannel = 'blog' | 'newsletter'

export interface BlogQueueRow {
  id: number
  content_type: 'grimoire_spotlight' | 'rss_analysis' | 'project_update' | 'industry_commentary' | 'tutorial'
  source_ref: string | null
  category: string
  channel: BlogChannel
  status: string
  scheduled_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface BlogPostRow {
  id: number
  queue_id: number | null
  title: string
  slug: string
  excerpt: string
  body_md: string
  tags: string // JSON array string
  category: string
  channel: BlogChannel
  arrangement: string | null
  hero_key: string | null
  hero_alt: string | null
  github_sha: string | null
  status: string // 'draft' | 'published' | 'rejected' | 'failed'
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface SourceResult {
  content_type: BlogQueueRow['content_type']
  category: string
  channel: BlogChannel
  sourceContent: string
  sourceMetadata: Record<string, unknown>
}

export interface EnrichResult {
  atoms: Array<{ slug: string; label: string; category: string }>
  arrangement?: string
  correspondences: Array<{ from: string; to: string; strength: number }>
}

export interface ComposeOutput {
  title: string
  slug: string
  excerpt: string
  body_md: string
  tags: string[]
  heroDirection: { subject: string; style: string; mood: string; palette: string }
}

export interface ValidateResult {
  valid: boolean
  errors: string[]
}

export interface DraftResult {
  postId: number
  slug: string
}

export interface PhaseTimings {
  source_ms: number
  enrich_ms: number
  compose_ms: number
  validate_ms: number
  draft_ms: number
  total_ms: number
}

export interface PipelineResult {
  success: boolean
  noop?: boolean
  queueId?: number
  slug?: string
  error?: string
  timings: Partial<PhaseTimings>
}

export interface BridgeResult {
  candidatesScanned: number
  qualified: number
  queued: number
  skipped: number
}

export interface GrimoireMatch {
  atomCount: number
  arrangements: string[]
  topAtoms: Array<{ slug: string; label: string; category: string }>
  score: number // 0-1 composite: (atomCount / 5) * 0.5 + (arrangementMatch ? 0.5 : 0)
}
