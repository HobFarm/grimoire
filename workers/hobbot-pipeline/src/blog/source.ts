// Phase 1: resolve source material from queue row

import { createGrimoireHandle } from '@shared/grimoire/handle'
import type { BlogQueueRow, SourceResult } from './types'

export async function resolveSource(
  row: BlogQueueRow,
  hobbot: D1Database,
  grimoire: D1Database
): Promise<SourceResult> {
  const base = { content_type: row.content_type, category: row.category, channel: row.channel }

  switch (row.content_type) {
    case 'rss_analysis': {
      if (!row.source_ref) throw new Error('rss_analysis requires source_ref (feed_entries id)')
      const entry = await hobbot
        .prepare('SELECT id, entry_title, entry_url, grimoire_source_id FROM feed_entries WHERE id = ?')
        .bind(row.source_ref)
        .first<{ id: number; entry_title: string; entry_url: string; grimoire_source_id: string | null }>()
      if (!entry) throw new Error(`feed_entry not found: ${row.source_ref}`)

      let docSummary = ''
      if (entry.grimoire_source_id) {
        const doc = await grimoire
          .prepare('SELECT title, summary FROM documents WHERE id = ?')
          .bind(entry.grimoire_source_id)
          .first<{ title: string; summary: string | null }>()
        if (doc?.summary) docSummary = `\n\nDocument summary: ${doc.summary}`
      }

      return {
        ...base,
        sourceContent: `Article: ${entry.entry_title}\nURL: ${entry.entry_url}${docSummary}`,
        sourceMetadata: { entry_id: entry.id, entry_url: entry.entry_url, entry_title: entry.entry_title },
      }
    }

    case 'grimoire_spotlight': {
      if (!row.source_ref) throw new Error('grimoire_spotlight requires source_ref (atom text/term)')
      const handle = createGrimoireHandle(grimoire)
      const result = await handle.correspondences(row.source_ref, 2)
      if (!result || !result.atom?.id) throw new Error(`atom not found in Grimoire: ${row.source_ref}`)

      const corrLines = result.correspondences
        .slice(0, 10)
        .map(c => `  - ${c.atom_b_id === result.atom.id ? c.atom_a_id : c.atom_b_id} (${c.relationship_type})`)
        .join('\n')

      const siblingsLine = result.category_siblings
        .slice(0, 5)
        .map(s => s.text)
        .join(', ')

      return {
        ...base,
        sourceContent: [
          `Grimoire atom: ${result.atom.text}`,
          `Category: ${result.atom.category_slug ?? 'unknown'}`,
          corrLines ? `\nTop correspondences:\n${corrLines}` : '',
          siblingsLine ? `\nCategory siblings: ${siblingsLine}` : '',
        ].filter(Boolean).join('\n'),
        sourceMetadata: { atom_id: result.atom.id, atom_text: result.atom.text, correspondences: result.correspondences.length },
      }
    }

    case 'project_update':
    case 'industry_commentary':
    case 'tutorial': {
      const topic = row.source_ref ?? row.category
      return {
        ...base,
        sourceContent: `Topic: ${topic}\nContent type: ${row.content_type}\nCategory: ${row.category}`,
        sourceMetadata: { topic },
      }
    }
  }
}
