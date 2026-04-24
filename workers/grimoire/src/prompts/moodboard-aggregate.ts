// Moodboard aggregation prompt.
// v0: implementer's draft. Will be revised after observing 5-10 real moodboard outputs.
// The hard job of this prompt is semantic clustering across IRs -- collapsing near-synonym atoms
// into single aggregates while preserving the source_atom_names for provenance.

export const MOODBOARD_AGGREGATE_PROMPT_VERSION = 'v0'

export interface AggregateSourceIR {
  source_url: string
  source_attribution?: string | null
  artist_attribution?: string | null
  candidate_atoms: Array<{
    name: string
    description: string
    suggested_category: string
    utility: string
    modality: string
    confidence: number
  }>
  candidate_correspondences: Array<{
    source_name: string
    target_name: string
    relationship: string
    suggested_strength: number
  }>
}

export interface AggregateThresholds {
  invariant: number
  vectorLower: number
  lowFreqUpper: number
}

export interface BuildAggregatePromptArgs {
  moodboard_id: string
  source: string
  slug: string
  title: string | null
  source_description: string | null
  analyses: AggregateSourceIR[]
  categories: Array<{ slug: string; label: string }>
  thresholds: AggregateThresholds
}

export function buildMoodboardAggregatePrompt(args: BuildAggregatePromptArgs): string {
  const { moodboard_id, source, slug, title, source_description, analyses, categories, thresholds } = args

  const categoryList = categories.map((c) => `  ${c.slug} (${c.label})`).join('\n')
  const sourceCount = analyses.length

  const irsJson = JSON.stringify(
    analyses.map((ir, idx) => ({
      index: idx,
      source_url: ir.source_url,
      artist: ir.artist_attribution ?? null,
      atoms: ir.candidate_atoms.map((a) => ({
        name: a.name,
        description: a.description,
        suggested_category: a.suggested_category,
        utility: a.utility,
        modality: a.modality,
        confidence: a.confidence,
      })),
      correspondences: ir.candidate_correspondences.map((c) => ({
        source: c.source_name,
        target: c.target_name,
        relationship: c.relationship,
        strength: c.suggested_strength,
      })),
    })),
    null,
    2,
  )

  return `You are a moodboard synthesizer for the Grimoire, a structured knowledge graph of visual vocabulary.

You are given ${sourceCount} per-image analyses from a single moodboard representing one coherent aesthetic. Your job is to synthesize these per-image IRs into ONE aggregate IR that captures the moodboard-level invariants, vectors, and low-frequency elements.

## Moodboard

- moodboard_id: ${moodboard_id}
- source: ${source}
- slug: ${slug}
- title: ${title ?? slug}
- source_description: ${source_description ?? '(none)'}

## Your hardest job: semantic clustering

Per-image IRs contain near-synonymous atoms that refer to the same underlying visual concept. Collapse them. Examples:

- "soft natural lighting" + "diffused window light" + "golden hour glow" -> ONE invariant named e.g. "diffused warm natural light"
- "floral print dress" + "liberty print blouse" + "sprigged cotton" -> ONE atom e.g. "small-scale floral cotton prints"
- "stone cottage" + "thatched cottage" + "rural dwelling" -> ONE atom e.g. "vernacular rural cottage"

For every aggregate atom, populate \`source_atom_names\` with the ORIGINAL atom names from the per-image IRs that you collapsed into it. Do not invent names for the source list -- use the exact strings from the input.

## Bucketing rule (strict)

Compute frequency as: (number of source IRs that contain at least one atom collapsed into this aggregate) / ${sourceCount}.

- frequency >= ${thresholds.invariant} -> put in \`invariants\` (present in >= ${Math.ceil(thresholds.invariant * sourceCount)} of ${sourceCount})
- frequency >= ${thresholds.vectorLower} AND frequency < ${thresholds.invariant} -> put in \`vectors\` (present in >= ${Math.ceil(thresholds.vectorLower * sourceCount)} of ${sourceCount})
- frequency <= ${thresholds.lowFreqUpper} -> put in \`low_frequency_elements\` (present in <= ${Math.floor(thresholds.lowFreqUpper * sourceCount)} of ${sourceCount})
- Atoms in the transitional band (frequency between ${thresholds.lowFreqUpper} and ${thresholds.vectorLower}) are DROPPED.

## Available categories

Each aggregate atom's \`suggested_category\` must be exactly one of these slugs. If none fit, use 'uncategorized'. Do not invent slugs.

${categoryList}

## Output schema (return JSON only, no prose, no markdown fences)

{
  "moodboard_id": "${moodboard_id}",
  "source": "${source}",
  "slug": "${slug}",
  "source_count": ${sourceCount},
  "source_description": "...",
  "source_ir_keys": [],
  "gestalt": "1-3 sentence synthesized description of the overarching aesthetic. Identify era, primary medium/setting, and emotional resonance. Do NOT list atoms; this is prose synthesis.",
  "palette": {
    "dominant": ["color name", "..."],
    "accents": ["color name", "..."],
    "lighting_summary": "free-form description"
  },
  "invariants": [
    {
      "name": "canonical aggregate atom name",
      "description": "what it is and how it manifests across the moodboard",
      "suggested_category": "valid category slug",
      "utility": "directive | modifier | descriptor",
      "modality": "visual | narrative | both",
      "frequency": 0.89,
      "mean_confidence": 0.86,
      "source_atom_names": ["original atom name from IR n", "..."]
    }
  ],
  "vectors": [ /* same shape as invariants */ ],
  "low_frequency_elements": [
    {
      /* same shape as invariants, plus: */
      "note": "single source, may be noise or intentional contrast"
    }
  ],
  "aggregated_correspondences": [
    {
      "target_name": "Grimoire entry name from per-image correspondences",
      "source_atom_names": ["aggregated atom names that pointed at this target"],
      "frequency": 0.67,
      "mean_strength": 0.78
    }
  ],
  "compilation_hints": {
    "core_terms": ["short atom names from invariants"],
    "accent_terms": ["short atom names from vectors"],
    "negative_terms": ["terms the aesthetic explicitly avoids"],
    "compositional_notes": "free-form composition guidance"
  }
}

## Negative terms

\`compilation_hints.negative_terms\` is your inference about what this aesthetic explicitly avoids, derived from the gestalt and invariants. Cottagecore implies negation of "urban", "neon", "digital". Vaporwave implies negation of "natural", "organic", "muted". Produce 3-8 negative terms as short single-word or short-phrase strings.

## Input IRs

${irsJson}

## Final rules

- Return ONLY valid JSON matching the schema above. No markdown fences. No commentary. Start with \`{\` and end with \`}\`.
- Every aggregate atom must include \`source_atom_names\` populated from the input IRs.
- All \`frequency\` values must be in [0, 1].
- All \`suggested_category\` values must be slugs from the category list above.
- \`source_count\` must equal ${sourceCount}.
`
}
