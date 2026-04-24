// Auto-process pending discovery queue items: dedup check, then accept or merge

import { listDiscoveries, resolveDiscovery } from '@shared/state/discovery'

export async function processDiscoveryQueue(db: D1Database): Promise<{ accepted: number; merged: number; failed: number }> {
  const pending = await listDiscoveries(db, { status: 'pending', limit: 20 })
  if (pending.length === 0) return { accepted: 0, merged: 0, failed: 0 }

  let accepted = 0, merged = 0, failed = 0

  for (const entry of pending) {
    const existing = await db.prepare(
      'SELECT id FROM atoms WHERE text_lower = ? LIMIT 1'
    ).bind(entry.term.toLowerCase().trim()).first<{ id: string }>()

    if (existing) {
      await resolveDiscovery(db, entry.id, {
        action: 'merge',
        duplicate_of_atom_id: existing.id,
        note: 'auto-merged: atom already exists',
      })
      merged++
      continue
    }

    try {
      const result = await resolveDiscovery(db, entry.id, {
        action: 'accept',
        collection_slug: entry.suggested_collection ?? 'uncategorized',
        category_slug: null, // let grimoire cron classify via Gemini
        observation: 'observation',
        confidence: 0.6,
        note: 'auto-accepted from discovery queue',
      })
      if (result.atom) {
        accepted++
      } else {
        failed++
      }
    } catch (e) {
      console.log(`[discovery] Failed to process ${entry.id}: ${e instanceof Error ? e.message : e}`)
      failed++
    }
  }

  return { accepted, merged, failed }
}
