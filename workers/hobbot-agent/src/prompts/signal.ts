export const SIGNAL_QUERIES = [
  'noir aesthetic digital art trending',
  'brutalist architecture photography',
  'retro futurism design',
  'industrial noir visual art',
  'art deco geometry modern',
  'film noir lighting photography',
  'urban decay aesthetic',
  'cyberpunk visual culture',
]

export function buildSignalPrompt(query: string): string {
  return `Search X for recent posts and trends related to: "${query}"

Analyze what you find and return a JSON object with this structure:
{
  "trending_topics": ["topic1", "topic2"],
  "high_engagement_themes": ["theme1", "theme2"],
  "visual_trends": ["trend1", "trend2"],
  "relevance_to_atomic_noir": 0.0 to 1.0,
  "summary": "Brief summary of what's resonating in this space"
}

Focus on aesthetic and visual culture discussions. Ignore promotional content and spam.
Return valid JSON only.`
}
