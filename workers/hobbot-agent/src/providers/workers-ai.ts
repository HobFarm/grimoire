// Workers AI provider: text generation + image generation + safety.

import type { ModelContext, ModelEntry } from './types'
import { MODELS } from '../models'

const LLAMA_GUARD_MODEL = MODELS.validate.primary.model

const TEXT_TIMEOUT_MS = 30_000
const IMAGE_TIMEOUT_MS = 120_000
const GUARD_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

export async function callWorkersAIText(
  ctx: ModelContext,
  entry: ModelEntry,
  prompt: string
): Promise<string> {
  if (!ctx.ai) throw new Error('Workers AI binding not available')

  const params: Record<string, unknown> = {
    messages: [{ role: 'user' as const, content: prompt }],
    max_tokens: entry.options?.maxOutputTokens ?? 1024,
    temperature: entry.options?.temperature ?? 0.2,
  }
  if (entry.options?.responseFormat === 'json') {
    params.response_format = { type: 'json_object' }
  }

  const result = await withTimeout(ctx.ai.run(entry.model as Parameters<Ai['run']>[0], params), TEXT_TIMEOUT_MS, `Workers AI text (${entry.model})`)

  if (typeof result === 'object' && result !== null && 'response' in result) {
    const response = (result as { response: unknown }).response
    if (typeof response === 'string') return response
    if (response != null) return JSON.stringify(response)
  }

  throw new Error(`Workers AI unexpected response: ${JSON.stringify(result).slice(0, 200)}`)
}

export interface ImageGenOptions {
  width?: number
  height?: number
}

export async function generateImage(
  ai: Ai,
  model: string,
  prompt: string,
  opts?: ImageGenOptions
): Promise<ArrayBuffer> {
  const width = opts?.width ?? 1024
  const height = opts?.height ?? 1024

  // FLUX-2 models require multipart form data
  const isFlux2 = model.includes('flux-2')

  let result: unknown
  if (isFlux2) {
    const form = new FormData()
    form.append('prompt', prompt)
    form.append('width', String(width))
    form.append('height', String(height))
    const formResponse = new Response(form)
    const formStream = formResponse.body
    const formContentType = formResponse.headers.get('content-type') || 'multipart/form-data'
    result = await withTimeout(
      ai.run(model as Parameters<Ai['run']>[0], {
        multipart: { body: formStream, contentType: formContentType },
      } as Record<string, unknown>),
      IMAGE_TIMEOUT_MS,
      `Workers AI image (${model})`,
    )
  } else {
    result = await withTimeout(
      ai.run(model as Parameters<Ai['run']>[0], { prompt, width, height }),
      IMAGE_TIMEOUT_MS,
      `Workers AI image (${model})`,
    )
  }

  return toArrayBuffer(result)
}

async function toArrayBuffer(result: unknown): Promise<ArrayBuffer> {
  if (result instanceof ArrayBuffer) return result

  if (result instanceof ReadableStream) {
    const reader = result.getReader()
    const chunks: Uint8Array[] = []
    let done = false
    while (!done) {
      const read = await reader.read()
      done = read.done
      if (read.value) chunks.push(read.value)
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    return combined.buffer
  }

  // Some models return a Response object
  if (result instanceof Response) {
    return result.arrayBuffer()
  }

  // Some models return Uint8Array directly
  if (result instanceof Uint8Array) {
    return result.buffer
  }

  // Some models return { image: base64string } or similar object
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>
    // Handle { image: base64 } response
    if (typeof obj.image === 'string') {
      const binary = atob(obj.image)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }
    if (obj.image instanceof ArrayBuffer) return obj.image
    if (obj.image instanceof Uint8Array) return obj.image.buffer
    if (obj.image instanceof ReadableStream) return toArrayBuffer(obj.image)

    const keys = Object.keys(obj).join(',')
    throw new Error(`Workers AI image: object with keys [${keys}], image type: ${typeof obj.image}`)
  }

  throw new Error(`Workers AI image: unexpected type ${typeof result} / ${Object.prototype.toString.call(result)}`)
}

export interface SafetyResult {
  safe: boolean
  categories?: string[]
}

export async function runLlamaGuard(
  ai: Ai,
  text: string
): Promise<SafetyResult> {
  const result = await withTimeout(
    ai.run(LLAMA_GUARD_MODEL as Parameters<Ai['run']>[0], {
      messages: [{ role: 'user', content: text }],
    }),
    GUARD_TIMEOUT_MS,
    'Workers AI safety (llama-guard)',
  )

  if (typeof result === 'object' && result !== null && 'response' in result) {
    const response = (result as { response: string }).response
    const safe = response.trim().toLowerCase().startsWith('safe')
    return { safe, categories: safe ? [] : [response] }
  }

  // If we can't parse, assume safe (fail open for content generation)
  return { safe: true }
}
