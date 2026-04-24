// R2 analysis document storage for image extraction.
// Stores full extraction JSON alongside source images in the grimoire R2 bucket.

import type { CandidateAtom, CandidateCorrespondence } from './types'

const REF_HOST = 'ref.hob.farm'
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp)$/i

export interface AnalysisDocument {
  source_url: string
  source_attribution: string
  artist_attribution: string | null
  candidate_atoms: CandidateAtom[]
  candidate_correspondences: CandidateCorrespondence[]
  raw_analysis: string
  extraction_metadata: {
    model: string
    provider: string
    timestamp: string
    prompt_version: string
    duration_ms: number
    estimated_input_tokens: number
    estimated_output_tokens: number
  }
}

/** Derive R2 analysis key from a public image URL. */
export async function deriveAnalysisKey(imageUrl: string): Promise<string> {
  try {
    const url = new URL(imageUrl)
    if (url.hostname === REF_HOST) {
      const path = url.pathname.replace(/^\//, '')
      return path.replace(IMAGE_EXT_RE, '.analysis.json')
    }
  } catch {
    // not a valid URL, fall through to hash
  }
  return deriveAnalysisKeyFromHash(imageUrl)
}

/** Derive R2 analysis key from an R2 object key (simple extension swap). */
export function deriveAnalysisKeyFromR2Key(key: string): string {
  return key.replace(IMAGE_EXT_RE, '.analysis.json')
}

async function deriveAnalysisKeyFromHash(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)
  const hex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('')
  return `reference/external/${hex}.analysis.json`
}

/** Write analysis JSON to R2. */
export async function storeAnalysisJson(
  r2: R2Bucket,
  key: string,
  doc: AnalysisDocument,
): Promise<void> {
  await r2.put(key, JSON.stringify(doc, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  })
}

/** Convert ArrayBuffer to base64 string. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Check if an R2 key is an image file by extension. */
export function isImageKey(key: string): boolean {
  return IMAGE_EXT_RE.test(key)
}

/** Get MIME type from file extension. */
export function mimeTypeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    default:
      return 'image/jpeg'
  }
}
