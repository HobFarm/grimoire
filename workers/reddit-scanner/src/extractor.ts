// Workers AI topic extraction: prompt template and callWithJsonParse wrapper

import type { Env, ScanResult, ScanExtraction, TopicSignal } from './types'
import { EXTRACTION_MODEL, MAX_TOPICS_PER_SCAN } from './config'
import { callWithJsonParse } from '@shared/providers/call-with-json-parse'
import { resolveApiKey } from '@shared/providers'

// --- Extraction Prompt ---

const EXTRACTION_SYSTEM_PROMPT = `You are a Reddit topic signal extractor. Analyze the provided subreddit posts and extract structured topic signals.

## Output Format
Return a JSON object matching this exact schema:
{
  "subreddit": "string",
  "scan_date": "YYYY-MM-DD",
  "scan_timestamp": "ISO 8601",
  "topics": [
    {
      "topic": "lowercase 2-5 word label",
      "sentiment": "frustration|excitement|question|complaint|showcase|news|tutorial",
      "intensity": 0.0-1.0,
      "pain_points": ["specific complaint or friction point"],
      "feature_requests": ["thing people want but don't have"],
      "sample_post_ids": ["reddit_post_id"],
      "tools_mentioned": ["specific tool, model, or product name"]
    }
  ]
}

## Rules
- Extract at most ${MAX_TOPICS_PER_SCAN} topics per scan
- Normalize topic labels: lowercase, 2-5 words, no acronyms alone
  - Good: "stable diffusion xl", "local llm deployment", "comfyui workflow nodes"
  - Bad: "SDXL", "LLM", "ComfyUI"
- Sentiment must be exactly one of: frustration, excitement, question, complaint, showcase, news, tutorial
- Intensity: 0.0-1.0. Since RSS does not expose scores or comment counts, estimate intensity from the language: strong opinions, many people reporting the same issue, or explicit "trending" signals warrant higher intensity.
  - 0.0-0.3: niche or low-signal posts
  - 0.3-0.6: moderate interest, some discussion implied
  - 0.6-1.0: clearly trending, strong community reaction
- Pain points: specific things that are broken, frustrating, or unreliable (max 5 per topic)
- Feature requests: specific things people want but don't have yet (max 3 per topic)
- tools_mentioned: exact names of tools, models, products, or services referenced (e.g. "ComfyUI", "Flux.1", "Claude 4")
- sample_post_ids: Reddit post IDs for provenance (max 3 per topic)
- Group similar posts into a single topic rather than creating separate entries for each post
- RSS feeds do not include scores, comment counts, or flair. Estimate intensity from the language and content of posts.`

// --- Extraction Logic ---

/**
 * Build user content string from scan data, depth varies by tier.
 * T1: titles + bodies (hot + rising)
 * T2: titles + bodies (hot only)
 * T3: titles only (top/day)
 */
function buildUserContent(scan: ScanResult, tier: 1 | 2 | 3): string {
  const lines: string[] = [
    `Subreddit: r/${scan.subreddit}`,
    `Tier: ${tier} (RSS feed, no scores or comment counts available)`,
    `Post count: ${scan.posts.length}`,
    '',
    '--- Posts ---',
  ]

  // Body length per tier: shorter for tiers with more posts to keep total input small.
  // Workers AI models (Qwen3 30B, Nemotron 120B) need input under ~3000 tokens for
  // reliable structured JSON output. 10K chars ~= 2500 tokens.
  const maxBodyLen = tier === 1 ? 150 : tier === 2 ? 250 : 0

  for (const post of scan.posts) {
    lines.push(`\n[${post.id}]`)
    lines.push(`Title: ${post.title}`)

    if (maxBodyLen > 0 && post.selftext) {
      const body = post.selftext.length > maxBodyLen ? post.selftext.slice(0, maxBodyLen) + '...' : post.selftext
      // Skip near-empty bodies (HTML artifacts from image-only posts)
      if (body.trim().length > 20) {
        lines.push(`Body: ${body}`)
      }
    }
  }

  // Hard cap: 8K chars (~2000 tokens). Workers AI models need small inputs for reliable JSON output.
  const content = lines.join('\n')
  if (content.length > 8000) {
    return content.slice(0, 8000) + '\n\n[TRUNCATED]'
  }
  return content
}

const VALID_SENTIMENTS = new Set(['frustration', 'excitement', 'question', 'complaint', 'showcase', 'news', 'tutorial'])

function validateExtraction(raw: unknown, subreddit: string, scanTimestamp: number): ScanExtraction {
  const obj = raw as Record<string, unknown>
  const topics = (Array.isArray(obj?.topics) ? obj.topics : []) as Array<Record<string, unknown>>
  const now = new Date(scanTimestamp * 1000)

  const validated: TopicSignal[] = topics
    .slice(0, MAX_TOPICS_PER_SCAN)
    .filter(t => typeof t.topic === 'string' && t.topic.length > 0)
    .map(t => ({
      topic: String(t.topic).toLowerCase().slice(0, 100),
      sentiment: VALID_SENTIMENTS.has(String(t.sentiment)) ? String(t.sentiment) as TopicSignal['sentiment'] : 'news',
      intensity: Math.max(0, Math.min(1, Number(t.intensity) || 0)),
      pain_points: Array.isArray(t.pain_points) ? (t.pain_points as string[]).slice(0, 5).map(String) : [],
      feature_requests: Array.isArray(t.feature_requests) ? (t.feature_requests as string[]).slice(0, 3).map(String) : [],
      sample_post_ids: Array.isArray(t.sample_post_ids) ? (t.sample_post_ids as string[]).slice(0, 3).map(String) : [],
      tools_mentioned: Array.isArray(t.tools_mentioned) ? (t.tools_mentioned as string[]).map(String) : [],
    }))

  return {
    subreddit,
    scan_date: now.toISOString().split('T')[0],
    scan_timestamp: now.toISOString(),
    topics: validated,
  }
}

/**
 * Extract topic signals from a scan result using Workers AI.
 * Uses callWithJsonParse with the EXTRACTION_MODEL config (Qwen3 -> Nemotron -> Gemini).
 */
export async function extractTopics(
  env: Env,
  scan: ScanResult,
  tier: 1 | 2 | 3,
): Promise<ScanExtraction> {
  const userContent = buildUserContent(scan, tier)
  const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)

  console.log(`[extractor] r/${scan.subreddit} tier=${tier} posts=${scan.posts.length} content_len=${userContent.length}`)

  const { result, modelUsed } = await callWithJsonParse<Record<string, unknown>>(
    'reddit.extraction',
    EXTRACTION_SYSTEM_PROMPT,
    userContent,
    env.AI,
    geminiKey,
    EXTRACTION_MODEL,
    { health: env.PROVIDER_HEALTH, timeoutMs: 60_000 },
  )

  console.log(`[extractor] r/${scan.subreddit} extracted via ${modelUsed}`)

  return validateExtraction(result, scan.subreddit, scan.timestamp)
}
