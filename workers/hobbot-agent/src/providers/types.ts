export type ProviderType = 'anthropic' | 'xai' | 'gemini' | 'workers-ai' | 'inline'

export type TaskType = 'compose' | 'signal' | 'validate' | 'classify' | 'visualize'

export interface ModelEntry {
  provider: ProviderType
  model: string
  options?: {
    temperature?: number
    maxOutputTokens?: number
    thinkingBudget?: number
    responseFormat?: 'json' | 'text'
  }
}

export interface TaskConfig {
  primary: ModelEntry
  fallbacks: ModelEntry[]
  onAllFail?: 'skip' | 'throw'
}

export interface ModelContext {
  ai?: Ai
  health?: KVNamespace
  gatewayAccountId: string
  gatewayName: string
  gatewayToken?: string
  anthropicKey: string
  xaiKey: string
  geminiKey: string
}

export interface ProviderCallResult<T> {
  result: T
  provider: string
  model: string
  durationMs: number
}

export interface CallWithFallbackOptions {
  skipPrimary?: boolean
  onUsage?: (usage: { taskType: string; model: string; provider: string; inputTokens: number; outputTokens: number; estimatedCost: number }) => void
}
