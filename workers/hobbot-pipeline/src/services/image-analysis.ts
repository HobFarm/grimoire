// Image Analysis Pipeline: vision classification + atom extraction
// Primary: Llama 4 Scout (Workers AI, edge-native, zero external HTTP)
// Fallback: Gemini Flash -> Gemini Flash-Lite (raw fetch with inline_data multimodal)

import { resolveApiKey } from '@shared/providers'

interface ImageAnalysisEnv {
  GEMINI_API_KEY: string | { get: () => Promise<string> }
  GRIMOIRE_DB: D1Database
  AI: Ai
}

export interface ImageInput {
  image_base64?: string
  image_url?: string
  r2_key?: string
  mime_type?: string
}

export interface ImageAnalysis {
  image_type: string
  aesthetic_tags: string[]
  arrangement_matches: ArrangementMatch[]
  visual_atoms: AtomExtraction[]
  color_atoms: AtomExtraction[]
  material_atoms: AtomExtraction[]
  atmospheric_atoms: AtomExtraction[]
  harmonic_profile: HarmonicProfile
  dominant_colors: string[]
  description: string
}

export interface ArrangementMatch {
  slug: string
  confidence: number
  reasoning: string
}

export interface AtomExtraction {
  text: string
  category_hint: string
}

export interface HarmonicProfile {
  hardness: number      // 0.0 (soft) to 1.0 (hard)
  temperature: number   // 0.0 (cool) to 1.0 (warm)
  weight: number        // 0.0 (light) to 1.0 (heavy)
  formality: number     // 0.0 (organic) to 1.0 (structured)
  era_affinity: number  // 0.0 (ancient) to 1.0 (futuristic)
}

// ---- Constants ----

import { MODELS } from '@shared/models'

const IMAGE_FETCH_TIMEOUT_MS = 15_000

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

// ---- Image Resolution ----

async function resolveImageData(input: ImageInput): Promise<{ base64: string; mimeType: string }> {
  if (input.image_base64) {
    let base64 = input.image_base64
    const dataUriMatch = base64.match(/^data:([^;]+);base64,(.+)$/)
    if (dataUriMatch) {
      return { base64: dataUriMatch[2], mimeType: dataUriMatch[1] }
    }
    return { base64, mimeType: input.mime_type ?? 'image/jpeg' }
  }

  let url: string
  if (input.image_url) {
    url = input.image_url
  } else if (input.r2_key) {
    url = `https://cdn.hob.farm/${input.r2_key}`
  } else {
    throw new Error('One of image_base64, image_url, or r2_key is required')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HobBot-Grimoire/1.0 (image-analysis)' },
    })

    if (!response.ok) {
      throw new Error(`Image fetch failed: HTTP ${response.status} ${response.statusText} from ${url}`)
    }

    const contentType = response.headers.get('Content-Type') ?? ''
    if (!contentType.startsWith('image/')) {
      throw new Error(`Expected image Content-Type, got "${contentType}" from ${url}`)
    }

    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer)

    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const base64 = btoa(binary)

    return { base64, mimeType: contentType.split(';')[0].trim() }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ---- Prompt Construction ----

function buildImagePrompt(arrangementSlugs: string[]): string {
  return `You are a visual aesthetics analyst for a creative vocabulary system called the Grimoire.

Analyze this image and return structured JSON with the following fields:

{
  "image_type": "moodboard" | "photograph" | "illustration" | "screenshot" | "collage" | "other",
  "aesthetic_tags": ["arcadecore", "vaporwave", "2000s anime", ...],
  "arrangement_matches": [
    { "slug": "cyberpunk", "confidence": 0.85, "reasoning": "neon lighting, urban environment" },
    { "slug": "synthwave", "confidence": 0.70, "reasoning": "retro-future color palette" }
  ],
  "visual_atoms": [
    { "text": "neon glow", "category_hint": "lighting.source" },
    { "text": "CRT scanlines", "category_hint": "effect.post" }
  ],
  "color_atoms": [
    { "text": "electric cyan", "category_hint": "color.palette" }
  ],
  "material_atoms": [
    { "text": "brushed chrome", "category_hint": "covering.material" }
  ],
  "atmospheric_atoms": [
    { "text": "retrofuturist nostalgia", "category_hint": "narrative.mood" }
  ],
  "harmonic_profile": {
    "hardness": "hard" | "soft" | "neutral",
    "temperature": "warm" | "cool" | "neutral",
    "weight": "heavy" | "light" | "neutral",
    "formality": "structured" | "organic" | "neutral",
    "era_affinity": "archaic" | "industrial" | "modern" | "timeless"
  },
  "dominant_colors": ["#FF00FF", "#00FFFF", "#1A1A2E"],
  "description": "Brief visual description of the image"
}

RULES:
- arrangement_matches.slug must be one of: ${arrangementSlugs.join(', ')}
- Each atom text should be 1-4 words
- Limits: max 30 visual_atoms, 15 color_atoms, 15 material_atoms, 10 atmospheric_atoms
- For moodboards (grid collages of multiple images), analyze the OVERALL aesthetic, not individual panels
- confidence scores 0.0-1.0
- aesthetic_tags are freeform names (will be matched against known aesthetics)
- category_hint should follow the pattern "parent.child" matching visual vocabulary categories`
}

// ---- JSON Sanitization ----

function sanitizeJson(raw: string): string {
  let cleaned = raw.trim()
  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  // Strip think blocks (Llama 4 Scout may produce them)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // Find first JSON object if wrapped in text
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      cleaned = cleaned.slice(start, end + 1)
    }
  }
  return cleaned
}

// ---- Arrangement Slug Loader ----

async function getArrangementSlugs(db: D1Database): Promise<string[]> {
  const result = await db.prepare('SELECT slug FROM arrangements ORDER BY slug').all<{ slug: string }>()
  return (result.results ?? []).map(r => r.slug)
}

// ---- Workers AI Vision Helper ----

/**
 * Call Workers AI vision model via OpenAI-compatible messages format.
 * Uses image_url content blocks with base64 data URIs.
 */
async function callWorkersAIVision(
  ai: Ai,
  model: string,
  prompt: string,
  imageData: { base64: string; mimeType: string },
): Promise<ImageAnalysis> {
  const result = await (ai as any).run(model, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
  })

  // Handle both response formats (legacy .response and OpenAI .choices)
  let text: string
  if (typeof result === 'object' && result !== null) {
    if ('response' in result) {
      text = (result as { response: string }).response
    } else if ('choices' in result) {
      const choices = (result as { choices: Array<{ message: { content: string } }> }).choices
      text = choices?.[0]?.message?.content ?? ''
    } else {
      throw new Error('Workers AI vision returned unexpected response shape')
    }
  } else {
    throw new Error('Workers AI vision returned non-object response')
  }

  console.log(`[image-analysis] workers-ai/${model}: response=${text.length} chars`)
  return JSON.parse(sanitizeJson(text)) as ImageAnalysis
}

// ---- Gemini Vision Helper ----

/**
 * Call Gemini Vision API with inline_data (multimodal).
 * Separate from Workers AI because Gemini uses a different multipart format.
 */
async function callGeminiVision(
  model: string,
  geminiKey: string,
  prompt: string,
  imageData: { base64: string; mimeType: string },
): Promise<{ analysis: ImageAnalysis; inputTokens: number; outputTokens: number }> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiKey,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: imageData.mimeType,
              data: imageData.base64,
            },
          },
        ],
      }],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini Vision (${model}): ${response.status} ${response.statusText} - ${errorText.slice(0, 300)}`)
  }

  const data = await response.json() as {
    candidates?: { content: { parts: { text: string; thought?: boolean }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error(`Gemini Vision (${model}): no candidates returned`)
  }

  const parts = data.candidates[0].content.parts
  const responsePart = parts.filter(p => !p.thought).pop() ?? parts[parts.length - 1]

  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0

  const analysis = JSON.parse(sanitizeJson(responsePart.text)) as ImageAnalysis
  return { analysis, inputTokens, outputTokens }
}

// ---- Main Analysis Function ----

export async function analyzeImage(env: ImageAnalysisEnv, input: ImageInput): Promise<ImageAnalysis> {
  const imageData = await resolveImageData(input)
  console.log(`[image-analysis] resolved image: ${imageData.mimeType}, ${Math.round(imageData.base64.length * 0.75 / 1024)}KB`)

  const arrangementSlugs = await getArrangementSlugs(env.GRIMOIRE_DB)
  const prompt = buildImagePrompt(arrangementSlugs)
  const geminiKey = await resolveApiKey(env.GEMINI_API_KEY)

  const config = MODELS['image.analyze']
  const models = [config.primary, ...config.fallbacks]

  let lastError: Error | null = null
  for (const entry of models) {
    try {
      let analysis: ImageAnalysis

      if (entry.provider === 'workers-ai') {
        analysis = await callWorkersAIVision(env.AI, entry.model, prompt, imageData)
      } else {
        const result = await callGeminiVision(entry.model, geminiKey, prompt, imageData)
        console.log(`[image-analysis] gemini/${entry.model}: tokens=${result.inputTokens}+${result.outputTokens}`)
        analysis = result.analysis
      }

      // Validate arrangement slugs against known set
      if (analysis.arrangement_matches && arrangementSlugs.length > 0) {
        analysis.arrangement_matches = analysis.arrangement_matches.filter(
          m => arrangementSlugs.includes(m.slug)
        )
      }

      console.log(`[image-analysis] success: provider=${entry.provider} model=${entry.model}`)
      return analysis
    } catch (err) {
      lastError = err as Error
      console.warn(`[image-analysis] ${entry.provider}/${entry.model} failed: ${lastError.message.slice(0, 200)}`)
    }
  }

  throw lastError ?? new Error('All image analysis models failed')
}
