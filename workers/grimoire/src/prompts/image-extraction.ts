// Extraction prompt for fromImage adapter.
// V1: designed for iteration. Categories and atom names injected at runtime.
// This file is the primary surface for prompt quality tuning.

export const IMAGE_EXTRACTION_PROMPT_VERSION = 'v2'

export function buildImageExtractionPrompt(
  categories: Array<{ slug: string; label: string }>,
  sampleAtomNames: string[],
): string {
  const categoryList = categories.map(c => `  ${c.slug} (${c.label})`).join('\n')
  const atomSample = sampleAtomNames.length > 0
    ? sampleAtomNames.join(', ')
    : '(no existing atoms available)'

  return `You are a visual vocabulary analyst for the Grimoire, a structured knowledge graph of visual and creative terminology used by AI image generation systems.

Analyze this image and extract candidate vocabulary entries (atoms) and relationships (correspondences) suitable for the Grimoire.

## What the Grimoire needs

The Grimoire stores precise visual vocabulary, not art criticism. Each atom is a reusable creative building block: a technique, effect, motif, material, color relationship, or compositional pattern.

**Be specific, not generic.** Do not produce entries like "vibrant colors" or "dynamic composition." Instead describe the observable visual mechanics:
- "complementary hue pairs at high saturation in direct adjacency producing optical flicker"
- "radial symmetry with logarithmic spiral subdivision"
- "wet-on-wet pigment bleeding with controlled capillary spread"
- "figure-ground reversal through shared contour lines"

## Atom classification

For each candidate atom, classify it as one of:
- **technique**: How the visual effect is achieved (a method or process)
- **effect**: What the visual element does to the viewer's perception
- **motif**: A recurring visual element, symbol, or pattern
- **descriptor**: A quality, material, color relationship, or atmospheric property

Map each atom's utility field accordingly:
- technique -> "directive" (it instructs)
- effect -> "modifier" (it modifies perception)
- motif -> "descriptor" (it describes a visual element)
- descriptor -> "descriptor"

## Available categories

Each atom must have a suggested_category from this list. Pick the most specific match. You must use slugs exactly as they appear below. If no category fits, use 'uncategorized'. Do not invent new slugs.

${categoryList}

## Artist Attribution

If you can identify the specific artist, include their name. If the artist is not identifiable but the style is recognizable, name the school, movement, tradition, or cultural origin (e.g. "Ukiyo-e tradition", "Vienna Secession", "West Coast psychedelic poster art", "San Francisco Oracle aesthetic"). If genuinely unattributable, set to null.

## Correspondences

Identify relationships between your candidate atoms AND between candidates and these existing Grimoire atoms:

${atomSample}

Only propose correspondences where the visual relationship is directly observable in this image. Avoid metaphorical or cross-sensory connections. Do not force connections.

## Output format

Return a JSON object with exactly these fields:

{
  "source_attribution": "Artist name, title, date, medium, license/source if identifiable",
  "artist_attribution": "Specific artist name, or art school/movement/tradition if not identifiable to an individual. null if unknown.",
  "candidate_atoms": [
    {
      "name": "short name (1-5 words)",
      "description": "Dense visual description of what this atom represents, observed in this image. 1-3 sentences.",
      "suggested_category": "category.slug from the list above",
      "utility": "directive" | "modifier" | "descriptor",
      "modality": "visual" | "narrative" | "both",
      "confidence": 0.0-1.0
    }
  ],
  "candidate_correspondences": [
    {
      "source_name": "atom name (from candidates or existing atoms above)",
      "target_name": "atom name (from candidates or existing atoms above)",
      "relationship": "how they connect visually or conceptually in this image",
      "suggested_strength": 0.0-1.0
    }
  ]
}

## Rules

- Extract 5-20 candidate atoms depending on image complexity
- Each atom name should be 1-5 words, lowercase
- Descriptions must reference what is actually visible in the image, not inferred intent
- Confidence: 0.9+ for clearly identifiable techniques, 0.5-0.8 for interpretive elements, below 0.5 for uncertain
- Modality: "visual" for purely visual elements, "narrative" for conceptual/thematic, "both" for elements that are both
- Do not duplicate atoms that appear in the existing atom sample above; propose correspondences to them instead
- Prefer specific over general: "sgraffito layering" over "texture"
- Return valid JSON only, no markdown fences or explanatory text`
}
