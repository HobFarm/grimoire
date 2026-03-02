# Task Brief 05: Atom Promotion Pipeline

## Depends On

Tasks 01-03 should be complete. The promotion rules rely on classification (category_slug), vectorization (embedding_status), and correspondences being up to date.

## Problem

130,184 atoms are provisional with no automated path to confirmed. The 21,904 confirmed atoms were promoted manually or arrived as confirmed from seed data. Provisional atoms get lower weighting in invoke (via tier scoring), which means the bulk of the vocabulary is underweighted even when it's perfectly valid.

There's no systematic way to say "this atom has been classified, vectorized, has correspondences, and has been used in compilations; it's earned confirmed status."

## Solution

Add promotion rules to the existing 6-hourly integrity scan cron on the HobBot worker. Atoms meeting a threshold automatically promote from provisional to confirmed. No manual intervention needed.

### Promotion Rules

An atom qualifies for promotion when ALL of the following are true:

```typescript
interface PromotionCriteria {
  // Must have
  hasCategory: boolean;        // category_slug IS NOT NULL AND != ''
  isVectorized: boolean;       // embedding_status = 'complete'
  hasHarmonics: boolean;       // harmonics != '{}' AND harmonics IS NOT NULL
  
  // Must have at least ONE of
  hasCorrespondences: boolean; // EXISTS in correspondences table (as atom_a_id or atom_b_id)
  hasRelations: boolean;       // EXISTS in atom_relations table
  hasExemplars: boolean;       // EXISTS in exemplars table
  usedInCompilation: boolean;  // encounter_count >= 1 (if this field exists)
}
```

The "must have all" gate ensures the atom is fully processed. The "must have one" gate ensures it's connected to the knowledge graph in some way, not an isolated term that passed classification but has no semantic relationships.

### Implementation

In the HobBot worker's integrity scan handler (runs every 6 hours):

```typescript
async function promoteQualifiedAtoms(db: D1Database): Promise<{ promoted: number }> {
  // Single query that checks all criteria
  const result = await db.prepare(`
    UPDATE atoms 
    SET status = 'confirmed', 
        updated_at = datetime('now')
    WHERE status = 'provisional'
      AND category_slug IS NOT NULL 
      AND category_slug != ''
      AND embedding_status = 'complete'
      AND harmonics IS NOT NULL 
      AND harmonics != '{}'
      AND (
        -- Has at least one correspondence
        EXISTS (
          SELECT 1 FROM correspondences 
          WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id
        )
        OR
        -- Has at least one relation
        EXISTS (
          SELECT 1 FROM atom_relations 
          WHERE source_atom_id = atoms.id OR target_atom_id = atoms.id
        )
        OR
        -- Has exemplar evidence
        EXISTS (
          SELECT 1 FROM exemplars WHERE atom_id = atoms.id
        )
      )
    LIMIT 5000
  `).run();
  
  return { promoted: result.meta.changes ?? 0 };
}
```

**LIMIT 5000**: Process in chunks to avoid D1 timeout on the first run (where potentially tens of thousands qualify). The cron runs every 6 hours, so it will catch the rest on subsequent passes.

### Integrate into integrity scan

Find the `runIntegrityScan()` function in the HobBot worker. Add the promotion step:

```typescript
async function runIntegrityScan(env: Env): Promise<IntegrityScanResult> {
  const results: IntegrityScanResult = {
    // ... existing fields
    atoms_promoted: 0,
  };
  
  // ... existing scan logic (drift detection, orphan detection, etc.)
  
  // Atom promotion
  const promotion = await promoteQualifiedAtoms(env.GRIMOIRE_DB);
  results.atoms_promoted = promotion.promoted;
  
  if (promotion.promoted > 0) {
    console.log(`[integrity] Promoted ${promotion.promoted} atoms from provisional to confirmed`);
  }
  
  // ... rest of scan
  return results;
}
```

### Tier Recalculation

After promotion, tiers should be recalculated since tier depends on status + connections. If tier computation is already part of the integrity scan, no change needed. If not, add a tier refresh:

```typescript
// Tier 1: has exemplars AND correspondences
// Tier 2: has correspondences only  
// Tier 3: isolated (no correspondences)

await db.prepare(`
  UPDATE atoms SET tier = CASE
    WHEN EXISTS (SELECT 1 FROM exemplars WHERE atom_id = atoms.id)
     AND EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
    THEN 1
    WHEN EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
    THEN 2
    ELSE 3
  END
  WHERE status = 'confirmed' AND tier != (
    CASE
      WHEN EXISTS (SELECT 1 FROM exemplars WHERE atom_id = atoms.id)
       AND EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
      THEN 1
      WHEN EXISTS (SELECT 1 FROM correspondences WHERE atom_a_id = atoms.id OR atom_b_id = atoms.id)
      THEN 2
      ELSE 3
    END
  )
  LIMIT 5000
`).run();
```

This is expensive on 154K rows. If it's already happening in the integrity scan, leave it. If not, run it only on newly promoted atoms:

```typescript
// Lighter version: only recalculate tier for atoms promoted in this run
// Requires tracking which atoms were promoted (add RETURNING id to the UPDATE, or query beforehand)
```

### Logging

Log promotion counts to the existing integrity_scans or evolve_reports table so you can track promotion velocity over time.

### Demotion (optional, future)

The inverse path: confirmed atoms that lose all correspondences and exemplars could be demoted back to provisional. Not needed now, but the integrity scan is the right place to add it later.

## Expected Impact

Based on current data:
- 130K provisional atoms
- 161K correspondences exist
- All atoms are categorized and vectorized

Many provisional atoms already meet all criteria. The first run will likely promote 50K-80K atoms in a single pass (capped at 5K per tick, so full promotion takes 10-16 integrity scan cycles = 2.5-4 days).

After promotion stabilizes:
- Tier 1 count should increase significantly (atoms with both exemplars and correspondences)
- Tier 2 should absorb most of the newly confirmed atoms
- Tier 3 should shrink to atoms that genuinely lack connections
- Invoke scoring improves because more atoms get the confirmed weight multiplier

## Verification

1. Check current counts: `SELECT status, COUNT(*) FROM atoms GROUP BY status`
2. Deploy and wait for integrity scan (or trigger manually)
3. Check new counts: provisional should decrease, confirmed should increase
4. Verify a promoted atom: pick one, confirm it has category_slug, embedding_status=complete, harmonics, and at least one correspondence
5. Check the integrity scan log for `atoms_promoted` count

## Files Changed

| File | Action |
|------|--------|
| Integrity scan handler (HobBot worker) | MODIFY: Add promoteQualifiedAtoms() call |
| New function (or inline in scan) | NEW: promoteQualifiedAtoms() |
| IntegrityScanResult type | MODIFY: Add atoms_promoted field |

## What NOT to Change

- Atom schema (no new columns needed)
- Invoke scoring weights (they already use tier; more confirmed atoms just means better scoring)
- Classification or vectorization pipelines
- MCP tools (promotion is internal, not user-facing)

## Risk

**Very low.** Status change from provisional to confirmed is a soft upgrade. All code paths already handle both statuses. The invoke endpoint already weights confirmed higher than provisional. Worst case: some atoms get promoted too aggressively, but since they must have category + embeddings + harmonics + correspondences to qualify, the quality gate is reasonably high.

If you want extra safety, add `dry_run` mode to the promotion function that counts qualifiers without updating:

```typescript
async function countPromotionCandidates(db: D1Database): Promise<number> {
  // Same query as promote, but SELECT COUNT(*) instead of UPDATE
}
```

Run the count first to see the scale before committing.
