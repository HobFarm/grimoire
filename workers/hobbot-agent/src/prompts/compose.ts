import { HOBBOT_CHARACTER_BRIEF } from './character'
import type { CuratedAtom, ArrangementDetail } from '../pipeline/curate'

export interface ComposeContext {
  atoms: CuratedAtom[]
  visualAtoms?: CuratedAtom[]
  knowledge?: string
  signals?: string
  recentPosts: string[]
  thread?: { name: string; description?: string; postsCount: number } | null
  theme?: string
  arrangement?: {
    name: string
    slug: string
    styleGuidance: string
    harmonicProfile?: Record<string, number>
  }
}

function formatHarmonics(h: Record<string, number>): string {
  const labels: Record<string, [string, string]> = {
    hardness: ['soft/organic', 'hard/geometric'],
    temperature: ['cool/clinical', 'warm/intimate'],
    weight: ['light/airy', 'heavy/dense'],
    formality: ['casual/raw', 'formal/refined'],
    era_affinity: ['ancient/historical', 'contemporary/futuristic'],
  }
  return Object.entries(h)
    .filter(([k]) => labels[k])
    .map(([k, v]) => {
      const [low, high] = labels[k]
      const direction = v < 0.35 ? low : v > 0.65 ? high : 'balanced'
      return `  ${k}: ${v.toFixed(2)} (${direction})`
    })
    .join('\n')
}

export function buildComposePrompt(ctx: ComposeContext): string {
  const sections: string[] = []

  sections.push(HOBBOT_CHARACTER_BRIEF)

  if (ctx.theme) {
    sections.push(`TODAY'S THEME: ${ctx.theme}`)
  }

  if (ctx.arrangement) {
    let styleBlock = `VISUAL STYLE: ${ctx.arrangement.name}\n`
    styleBlock += `This post uses ${ctx.arrangement.name} style. Your visualDirection MUST reflect this:\n`
    styleBlock += ctx.arrangement.styleGuidance + '\n'

    if (ctx.arrangement.harmonicProfile) {
      styleBlock += '\nHarmonic profile (use this to calibrate tone and word choices):\n'
      styleBlock += formatHarmonics(ctx.arrangement.harmonicProfile) + '\n'
    }

    styleBlock += 'The image should look like a single-panel cartoon or illustration in this style, NOT a photograph.'
    sections.push(styleBlock)
  }

  if (ctx.atoms.length > 0) {
    const atomList = ctx.atoms
      .slice(0, 15)
      .map((a) => {
        let line = `- ${a.text} [${a.category_slug}]`
        if (a.observation) line += ` (${a.observation})`
        if (a.score && a.score > 0.8) line += ' *high relevance*'
        return line
      })
      .join('\n')
    sections.push(`GRIMOIRE KNOWLEDGE (semantically relevant concepts, ranked by relevance):\n${atomList}`)
  }

  if (ctx.knowledge) {
    sections.push(`RESEARCH CONTEXT:\n${ctx.knowledge}`)
  }

  if (ctx.signals) {
    sections.push(`AUDIENCE SIGNALS (what's resonating right now):\n${ctx.signals}`)
  }

  if (ctx.thread) {
    sections.push(
      `NARRATIVE THREAD: "${ctx.thread.name}" (${ctx.thread.postsCount} posts so far)` +
      (ctx.thread.description ? `\n${ctx.thread.description}` : '') +
      '\nContinue this thread naturally. Reference or build on the thread direction.'
    )
  }

  if (ctx.recentPosts.length > 0) {
    sections.push(
      `RECENT POSTS (avoid repeating these):\n${ctx.recentPosts.map((p) => `- "${p}"`).join('\n')}`
    )
  }

  sections.push(
    'Generate a single post. Respond with valid JSON matching the OUTPUT FORMAT above. ' +
    'The text must be original, grounded in the concepts and knowledge provided, and distinct from recent posts. ' +
    'Write as genuine insight, not AI-generated content. No em dashes. No "here\'s the thing." No "let\'s talk about."'
  )

  return sections.join('\n\n---\n\n')
}
