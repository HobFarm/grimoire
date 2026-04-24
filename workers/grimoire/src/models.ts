import { createTokenLogger } from '@shared/providers/token-log'

// --- Task Types ---

export type TaskType =
  | 'classify'              // atom category assignment
  | 'classify.register'     // register dimension scoring
  | 'classify.text'         // text classification via classify.ts (categories endpoint)
  | 'discover'              // new term classification + rejection
  | 'decompose'             // concept decomposition
  | 'embed'                 // embedding generation
  | 'quality.specificity'   // quality gate specificity scoring
  | 'reason.expand'         // expansion agent reasoning (GPT-OSS tier)
  | 'reason.gap_analysis'   // conductor gap analysis (GPT-OSS tier)
  | 'image.extract'         // vision model extraction of atoms/correspondences from images
  | 'moodboard.aggregate'   // synthesize N per-image IRs into one aggregate moodboard IR (Qwen3 -> Nemotron, workers-ai only)

export type ProviderType = 'gemini' | 'workers-ai'

// --- Model Entry ---

export interface ModelEntry {
  provider: ProviderType
  model: string
  options?: {
    temperature?: number
    maxOutputTokens?: number
    thinkingBudget?: number  // Gemini-specific: 0 disables thinking
    responseFormat?: 'json' | 'text'  // Workers AI: structured output mode
  }
}

// --- Task Config ---

export interface TaskConfig {
  primary: ModelEntry
  fallbacks: ModelEntry[]
}

// --- ModelContext ---

/** Narrow interface for AI provider calls. Constructed from Env at request/cron entry. */
export interface ModelContext {
  geminiKey: string
  ai?: Ai
  gatewayAccountId: string
  gatewayName: string
  gatewayToken?: string
  health?: KVNamespace
  onUsage?: (usage: { taskType: string; model: string; provider: string; inputTokens: number; outputTokens: number; estimatedCost: number }) => void
}

// --- GPT-OSS Placeholder ---
// Update this constant when the model ID is confirmed on Workers AI catalog.
// Fallback chains ensure everything works even if this model isn't available yet.
const GPT_OSS_MODEL_ID = '@cf/openai/gpt-oss-120b'

// --- MODELS Config ---

export const MODELS: Record<TaskType, TaskConfig> = {
  // Category + harmonics assignment. Nemotron for structured JSON across 25+ categories + 6 harmonic floats.
  classify: {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.1, maxOutputTokens: 1024, responseFormat: 'json' },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash-lite', options: { temperature: 0.1, maxOutputTokens: 1024, thinkingBudget: 0 } },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
    ],
  },
  // Register dimension scoring. Single float, simplest task. Granite micro for minimum cost/latency.
  'classify.register': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 256, responseFormat: 'json' },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash-lite', options: { temperature: 0.1, maxOutputTokens: 256, thinkingBudget: 0 } },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
    ],
  },
  // REST endpoint text classification. Qwen3 proven for structured output in pipeline agents.
  'classify.text': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.2 },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash', options: { temperature: 0.2 } },
    ],
  },
  // Novel concept evaluation. Needs reasoning to determine vocabulary entry worthiness.
  discover: {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.3 },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash', options: { temperature: 0.3 } },
      { provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8', options: { temperature: 0.3 } },
    ],
  },
  // Concept decomposition into sub-concepts. Same reasoning needs as discover.
  decompose: {
    primary: {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.4 },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash', options: { temperature: 0.4 } },
      { provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8', options: { temperature: 0.4 } },
    ],
  },
  embed: {
    primary: {
      provider: 'workers-ai',
      model: '@cf/baai/bge-base-en-v1.5',
    },
    fallbacks: [],
  },
  // Quality gate: specificity scoring. Tiny output (single float), fast scorer.
  'quality.specificity': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      options: { temperature: 0.1, maxOutputTokens: 64, responseFormat: 'json' },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash-lite', options: { temperature: 0.1, maxOutputTokens: 64, thinkingBudget: 0 } },
    ],
  },
  // Reasoning tier: expansion agent, DREAM consolidation. GPT-OSS primary, Nemotron fallback.
  'reason.expand': {
    primary: {
      provider: 'workers-ai',
      model: GPT_OSS_MODEL_ID,
      options: { temperature: 0.3, maxOutputTokens: 2048 },
    },
    fallbacks: [
      { provider: 'workers-ai', model: '@cf/nvidia/nemotron-3-120b-a12b', options: { temperature: 0.3, maxOutputTokens: 2048 } },
      { provider: 'gemini', model: 'gemini-2.5-flash', options: { temperature: 0.3, maxOutputTokens: 2048 } },
    ],
  },
  // Reasoning tier: conductor gap analysis intent translation. Low reasoning effort.
  'reason.gap_analysis': {
    primary: {
      provider: 'workers-ai',
      model: GPT_OSS_MODEL_ID,
      options: { temperature: 0.2, maxOutputTokens: 1024 },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash', options: { temperature: 0.2, maxOutputTokens: 1024 } },
    ],
  },
  // Vision extraction: extract Grimoire atoms/correspondences from images.
  // Gemma 4 26B for vision with thinking disabled (structured JSON output only).
  'image.extract': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/google/gemma-4-26b-a4b-it',
      options: { temperature: 0.1, maxOutputTokens: 4096, responseFormat: 'json' },
    },
    fallbacks: [
      { provider: 'gemini', model: 'gemini-2.5-flash', options: { temperature: 0.1, maxOutputTokens: 4096 } },
      { provider: 'gemini', model: 'gemini-2.5-flash-lite', options: { temperature: 0.1, maxOutputTokens: 4096, thinkingBudget: 0 } },
    ],
  },
  // Moodboard aggregation: N per-image IRs -> one aggregate IR. Workers-AI-only chain by design.
  // On total failure, caller leaves moodboard row in 'extracted' status and retries later.
  'moodboard.aggregate': {
    primary: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      options: { temperature: 0.3, maxOutputTokens: 4096, responseFormat: 'json' },
    },
    fallbacks: [
      { provider: 'workers-ai', model: '@cf/nvidia/nemotron-3-120b-a12b', options: { temperature: 0.3, maxOutputTokens: 4096, responseFormat: 'json' } },
    ],
  },
}

/** Build a ModelContext from the worker Env. Resolves Secrets Store Fetcher bindings. */
export async function buildModelContext(env: {
  GEMINI_API_KEY: string
  AI?: Ai
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_NAME: string
  AI_GATEWAY_TOKEN?: string
  PROVIDER_HEALTH?: KVNamespace
  HOBBOT_DB?: D1Database
}): Promise<ModelContext> {
  // Secrets Store bindings may be Fetcher objects requiring .get()
  const rawKey = env.GEMINI_API_KEY as unknown
  let geminiKey: string
  if (rawKey && typeof rawKey === 'object' && 'get' in rawKey && typeof (rawKey as { get: unknown }).get === 'function') {
    geminiKey = await (rawKey as { get: () => Promise<string> }).get() ?? ''
  } else {
    geminiKey = (rawKey as string) ?? ''
  }

  const rawToken = env.AI_GATEWAY_TOKEN as unknown
  let gatewayToken: string | undefined
  if (rawToken && typeof rawToken === 'object' && 'get' in rawToken && typeof (rawToken as { get: unknown }).get === 'function') {
    gatewayToken = await (rawToken as { get: () => Promise<string> }).get() ?? undefined
  } else {
    gatewayToken = rawToken as string | undefined
  }

  return {
    geminiKey,
    ai: env.AI,
    gatewayAccountId: env.AI_GATEWAY_ACCOUNT_ID,
    gatewayName: env.AI_GATEWAY_NAME,
    gatewayToken,
    health: env.PROVIDER_HEALTH,
    onUsage: env.HOBBOT_DB ? createTokenLogger(env.HOBBOT_DB, 'grimoire') : undefined,
  }
}
