// Shared types and utilities for the five-agent ingest pipeline

import type { GrimoireHandle, AtomRelationType } from '@shared/grimoire/types'

// --- Agent Context ---

export interface AgentContext {
  db: D1Database
  ai: Ai
  geminiKey: string
  handle: GrimoireHandle
  grimoire: Fetcher
  onUsage?: (usage: { taskType: string; model: string; provider: string; inputTokens: number; outputTokens: number; estimatedCost: number }) => void
}

// --- Enrichment Agent Types ---

export interface KeyConcept {
  term: string
  category_hint: string | null
  is_proper_noun: boolean
}

export interface EnrichedChunkResult {
  chunkId: string
  summary: string
  categorySlug: string | null
  arrangementSlugs: string[]
  qualityScore: number
  keyConcepts: KeyConcept[]
}

// --- Vocabulary Match Agent Types ---

export interface VocabularyMatch {
  term: string
  atomId: string
  confidence: number
}

export interface VocabularyMatchResult {
  matched: VocabularyMatch[]
  unmatched: KeyConcept[]
}

// --- Indexing Agent Types ---

export interface IndexedEntry {
  term: string
  atomId: string
}

export interface IndexingResult {
  created: IndexedEntry[]
  failed: { term: string; reason: string }[]
}

// --- Correspondence Agent Types ---

export interface CorrespondenceEntry {
  sourceAtomId: string
  targetAtomId: string
  relationType: AtomRelationType
  strength: number
  context: string
}

export interface CorrespondenceResult {
  relationsCreated: string[]
  errors: number
}

// --- Pipeline Report ---

export interface PipelineReport {
  chunksProcessed: number
  conceptsExtracted: number
  vocabularyMatched: number
  vocabularyCreated: number
  relationsCreated: number
  modelsUsed: Record<string, string>
}

// callWithJsonParse is now in @shared/providers/call-with-json-parse.ts
// Import it from there instead of from this file.
