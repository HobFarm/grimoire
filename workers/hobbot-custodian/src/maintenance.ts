// Maintenance functions for Grimoire atom lifecycle
// Extracted from hobbot-worker index.ts

// Promote provisional atoms that meet all quality gates:
// classified + embedded + harmonics assigned + arrangement-tagged
export async function promoteQualifiedAtoms(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    UPDATE atoms
    SET status = 'confirmed',
        updated_at = datetime('now')
    WHERE status = 'provisional'
      AND category_slug IS NOT NULL
      AND category_slug != ''
      AND embedding_status = 'complete'
      AND harmonics IS NOT NULL
      AND LENGTH(harmonics) > 2
      AND tag_version > 0
    LIMIT 5000
  `).run()
  return result.meta.changes ?? 0
}

// Fix stale/null tier values on confirmed atoms
export async function recalculateTiers(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    UPDATE atoms SET tier = CASE
      WHEN EXISTS (SELECT 1 FROM exemplars WHERE atom_id = atoms.id)
       AND EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
      THEN 1
      WHEN EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
      THEN 2
      ELSE 3
    END
    WHERE status = 'confirmed'
      AND (tier IS NULL OR tier != CASE
        WHEN EXISTS (SELECT 1 FROM exemplars WHERE atom_id = atoms.id)
         AND EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
        THEN 1
        WHEN EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
        THEN 2
        ELSE 3
      END)
    LIMIT 5000
  `).run()
  return result.meta.changes ?? 0
}
