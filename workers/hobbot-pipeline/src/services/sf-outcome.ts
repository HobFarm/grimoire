/**
 * StyleFusion Outcome Processor
 * Copied from HobBot/src/services/sf-outcome.ts - no logic changes, no import rewrites needed
 */

interface SfOutcomeResult {
  exported: number
  failed: number
}

interface SfOutcome {
  id: string
  generation_id: string
  arrangement: string | null
  render_mode: string | null
  target_provider: string | null
  model: string | null
  signal: string
  created_at: string
  ir: string
  gen_provider: string | null
  character_id: string | null
}

interface SfEnv {
  STYLEFUSION_URL?: string
  GRIMOIRE: Fetcher
}

export async function processStyleFusionOutcomes(env: SfEnv): Promise<SfOutcomeResult> {
  if (!env.STYLEFUSION_URL) {
    console.log('[sf-outcome] STYLEFUSION_URL not configured, skipping')
    return { exported: 0, failed: 0 }
  }

  let outcomes: SfOutcome[]
  try {
    const response = await fetch(`${env.STYLEFUSION_URL}/api/outcomes/unexported`)
    if (!response.ok) {
      console.log(`[sf-outcome] SF fetch failed: ${response.status}`)
      return { exported: 0, failed: 0 }
    }
    const data = await response.json<{ outcomes: SfOutcome[] }>()
    outcomes = data.outcomes ?? []
  } catch (err) {
    console.log(`[sf-outcome] SF fetch error: ${err}`)
    return { exported: 0, failed: 0 }
  }

  if (outcomes.length === 0) {
    return { exported: 0, failed: 0 }
  }

  console.log(`[sf-outcome] Processing ${outcomes.length} unexported outcomes`)

  let exported = 0
  let failed = 0

  for (const outcome of outcomes) {
    try {
      const ir = JSON.parse(outcome.ir)

      const pkg = {
        type: 'compilation_outcome',
        source_app: 'stylefusion',
        timestamp: outcome.created_at,
        compilation: {
          generation_id: outcome.generation_id,
          extraction_model: ir.meta?.extraction_model || 'unknown',
          generation_provider: outcome.target_provider || outcome.gen_provider || undefined,
          generation_model: outcome.model || undefined,
          ir_summary: {
            style_anchors: ir.style_anchors || [],
            description: ir.visual_dna?.description || '',
            palette_mood: ir.palette?.mood,
            rendering_medium: ir.rendering?.medium,
            aspect_ratio: ir.meta?.aspect_ratio,
          },
          arrangement: {
            slug: outcome.arrangement || 'none',
            score: 0,
            selection_path: 'auto-snap',
          },
          signal: outcome.signal,
          render_mode: outcome.render_mode || undefined,
          character_id: outcome.character_id || undefined,
        },
      }

      const grimoireResponse = await env.GRIMOIRE.fetch('https://grimoire/knowledge/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pkg),
      })

      if (grimoireResponse.ok) {
        await fetch(`${env.STYLEFUSION_URL}/api/outcomes/${outcome.id}/knowledge-exported`, {
          method: 'PATCH',
        })
        exported++
        console.log(`[sf-outcome] Exported ${outcome.generation_id}: ${outcome.signal}`)
      } else {
        console.log(`[sf-outcome] Grimoire ingest failed for ${outcome.generation_id}: ${grimoireResponse.status}`)
        failed++
      }
    } catch (err) {
      console.log(`[sf-outcome] Error processing ${outcome.generation_id}: ${err}`)
      failed++
    }
  }

  return { exported, failed }
}
