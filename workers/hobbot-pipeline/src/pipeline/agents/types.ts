// Shared types and utilities for the five-agent ingest pipeline

import type { GrimoireHandle, AtomRelationType } from '@shared/grimoire/types'
import { GeminiProvider } from '@shared/providers/gemini'
import { WorkersAIProvider } from '@shared/providers/workers-ai'
import { MODELS, type TaskType } from '@shared/models'

// --- Agent Context ---

export interface AgentContext {
  db: D1Database
  ai: Ai
  geminiKey: string
  handle: GrimoireHandle
  grimoire: Fetcher
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

// --- JSON Parse Helper ---

/** Strip markdown code fences from model output */
function stripFences(text: string): string {
  let cleaned = text.trim()
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7)
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3)
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3)
  return cleaned.trim()
}

/** Strip <think>...</think> blocks from thinking models (Qwen3, etc.) */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/** Try to extract JSON from model output, handling think blocks, fences, and embedded text */
function extractJson(text: string): unknown {
  // Strip thinking blocks first (Qwen3-30b wraps reasoning in <think> tags)
  const cleaned = stripThinkBlocks(text)

  // Direct parse
  try { return JSON.parse(cleaned) } catch {}

  // Strip fences
  const stripped = stripFences(cleaned)
  try { return JSON.parse(stripped) } catch {}

  // Find first { ... } block
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) } catch {}
  }

  return null
}

/**
 * Call an AI model and parse JSON output with retry + fallback.
 *
 * 1. Call primary model (Workers AI), try to parse JSON
 * 2. If parse fails, retry once with stricter prompt suffix
 * 3. If retry fails, fall back to Gemini with responseMimeType: application/json
 *
 * Returns { result, modelUsed } so step_status can record which model produced the output.
 */
export async function callWithJsonParse<T>(
  taskType: TaskType,
  systemPrompt: string,
  userContent: string,
  ai: Ai,
  geminiKey: string,
): Promise<{ result: T; modelUsed: string }> {
  const config = MODELS[taskType]
  const primary = config.primary

  // Attempt 1: primary model
  const provider = primary.provider === 'workers-ai'
    ? new WorkersAIProvider(primary.model, ai)
    : new GeminiProvider(primary.model, geminiKey)

  const request = {
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userContent },
    ],
    temperature: primary.options?.temperature ?? 0.2,
    maxTokens: primary.options?.maxOutputTokens ?? 1024,
    ...(primary.provider === 'gemini' ? { responseFormat: 'json' as const } : {}),
  }

  const resp1 = await provider.generateResponse(request)
  const parsed1 = extractJson(resp1.content)
  if (parsed1 !== null) {
    return { result: parsed1 as T, modelUsed: primary.model }
  }

  // Attempt 2: retry with stricter instruction
  const retryRequest = {
    ...request,
    messages: [
      { role: 'system' as const, content: systemPrompt + '\n\nCRITICAL: Your previous response was not valid JSON. Output ONLY the JSON object. No text before or after.' },
      { role: 'user' as const, content: userContent },
    ],
  }

  try {
    const resp2 = await provider.generateResponse(retryRequest)
    const parsed2 = extractJson(resp2.content)
    if (parsed2 !== null) {
      return { result: parsed2 as T, modelUsed: primary.model + ':retry' }
    }
  } catch (e) {
    console.warn(`[callWithJsonParse] retry failed for ${taskType}: ${e instanceof Error ? e.message : e}`)
  }

  // Attempt 3: fallback model
  const fallbacks = config.fallbacks
  if (fallbacks.length > 0) {
    const fb = fallbacks[0]
    const fbProvider = fb.provider === 'workers-ai'
      ? new WorkersAIProvider(fb.model, ai)
      : new GeminiProvider(fb.model, geminiKey)
    const fbRequest = {
      messages: request.messages,
      temperature: fb.options?.temperature ?? request.temperature,
      maxTokens: fb.options?.maxOutputTokens ?? request.maxTokens,
      ...(fb.provider === 'gemini' ? { responseFormat: 'json' as const } : {}),
    }
    try {
      const resp3 = await fbProvider.generateResponse(fbRequest)
      const parsed3 = extractJson(resp3.content)
      if (parsed3 !== null) {
        return { result: parsed3 as T, modelUsed: fb.model + ':fallback' }
      }
    } catch (e) {
      console.warn(`[callWithJsonParse] fallback failed for ${taskType}: ${e instanceof Error ? e.message : e}`)
    }
  }

  throw new Error(`[callWithJsonParse] All attempts failed for ${taskType}. No valid JSON produced.`)
}
