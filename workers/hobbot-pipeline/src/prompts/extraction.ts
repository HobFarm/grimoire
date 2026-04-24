// Gemini extraction prompt templates for the knowledge ingest pipeline

export const AESTHETIC_EXTRACTION_PROMPT = `You are extracting structured creative vocabulary from a web page about a visual aesthetic, art style, or design movement. Extract ONLY terms that exist in the source text or are directly implied by it. Do not invent terms.

Extract the following categories:

1. aesthetic_name: The canonical name of the aesthetic or movement described on this page.

2. visual_atoms: Concrete visual descriptors. Things you can see, render, or photograph. Single terms or short 2-3 word phrases. Examples: "neon glow", "chrome surfaces", "wet asphalt", "holographic", "brutalist concrete". Max 30.

3. color_atoms: Specific colors, color relationships, or color moods mentioned. Examples: "deep magenta", "electric blue", "desaturated earth tones", "gold and black". Max 15.

4. material_atoms: Textures, materials, surface qualities. Examples: "brushed steel", "cracked leather", "iridescent fabric", "oxidized copper". Max 15.

5. atmospheric_phrases: Multi-word atmospheric descriptions that set a scene. These are longer than single atoms. Examples: "rain-slicked highway reflecting sodium vapor lights", "dust motes in cathedral light". Max 10.

6. related_aesthetics: Other named aesthetics referenced in or related to this one. For each, specify the relationship:
   - "parent": This aesthetic evolved FROM the related one
   - "child": The related aesthetic evolved FROM this one
   - "sibling": They share common ancestry or are peers
   - "influence": This aesthetic was influenced by the related one
   - "opposite": The related aesthetic is a stylistic opposite

7. harmonic_profile: The overall feel of this aesthetic across 5 dimensions, each a number from 0 to 1:
   - hardness: 0.0 = soft watercolor, flowing organic forms. 1.0 = sharp vector graphics, geometric metal/glass.
   - temperature: 0.0 = cold blues, steel, clinical, melancholy. 1.0 = warm golds, wood, firelight, nostalgic warmth, sunlit nature.
   - weight: 0.0 = airy, translucent, minimal, whitespace. 1.0 = dense, massive, claustrophobic, dark.
   - formality: 0.0 = hand-drawn, irregular, deliberately rough. 1.0 = geometric precision, corporate polish, grid systems.
   - era_affinity: 0.0 = ancient/pre-industrial (cave paintings, medieval manuscripts). 0.5 = mid-20th century. 1.0 = born-digital, internet-era, post-2000 technology. A 2000s-2010s digital design aesthetic should be 0.85-0.95.

Respond with ONLY a JSON object in this exact shape:
{
  "aesthetic_name": "string",
  "visual_atoms": ["term1", "term2"],
  "color_atoms": ["term1", "term2"],
  "material_atoms": ["term1", "term2"],
  "atmospheric_phrases": ["phrase1", "phrase2"],
  "related_aesthetics": [{"name": "aesthetic name", "relation": "parent|child|sibling|influence|opposite"}],
  "harmonic_profile": {"hardness": 0.5, "temperature": 0.5, "weight": 0.5, "formality": 0.5, "era_affinity": 0.5}
}`

export const DOMAIN_EXTRACTION_PROMPT = `You are extracting structured creative vocabulary from a web page about a topic, domain, or reference material. Extract ONLY terms that exist in the source text or are directly implied by it. Do not invent terms.

Extract the following categories:

1. topic_name: The main subject of this page.

2. visual_atoms: Concrete visual descriptors that could inform image generation. Things you can see or photograph. Examples: "weathered parchment", "brass instruments", "stone archways". Max 20.

3. conceptual_atoms: Abstract concepts, themes, or domain-specific vocabulary with narrative or creative value. Examples: "redemption", "entropy", "mise en scene", "chiaroscuro". Max 15.

4. atmospheric_phrases: Multi-word atmospheric or scene-setting descriptions. Examples: "fog creeping through broken stained glass", "the hum of fluorescent lights in empty corridors". Max 10.

5. proper_nouns: Named people, places, works, or movements that serve as style references. Examples: "Roger Deakins", "Blade Runner", "Bauhaus", "Shibuya Crossing". Max 15.

6. style_references: Named techniques, movements, or visual approaches referenced. Examples: "film noir", "Dutch angle", "long exposure", "cross-processing". Max 10.

Respond with ONLY a JSON object in this exact shape:
{
  "topic_name": "string",
  "visual_atoms": ["term1", "term2"],
  "conceptual_atoms": ["term1", "term2"],
  "atmospheric_phrases": ["phrase1", "phrase2"],
  "proper_nouns": ["name1", "name2"],
  "style_references": ["ref1", "ref2"]
}`
