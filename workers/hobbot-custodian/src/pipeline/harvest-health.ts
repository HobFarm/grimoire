// Harvest health check: pipeline status for any collection's atoms

export interface HarvestHealthReport {
  collection_slug: string
  total_atoms: number
  by_status: { provisional: number; confirmed: number; rejected: number }
  pipeline_stages: {
    classified: number
    embedded: number
    harmonized: number
    tagged: number
    fully_processed: number
  }
  metadata_sample: { id: string; text: string; metadata: string | null }[]
  correspondence_count: number
  generated_at: string
}

export async function buildHarvestHealthReport(
  db: D1Database,
  collectionSlug: string
): Promise<HarvestHealthReport> {
  const base = 'SELECT COUNT(*) as n FROM atoms WHERE collection_slug = ?'

  const [
    total,
    provisional,
    confirmed,
    rejected,
    classified,
    embedded,
    harmonized,
    tagged,
    fullyProcessed,
    correspondences,
    samples,
  ] = await Promise.all([
    db.prepare(base).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND status = 'provisional'`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND status = 'confirmed'`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND status = 'rejected'`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND category_slug IS NOT NULL`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND embedding_status = 'complete'`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(`${base} AND tags IS NOT NULL AND tags != '[]'`).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(
      `${base} AND category_slug IS NOT NULL AND embedding_status = 'complete' AND harmonics IS NOT NULL AND LENGTH(harmonics) > 2 AND tags IS NOT NULL AND tags != '[]'`
    ).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(DISTINCT atom_a_id) as n FROM correspondences WHERE atom_a_id IN (SELECT id FROM atoms WHERE collection_slug = ?)`
    ).bind(collectionSlug).first<{ n: number }>(),
    db.prepare(
      'SELECT id, text, metadata FROM atoms WHERE collection_slug = ? ORDER BY created_at DESC LIMIT 5'
    ).bind(collectionSlug).all<{ id: string; text: string; metadata: string | null }>(),
  ])

  return {
    collection_slug: collectionSlug,
    total_atoms: total?.n ?? 0,
    by_status: {
      provisional: provisional?.n ?? 0,
      confirmed: confirmed?.n ?? 0,
      rejected: rejected?.n ?? 0,
    },
    pipeline_stages: {
      classified: classified?.n ?? 0,
      embedded: embedded?.n ?? 0,
      harmonized: harmonized?.n ?? 0,
      tagged: tagged?.n ?? 0,
      fully_processed: fullyProcessed?.n ?? 0,
    },
    metadata_sample: samples?.results ?? [],
    correspondence_count: correspondences?.n ?? 0,
    generated_at: new Date().toISOString(),
  }
}
