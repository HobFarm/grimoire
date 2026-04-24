// Embedding Agent: enqueue chunks for vectorization via GRIMOIRE service binding
// Thin wrapper making the vectorization call explicit in the pipeline

/**
 * Enqueue chunks for embedding generation via the GRIMOIRE service binding.
 */
export async function runEmbeddingAgent(
  grimoire: Fetcher,
  chunkIds: string[],
  serviceToken?: string,
): Promise<{ enqueued: number; status: string }> {
  if (chunkIds.length === 0) {
    return { enqueued: 0, status: 'skipped:no_chunks' }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (serviceToken) {
    headers['Authorization'] = `Bearer ${serviceToken}`
  }

  try {
    await grimoire.fetch('https://grimoire/admin/enqueue-chunks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ chunkIds }),
    })

    console.log(`[embedding] enqueued ${chunkIds.length} chunks`)
    return { enqueued: chunkIds.length, status: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[embedding] failed to enqueue chunks: ${msg}`)
    return { enqueued: 0, status: `failed:${msg}` }
  }
}
