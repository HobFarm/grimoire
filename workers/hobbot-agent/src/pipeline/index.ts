// Content pipeline orchestrator with graceful degradation.
// Each phase can fail independently without aborting the pipeline,
// except: compose failure = abort, safety failure = abort.

import type { HobBotAgent } from '../agent'
import { createTokenLogger } from '@shared/providers/token-log'
import { gatherSignals, type Signal } from './signal'
import { retrieveKnowledge } from './knowledge'
import { curateAtoms, type CuratedAtom, type ArrangementDetail } from './curate'
import { composePost, type PostDraft } from './compose'
import { generateVisual } from './visualize'
import { validatePost } from './validate'
import { publishPost } from './post'

export interface PipelineResult {
  status: 'posted' | 'failed' | 'aborted'
  xPostId?: string
  imageUrl?: string | null
  phases: Record<string, { ok: boolean; durationMs: number; note?: string }>
}

async function timed<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now()
  const result = await fn()
  return { result, durationMs: Date.now() - start }
}

export async function runContentPipeline(agent: HobBotAgent): Promise<PipelineResult> {
  const phases: PipelineResult['phases'] = {}

  // Prevent DO eviction during pipeline execution
  if ('keepAlive' in agent && typeof agent.keepAlive === 'function') {
    (agent as unknown as { keepAlive: (ms: number) => void }).keepAlive(60_000)
  }

  const onUsage = agent.bindings.HOBBOT_DB
    ? createTokenLogger(agent.bindings.HOBBOT_DB, 'hobbot-agent')
    : undefined
  const callOpts = onUsage ? { onUsage } : undefined

  // Get next calendar slot (or use default theme)
  const calendarSlots = agent.sql<{
    id: string; theme: string | null; arrangement_slug: string | null
  }>`SELECT id, theme, arrangement_slug FROM calendar
    WHERE status = 'planned' AND scheduled_at <= datetime('now', '+1 hour')
    ORDER BY scheduled_at ASC LIMIT 1`

  const slot = calendarSlots.length > 0 ? calendarSlots[0] : null
  const theme = slot?.theme ?? 'noir industrial aesthetics'
  const calendarId = slot?.id ?? null

  if (calendarId) {
    agent.sql`UPDATE calendar SET status = 'generating' WHERE id = ${calendarId}`
  }

  // Phase 1: Signals (skip-safe)
  let signals: Signal[] = []
  try {
    const r = await timed('signal', () => gatherSignals(agent, callOpts))
    signals = r.result
    phases.signal = { ok: true, durationMs: r.durationMs, note: `${signals.length} signals` }
  } catch (e) {
    phases.signal = { ok: false, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
  }

  // Phase 2: Knowledge (skip-safe)
  let knowledge: Awaited<ReturnType<typeof retrieveKnowledge>> = null
  try {
    const signalSummary = signals.length > 0
      ? signals.map((s) => JSON.parse(s.data)?.summary).filter(Boolean).join('; ')
      : undefined
    const r = await timed('knowledge', () => retrieveKnowledge(agent, theme, signalSummary))
    knowledge = r.result
    phases.knowledge = { ok: !!knowledge, durationMs: r.durationMs }
  } catch (e) {
    phases.knowledge = { ok: false, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
  }

  // Phase 3: Curate atoms (skip-safe, uses generic theme if fails)
  let atoms: CuratedAtom[] = []
  let visualAtoms: CuratedAtom[] = []
  let arrangementDetail: ArrangementDetail | undefined
  try {
    const r = await timed('curate', () =>
      curateAtoms(agent.bindings.GRIMOIRE, theme, slot?.arrangement_slug ?? undefined)
    )
    atoms = r.result.atoms
    visualAtoms = r.result.visualAtoms
    arrangementDetail = r.result.arrangementDetail
    const note = `${atoms.length} content + ${visualAtoms.length} visual atoms` + (arrangementDetail ? `, arrangement: ${arrangementDetail.slug}` : '')
    phases.curate = { ok: atoms.length > 0, durationMs: r.durationMs, note }
  } catch (e) {
    phases.curate = { ok: false, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
  }

  // Phase 4: Compose (required, abort if fails)
  let draft: PostDraft | null = null
  try {
    const r = await timed('compose', () => composePost(agent, atoms, knowledge, signals, theme, arrangementDetail, callOpts))
    draft = r.result
    phases.compose = { ok: !!draft, durationMs: r.durationMs }
  } catch (e) {
    phases.compose = { ok: false, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
  }

  if (!draft) {
    if (calendarId) {
      agent.sql`UPDATE calendar SET status = 'failed' WHERE id = ${calendarId}`
    }
    return { status: 'aborted', phases }
  }

  // Phase 5: Visualize (skip-safe, post goes text-only if fails)
  let imageResult: { url: string; provider: string } | null = null
  try {
    const r = await timed('visualize', () => generateVisual(agent, draft!, arrangementDetail, visualAtoms))
    imageResult = r.result
    phases.visualize = { ok: !!imageResult, durationMs: r.durationMs }
  } catch (e) {
    phases.visualize = { ok: false, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
  }

  // Phase 6: Validate (safety abort, format retry once)
  let validation = await validatePost(agent, draft, imageResult?.url ?? null)
  phases.validate = {
    ok: validation.safe && validation.meetsFormat,
    durationMs: 0,
    note: validation.reasons.length > 0 ? validation.reasons.join('; ') : undefined,
  }

  if (!validation.safe) {
    if (calendarId) {
      agent.sql`UPDATE calendar SET status = 'failed' WHERE id = ${calendarId}`
    }
    return { status: 'aborted', phases }
  }

  // Retry compose once if format fails
  if (!validation.meetsFormat) {
    console.log('[pipeline] Format validation failed, retrying compose...')
    try {
      draft = await composePost(agent, atoms, knowledge, signals, theme, arrangementDetail)
      if (draft) {
        validation = await validatePost(agent, draft, imageResult?.url ?? null)
        if (!validation.meetsFormat) {
          if (calendarId) {
            agent.sql`UPDATE calendar SET status = 'failed' WHERE id = ${calendarId}`
          }
          return { status: 'aborted', phases }
        }
      } else {
        return { status: 'aborted', phases }
      }
    } catch {
      return { status: 'aborted', phases }
    }
  }

  // Phase 7: Post
  try {
    const r = await timed('post', () =>
      publishPost(agent, draft!, imageResult?.url ?? null, imageResult?.provider ?? null, calendarId)
    )
    phases.post = { ok: true, durationMs: r.durationMs, note: `x_post_id: ${r.result.xPostId}` }
    return { status: 'posted', xPostId: r.result.xPostId, imageUrl: imageResult?.url, phases }
  } catch (e) {
    phases.post = { ok: false, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
    if (calendarId) {
      agent.sql`UPDATE calendar SET status = 'failed' WHERE id = ${calendarId}`
    }
    return { status: 'failed', phases }
  }
}
