interface Env {
  GRIMOIRE_DB: D1Database
  HOBBOT_DB: D1Database
  AI: Ai
  PROVIDER_HEALTH: KVNamespace
  GRIMOIRE: Fetcher
  GEMINI_API_KEY: string
  AI_GATEWAY_ACCOUNT_ID: string
  AI_GATEWAY_NAME: string
  AI_GATEWAY_TOKEN: string
  ENVIRONMENT: 'development' | 'production'
}
