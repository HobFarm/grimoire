// All TypeScript interfaces for reddit-scanner worker

export interface Env {
  REDDIT_SCANNER_DB: D1Database
  REDDIT_SCANS: R2Bucket
  PROVIDER_HEALTH: KVNamespace
  AI: Ai
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  ENVIRONMENT: 'development' | 'production'
}

export interface SubredditConfig {
  name: string
  tier: 1 | 2 | 3
}

export interface RedditPost {
  id: string
  title: string
  selftext: string
  score: number
  num_comments: number
  permalink: string
  created_utc: number
  link_flair_text: string | null
  subreddit: string
}

export interface ScanResult {
  subreddit: string
  sort: string
  timestamp: number
  posts: RedditPost[]
}

export interface ScanExtraction {
  subreddit: string
  scan_date: string
  scan_timestamp: string
  topics: TopicSignal[]
}

export interface TopicSignal {
  topic: string
  sentiment: 'frustration' | 'excitement' | 'question' | 'complaint' | 'showcase' | 'news' | 'tutorial'
  intensity: number
  pain_points: string[]
  feature_requests: string[]
  sample_post_ids: string[]
  tools_mentioned: string[]
}

export interface DailyTrend {
  date: string
  topics: TrendEntry[]
}

export interface TrendEntry {
  topic: string
  total_mentions: number
  sentiment_breakdown: Record<string, number>
  velocity: number
  subreddits: string[]
  top_pain_points: string[]
  top_feature_requests: string[]
  first_seen: string
}

