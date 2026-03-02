# Task Brief 04: Image Ingest Path

## Depends On

Task 01 (auto-processing) should be complete so extracted atoms get classified and vectorized automatically. Task 02 (embedding fix) is recommended but not blocking.

## Problem

The Grimoire has 5 ingest paths: URL knowledge ingest, direct atom, discovery queue, batch admin, document chunking. None handles images. When a user uploads moodboard reference images to StyleFusion, the system has no way to:

1. Classify the image against known aesthetics/arrangements
2. Extract visual atoms from the image
3. Store the image as a source with provenance links to its atoms
4. Use per-image classification during multi-reference blending

This is the root cause of the moodboard blend failure: four aesthetic moodboards were fed through IR extraction (designed for single scenes) instead of being classified and decomposed individually.

## Solution

Add a sixth ingest path: image analysis via Gemini Vision. Two capabilities:

**A. Classify**: Given an image, return ranked arrangement matches and aesthetic tags.
**B. Extract**: Given an image, extract visual atoms, create a source record, and link atoms to source.

### New Tables

Migration file: `migrations/XXXX_image_sources.sql`

```sql
-- Sources: reference images, moodboards, and other visual media
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('moodboard', 'reference', 'generation', 'document')),
  filename TEXT,
  mime_type TEXT,
  r2_key TEXT,              -- grimoire/sources/images/{id}.{ext}
  source_url TEXT,          -- if fetched from web
  metadata TEXT DEFAULT '{}',  -- JSON: Gemini analysis output
  aesthetic_tags TEXT DEFAULT '[]',  -- JSON: classified aesthetic/arrangement names
  arrangement_matches TEXT DEFAULT '[]',  -- JSON: [{slug, score}]
  harmonic_profile TEXT DEFAULT '{}',  -- JSON: derived harmonic signature
  atom_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);

-- Junction: which atoms were extracted from which sources
CREATE TABLE IF NOT EXISTS source_atoms (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
  confidence REAL DEFAULT 1.0,
  extraction_method TEXT DEFAULT 'gemini_vision',  -- gemini_vision | text_extraction | manual
  PRIMARY KEY (source_id, atom_id)
);

CREATE INDEX IF NOT EXISTS idx_source_atoms_source ON source_atoms(source_id);
CREATE INDEX IF NOT EXISTS idx_source_atoms_atom ON source_atoms(atom_id);
```

### Gemini Vision Analysis

The classification endpoint sends the image to Gemini and asks for structured analysis. The prompt needs to return data that maps to existing Grimoire structures.

```typescript
const IMAGE_ANALYSIS_PROMPT = `You are a visual aesthetics analyst for a creative vocabulary system.

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
    { "text": "CRT scanlines", "category_hint": "effect.post" },
    ...
  ],
  "color_atoms": [
    { "text": "electric cyan", "category_hint": "color.palette" },
    ...
  ],
  "material_atoms": [
    { "text": "brushed chrome", "category_hint": "covering.material" },
    ...
  ],
  "atmospheric_atoms": [
    { "text": "retrofuturist nostalgia", "category_hint": "narrative.mood" },
    ...
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
- arrangement_matches.slug must be one of: ${ARRANGEMENT_SLUGS.join(', ')}
- Each atom should be 1-4 words
- Limit: 30 visual_atoms, 15 color_atoms, 15 material_atoms, 10 atmospheric_atoms
- For moodboards (grid collages of multiple images), analyze the OVERALL aesthetic, not individual panels
- confidence scores 0.0-1.0
- aesthetic_tags are freeform names (will be matched against known aesthetics)
`;
```

The `ARRANGEMENT_SLUGS` list comes from the 16 seeded arrangements. Gemini can only match against arrangements that exist. For unknown aesthetics, the `aesthetic_tags` field captures freeform names that can be mapped later.

### MCP Tool: grimoire_classify_image

```typescript
// Input: base64 image data or R2 key
// Output: classification results (no atoms created)
{
  name: 'grimoire_classify_image',
  description: 'Classify an image against known Grimoire arrangements and aesthetics. Returns ranked matches and extracted visual vocabulary. Does NOT create atoms; use grimoire_ingest_image for that.',
  inputSchema: {
    type: 'object',
    properties: {
      r2_key: { type: 'string', description: 'R2 key for an already-uploaded image' },
      image_url: { type: 'string', description: 'Public URL of an image to analyze' },
      image_base64: { type: 'string', description: 'Base64-encoded image data' },
      mime_type: { type: 'string', description: 'Image MIME type (image/png, image/jpeg)', default: 'image/png' }
    }
    // One of r2_key, image_url, or image_base64 required
  }
}
```

### MCP Tool: grimoire_ingest_image

```typescript
// Input: image + metadata
// Output: source record + created atoms + arrangement matches
{
  name: 'grimoire_ingest_image',
  description: 'Analyze an image, extract visual atoms, and store as a Grimoire source with provenance links. Atoms are created as provisional and will be auto-classified and vectorized.',
  inputSchema: {
    type: 'object',
    properties: {
      r2_key: { type: 'string', description: 'R2 key for an already-uploaded image' },
      image_url: { type: 'string', description: 'Public URL of an image to analyze' },
      image_base64: { type: 'string', description: 'Base64-encoded image data' },
      mime_type: { type: 'string', default: 'image/png' },
      type: { type: 'string', enum: ['moodboard', 'reference', 'generation'], default: 'reference' },
      filename: { type: 'string', description: 'Original filename for reference' },
      collection_slug: { type: 'string', description: 'Override collection for extracted atoms' },
      dry_run: { type: 'boolean', default: false }
    }
  }
}
```

### Processing Flow

```
Image input (base64, URL, or R2 key)
    ↓
Gemini 3 Flash Vision analysis
    ↓
Parse structured response
    ↓
Match arrangement_matches against arrangements table
    ↓
For each extracted atom:
    - Dedup check against existing atoms (text_lower match)
    - If new: insert as provisional via existing ingestAtom()
    - Create source_atoms junction record
    ↓
Create sources table record with:
    - Full Gemini analysis in metadata
    - Matched arrangements in arrangement_matches
    - Harmonic profile
    - Aesthetic tags
    - atom_count
    ↓
If image_url or base64: upload to R2 at grimoire/sources/images/{id}.{ext}
    ↓
Return: source record + atom list + arrangement matches
```

### REST Endpoints

On the HobBot worker (where the other ingest endpoints live):

```
POST /api/v1/sources/classify   -- Classify only, no atoms created
POST /api/v1/sources/ingest     -- Full ingest with atom extraction
GET  /api/v1/sources/:id        -- Get source with linked atoms and classifications
GET  /api/v1/sources            -- List sources with filters (type, arrangement)
```

### Gemini Vision Call

```typescript
async function analyzeImage(
  env: Env,
  imageData: { base64: string; mimeType: string },
  arrangementSlugs: string[]
): Promise<ImageAnalysis> {
  const prompt = buildImageAnalysisPrompt(arrangementSlugs);
  
  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/hobfarm/google-ai-studio/v1beta/models/gemini-2.0-flash:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: imageData.mimeType,
                data: imageData.base64
              }
            }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      })
    }
  );
  
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text) as ImageAnalysis;
}
```

**Note:** Check which Gemini model name is current. The existing knowledge ingest uses Gemini 2.5 Flash. For vision, you may want Gemini 3 Flash or whichever model is currently deployed for image analysis. Match the existing pattern in the grimoire worker's Gemini calls.

## StyleFusion Integration (Future)

Once this is built, StyleFusion's blend pipeline can call `POST /api/v1/sources/classify` for each reference image before IR extraction. The blend object in the IR gets enriched:

```json
{
  "blend": {
    "sources": [
      {
        "reference_type": "style",
        "weight": 1,
        "grimoire_source_id": "abc123",
        "arrangement_matches": [
          { "slug": "synthwave", "confidence": 0.85 },
          { "slug": "cyberpunk", "confidence": 0.70 }
        ],
        "aesthetic_tags": ["arcadecore", "vaporwave"],
        "contributed_atoms": ["neon glow", "CRT scanlines", "electric cyan"]
      }
    ]
  }
}
```

This is the bridge between the moodboard classification and the slot-level composition. It's a StyleFusion-side change (not part of this brief) but the Grimoire endpoints this brief creates are what StyleFusion will call.

## Verification

1. Upload a moodboard image to R2 manually: `cdn.hob.farm/grimoire/sources/images/test-arcade.jpg`
2. Call `grimoire_classify_image(r2_key: "grimoire/sources/images/test-arcade.jpg")`
3. Verify: arrangement_matches includes relevant arrangements, visual_atoms are sensible
4. Call `grimoire_ingest_image(r2_key: "grimoire/sources/images/test-arcade.jpg", type: "moodboard")`
5. Verify: source record created, atoms created (check via grimoire_search), source_atoms junction populated
6. Call `grimoire_classify_image` with a different image (e.g., the ska moodboard)
7. Verify: different arrangement matches, different atoms

## Files Changed

| File | Action |
|------|--------|
| New migration SQL file | NEW: sources + source_atoms tables |
| New state layer file (state/sources.ts) | NEW: CRUD for sources + source_atoms |
| New service file (services/image-analysis.ts) | NEW: Gemini Vision call + processing |
| GrimoireHandle | MODIFY: Add source methods |
| MCP server | MODIFY: Add 2 new tools (27 total) |
| API routes | MODIFY: Add 4 new endpoints |

## Tool Count After This Task

25 existing + 2 new = **27 MCP tools total**
