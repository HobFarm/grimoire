// Subreddit tiers, model config, and constants for reddit-scanner

import type { SubredditConfig } from './types'
import type { TaskConfig } from '@shared/models'

// --- Subreddit Configuration ---

export const SUBREDDITS: SubredditConfig[] = [
  // Tier 1: every 4 hours, hot (25) + rising (10) RSS feeds
  { name: 'StableDiffusion', tier: 1 },
  { name: 'comfyui', tier: 1 },
  { name: 'LocalLLaMA', tier: 1 },
  { name: 'ClaudeAI', tier: 1 },
  { name: 'midjourney', tier: 1 },
  { name: 'vibecoding', tier: 1 },

  // Tier 2: every 6 hours, hot (25) RSS feed
  { name: 'OpenAI', tier: 2 },
  { name: 'MachineLearning', tier: 2 },
  { name: 'ChatGPT', tier: 2 },
  { name: 'LangChain', tier: 2 },
  { name: 'PromptEngineering', tier: 2 },
  { name: 'AI_Agents', tier: 2 },
  { name: 'ChatGPTPro', tier: 2 },
  { name: 'aiArt', tier: 2 },

  // Tier 3: every 12 hours, top/day (10) RSS feed
  { name: 'singularity', tier: 3 },
  { name: 'ArtificialInteligence', tier: 3 },
  { name: 'artificial', tier: 3 },
  { name: 'deeplearning', tier: 3 },
  { name: 'generativeAI', tier: 3 },
  { name: 'ollama', tier: 3 },
]

// --- Cron Schedules ---

export const TIER_CRONS: Record<1 | 2 | 3, string> = {
  1: '0 */4 * * *',
  2: '0 */6 * * *',
  3: '0 8,20 * * *',
}

export const ROLLUP_CRON = '0 6 * * *'
export const RETENTION_CRON = '0 7 * * *'

// --- RSS Fetch ---

export const USER_AGENT = 'hobfarm-reddit-scanner/1.0'
export const REQUEST_DELAY_MS = 200 // courtesy delay between requests (no documented rate limit)

// --- Extraction ---

export const MAX_TOPICS_PER_SCAN = 10

// Inline TaskConfig: Qwen3 30B primary, Nemotron 120B first fallback, Gemini flash second fallback.
// callWithJsonParse iterates the full fallbacks array, so three-deep chains work natively.
// Not added to the shared MODELS registry; this worker only uses one task type.
export const EXTRACTION_MODEL: TaskConfig = {
  primary: {
    provider: 'workers-ai',
    model: '@cf/qwen/qwen3-30b-a3b-fp8',
    options: { temperature: 0.2, maxOutputTokens: 4096 },
  },
  fallbacks: [
    {
      provider: 'workers-ai',
      model: '@cf/nvidia/nemotron-3-120b-a12b',
      options: { temperature: 0.2, maxOutputTokens: 4096 },
    },
    {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      options: { temperature: 0.2, maxOutputTokens: 4096 },
    },
  ],
}

// --- Retention Thresholds (days) ---

export const RETENTION_D1_DAYS = 30
export const RETENTION_R2_SCANS_DAYS = 14
export const RETENTION_R2_EXTRACTIONS_DAYS = 30
export const RETENTION_R2_TRENDS_DAYS = 90
