// Pipeline stage: enqueue atoms + chunks for embedding via GRIMOIRE service binding

import { runEmbeddingAgent } from './agents/embedding'

interface VectorizeEnv {
  GRIMOIRE: Fetcher
  SERVICE_TOKENS?: string | { get: () => Promise<string> }
}

async function resolveSecret(binding: string | { get: () => Promise<string> } | undefined): Promise<string> {
  if (!binding) return ''
  if (typeof binding === 'string') return binding
  if (typeof binding === 'object' && 'get' in binding) return await binding.get() ?? ''
  return ''
}

export async function enqueueVectorize(
  env: VectorizeEnv,
  chunkIds: string[],
): Promise<string> {
  const tokenList = await resolveSecret(env.SERVICE_TOKENS)
  // Extract the first token value (strip agent prefix if present)
  let serviceToken = ''
  for (const pair of tokenList.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    serviceToken = colonIdx >= 1 ? trimmed.slice(colonIdx + 1).trim() : trimmed
    break
  }

  const result = await runEmbeddingAgent(env.GRIMOIRE, chunkIds, serviceToken)
  console.log(`[pipeline:vectorize] status=${result.status}`)
  return result.status
}
