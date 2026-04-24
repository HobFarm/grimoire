// Integrity scan and evolve report
// Extracted from hobbot-worker index.ts

import { detectDrift } from './pipeline/drift-detect'
import { detectBulkImport, detectCircularRelations } from './pipeline/attack-patterns'
import { runMaintenance } from './pipeline/cleanup'
import { getAtomCounts, saveScanResult } from '@shared/state/grimoire'
import { getCorrespondenceStats, getOrphanedAtoms } from '@shared/state/graph'
import { processDiscoveryQueue } from './state/discovery-processor'
import { promoteQualifiedAtoms, recalculateTiers } from './maintenance'
import type { IntegrityIssue } from '@shared/grimoire/types'

// cron: 0 */6 * * *
// Full integrity scan of the correspondence graph (MAINTAIN mode)
// Each stage is isolated so one failure doesn't block the rest.
export async function runIntegrityScan(db: D1Database): Promise<void> {
  const start = Date.now()
  let allIssues: IntegrityIssue[] = []
  let promoted = 0, tiersFixed = 0

  // Stage 1: Detection (non-critical)
  try {
    const [driftIssues, bulkIssues, circularIssues] = await Promise.all([
      detectDrift(db),
      detectBulkImport(db),
      detectCircularRelations(db),
    ])
    allIssues = [...driftIssues, ...bulkIssues, ...circularIssues]
  } catch (e) {
    console.log(`[integrity] detection stage failed: ${e instanceof Error ? e.message : e}`)
  }

  // Stage 2: Promotion
  try {
    promoted = await promoteQualifiedAtoms(db)
    if (promoted > 0) console.log(`[integrity] promoted ${promoted} atoms to confirmed`)
  } catch (e) {
    console.log(`[integrity] promotion failed: ${e instanceof Error ? e.message : e}`)
  }

  // Stage 3: Discovery queue
  try {
    const discovery = await processDiscoveryQueue(db)
    if (discovery.accepted + discovery.merged + discovery.failed > 0) {
      console.log(`[integrity] discovery queue: ${discovery.accepted} accepted, ${discovery.merged} merged, ${discovery.failed} failed`)
    }
  } catch (e) {
    console.log(`[integrity] discovery processing failed: ${e instanceof Error ? e.message : e}`)
  }

  // Stage 4: Tier recalculation
  try {
    tiersFixed = await recalculateTiers(db)
    if (tiersFixed > 0) console.log(`[integrity] recalculated ${tiersFixed} atom tiers`)
  } catch (e) {
    console.log(`[integrity] tier recalculation failed: ${e instanceof Error ? e.message : e}`)
  }

  // Always save scan result
  const durationMs = Date.now() - start
  try {
    const atomCount = await db.prepare('SELECT COUNT(*) as count FROM atoms').first<{ count: number }>()
    const scannedCount = atomCount?.count ?? 0
    await saveScanResult(db, 'full', scannedCount, allIssues, durationMs)
    await runMaintenance(db)
    const highSeverity = allIssues.filter(i => i.severity === 'high').length
    console.log(`integrity_scan: atoms=${scannedCount} issues=${allIssues.length} high=${highSeverity} promoted=${promoted} tiers=${tiersFixed} ms=${durationMs}`)
  } catch (e) {
    console.log(`[integrity] save/maintenance failed after ${durationMs}ms: ${e instanceof Error ? e.message : e}`)
  }
}

// cron: 0 0 * * 1
// Weekly graph analysis report (EVOLVE mode)
export async function runEvolveReport(db: D1Database): Promise<void> {
  const start = Date.now()

  const [atomCounts, corrStats, orphans] = await Promise.all([
    getAtomCounts(db),
    getCorrespondenceStats(db),
    getOrphanedAtoms(db, 100),
  ])

  const total = Object.values(atomCounts).reduce((sum, n) => sum + n, 0)
  const durationMs = Date.now() - start

  await saveScanResult(db, 'evolve', total, [{ stats: corrStats, orphan_count: orphans.length }], durationMs)
  console.log(`evolve_report: atoms=${total} correspondences=${corrStats.total} orphans=${orphans.length} ms=${durationMs}`)
}
