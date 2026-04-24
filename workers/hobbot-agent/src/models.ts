// Re-export shim: maps unprefixed local task names to shared registry.
// Model strings, temperatures, and fallback chains live in @shared/models.
// Local providers/types.ts defines the local interfaces (TaskType, TaskConfig, etc.).

import { MODELS as SHARED } from '@shared/models'
import type { TaskConfig } from './providers/types'

export const MODELS: Record<string, TaskConfig> = {
  compose: SHARED['agent.compose'] as TaskConfig,
  signal: SHARED['agent.signal'] as TaskConfig,
  validate: SHARED['agent.validate'] as TaskConfig,
  classify: SHARED['agent.classify'] as TaskConfig,
  visualize: SHARED['agent.visualize'] as TaskConfig,
}
