// Input adapter: image -> NormalizedDocument
// Extracts from server.ts image handler: Gemini Vision analysis + R2 upload + doc creation

import { analyzeImage } from '../services/image-analysis'
import type { ImageInput, ImageAnalysis } from '../services/image-analysis'
import type { NormalizedDocument } from '@shared/rpc/pipeline-types'
import type { IngestFromImageParams } from '@shared/rpc/pipeline-types'

interface ImageAdapterEnv {
  GRIMOIRE_DB: D1Database
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  AI: Ai
  R2: R2Bucket
}

export interface ImageAdapterResult {
  doc: NormalizedDocument
  analysis: ImageAnalysis
  r2_key: string | null
  source_url: string | null
}

export async function fromImage(
  env: ImageAdapterEnv,
  params: IngestFromImageParams,
): Promise<ImageAdapterResult> {
  // 1. Analyze image via Gemini Vision
  const input: ImageInput = {
    image_base64: params.image_base64,
    image_url: params.image_url,
    r2_key: params.r2_key,
    mime_type: params.mime_type,
  }
  const analysis = await analyzeImage(env, input)

  // 2. R2 upload if base64 provided with no existing key
  let resolvedR2Key = params.r2_key ?? null
  let resolvedSourceUrl = params.image_url ?? null
  if (params.image_base64 && !params.r2_key) {
    const ext = (params.mime_type ?? 'image/jpeg').split('/')[1] ?? 'jpg'
    const imageId = crypto.randomUUID()
    resolvedR2Key = `grimoire/images/${imageId}.${ext}`
    const raw = params.image_base64.includes(',') ? params.image_base64.split(',')[1] : params.image_base64
    const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
    await env.R2.put(resolvedR2Key, bytes, { httpMetadata: { contentType: params.mime_type ?? 'image/jpeg' } })
    resolvedSourceUrl = `https://cdn.hob.farm/${resolvedR2Key}`
  }

  // 3. Build single content block from analysis
  const chunkContent = [
    analysis.description ?? '',
    analysis.aesthetic_tags?.length ? `Aesthetic tags: ${analysis.aesthetic_tags.join(', ')}` : '',
    analysis.dominant_colors?.length ? `Dominant colors: ${analysis.dominant_colors.join(', ')}` : '',
  ].filter(Boolean).join('\n\n')

  const doc: NormalizedDocument = {
    title: params.filename ?? `Image ${crypto.randomUUID().slice(0, 8)}`,
    content_blocks: [{
      heading: params.filename ?? 'Image Analysis',
      content: chunkContent,
      token_count: Math.ceil(chunkContent.length / 4),
    }],
    source_url: resolvedSourceUrl ?? undefined,
    source_type: 'aesthetic',
    mime_type: params.mime_type ?? 'image/jpeg',
    tags: ['image'],
    provenance: {
      adapter: 'image',
      image_r2_key: resolvedR2Key ?? undefined,
      collection_slug: params.collection_slug,
    },
  }

  return { doc, analysis, r2_key: resolvedR2Key, source_url: resolvedSourceUrl }
}
