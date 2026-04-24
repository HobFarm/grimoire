/**
 * Daily Review Pipeline
 *
 * Generates a structured markdown review of Grimoire activity in the last 24 hours.
 * Writes to R2 at grimoire/reviews/YYYY-MM-DD.md.
 * Triggered by cron at 06:00 UTC (conditional within the every-15-min schedule).
 */

// --- Types ---

interface NewAtomSummary {
  category_slug: string
  count: number
}

interface GateStats {
  pass: number
  reject: number
  flag: number
  redirect_merge: number
}

interface PhaseStats {
  phase: string
  items: number
  errors: number
}

interface CorrespondenceHighlight {
  atom_a_text: string
  atom_b_text: string
  strength: number
  relationship_type: string
  scope: string
}

interface LatencyStats {
  avg_hours: number | null
  min_hours: number | null
  max_hours: number | null
  count: number
}

// --- Query Functions ---

async function queryNewAtoms(db: D1Database): Promise<NewAtomSummary[]> {
  const { results } = await db.prepare(
    `SELECT category_slug, COUNT(*) as count FROM atoms
     WHERE created_at > datetime('now', '-1 day') AND category_slug IS NOT NULL
     GROUP BY category_slug ORDER BY count DESC LIMIT 15`
  ).all<{ category_slug: string; count: number }>()
  return results
}

async function queryUpdatedAtoms(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as cnt FROM atoms
     WHERE updated_at > datetime('now', '-1 day')
       AND created_at <= datetime('now', '-1 day')`
  ).first<{ cnt: number }>()
  return row?.cnt ?? 0
}

async function queryTotalNewAtoms(db: D1Database): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) as cnt FROM atoms WHERE created_at > datetime('now', '-1 day')"
  ).first<{ cnt: number }>()
  return row?.cnt ?? 0
}

async function queryGateStats(db: D1Database): Promise<GateStats> {
  const { results } = await db.prepare(
    `SELECT result, COUNT(*) as count FROM quality_gate_log
     WHERE checked_at > datetime('now', '-1 day')
     GROUP BY result`
  ).all<{ result: string; count: number }>()
  const stats: GateStats = { pass: 0, reject: 0, flag: 0, redirect_merge: 0 }
  for (const row of results) {
    if (row.result === 'pass') stats.pass = row.count
    else if (row.result === 'reject') stats.reject = row.count
    else if (row.result === 'flag') stats.flag = row.count
    else if (row.result === 'redirect_merge') stats.redirect_merge = row.count
  }
  return stats
}

async function queryDlqFailures(db: D1Database): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) as cnt FROM failed_operations WHERE failed_at > datetime('now', '-1 day')"
  ).first<{ cnt: number }>()
  return row?.cnt ?? 0
}

async function queryPhaseStats(db: D1Database): Promise<PhaseStats[]> {
  const { results } = await db.prepare(
    `SELECT phase, SUM(items_processed) as items, SUM(errors) as errors
     FROM execution_log
     WHERE started_at > datetime('now', '-1 day')
     GROUP BY phase ORDER BY phase`
  ).all<{ phase: string; items: number; errors: number }>()
  return results
}

async function queryLatencyStats(db: D1Database): Promise<LatencyStats> {
  const row = await db.prepare(
    `SELECT
       AVG(julianday(fully_enriched_at) - julianday(created_at)) * 24 as avg_hours,
       MIN(julianday(fully_enriched_at) - julianday(created_at)) * 24 as min_hours,
       MAX(julianday(fully_enriched_at) - julianday(created_at)) * 24 as max_hours,
       COUNT(*) as count
     FROM atoms
     WHERE fully_enriched_at IS NOT NULL
       AND fully_enriched_at > datetime('now', '-1 day')`
  ).first<{ avg_hours: number | null; min_hours: number | null; max_hours: number | null; count: number }>()
  return {
    avg_hours: row?.avg_hours ?? null,
    min_hours: row?.min_hours ?? null,
    max_hours: row?.max_hours ?? null,
    count: row?.count ?? 0,
  }
}

async function queryPendingReview(db: D1Database): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) as cnt FROM discovery_queue WHERE status = 'pending'"
  ).first<{ cnt: number }>()
  return row?.cnt ?? 0
}

async function queryStrongestCorrespondences(db: D1Database): Promise<CorrespondenceHighlight[]> {
  const { results } = await db.prepare(
    `SELECT a1.text as atom_a_text, a2.text as atom_b_text,
            c.strength, c.relationship_type, COALESCE(c.scope, 'cross_category') as scope
     FROM correspondences c
     JOIN atoms a1 ON c.atom_a_id = a1.id
     JOIN atoms a2 ON c.atom_b_id = a2.id
     WHERE c.created_at > datetime('now', '-1 day')
     ORDER BY c.strength DESC LIMIT 5`
  ).all<CorrespondenceHighlight>()
  return results
}

// --- Markdown Generator ---

function formatDate(): string {
  return new Date().toISOString().split('T')[0]
}

function roundTo(n: number | null, decimals: number): string {
  if (n === null) return 'N/A'
  return n.toFixed(decimals)
}

function generateMarkdown(data: {
  date: string
  totalNew: number
  newByCategory: NewAtomSummary[]
  updated: number
  gate: GateStats
  dlqFailures: number
  phases: PhaseStats[]
  latency: LatencyStats
  pendingReview: number
  correspondences: CorrespondenceHighlight[]
}): string {
  const lines: string[] = []

  lines.push(`# Daily Grimoire Review - ${data.date}`)
  lines.push('')

  // New Knowledge
  lines.push(`## New Knowledge (${data.totalNew} atoms created)`)
  if (data.newByCategory.length === 0) {
    lines.push('No new atoms in the last 24 hours.')
  } else {
    for (const cat of data.newByCategory) {
      lines.push(`- **${cat.category_slug}**: ${cat.count} atoms`)
    }
  }
  lines.push(`- ${data.updated} atoms updated (not new)`)
  lines.push('')

  // Quality Gate
  lines.push('## Quality Gate')
  const gateTotal = data.gate.pass + data.gate.reject + data.gate.flag + data.gate.redirect_merge
  if (gateTotal === 0) {
    lines.push('No quality gate checks in the last 24 hours.')
  } else {
    lines.push(`- Passed: ${data.gate.pass}`)
    lines.push(`- Rejected (low specificity): ${data.gate.reject}`)
    lines.push(`- Flagged for review: ${data.gate.flag}`)
    lines.push(`- Redirected to merge: ${data.gate.redirect_merge}`)
  }
  lines.push('')

  // Pipeline Health
  lines.push('## Pipeline Health')
  lines.push(`- DLQ failures: ${data.dlqFailures}`)
  if (data.phases.length > 0) {
    lines.push('- Phase throughput:')
    for (const p of data.phases) {
      const errorNote = p.errors > 0 ? ` (${p.errors} errors)` : ''
      lines.push(`  - ${p.phase}: ${p.items} items${errorNote}`)
    }
  }
  lines.push('')

  // Latency
  lines.push('## Pipeline Latency')
  if (data.latency.count === 0) {
    lines.push('No atoms fully enriched in the last 24 hours.')
  } else {
    lines.push(`- Atoms fully enriched: ${data.latency.count}`)
    lines.push(`- Average: ${roundTo(data.latency.avg_hours, 1)} hours`)
    lines.push(`- Min: ${roundTo(data.latency.min_hours, 1)} hours`)
    lines.push(`- Max: ${roundTo(data.latency.max_hours, 1)} hours`)
  }
  lines.push('')

  // Correspondences
  lines.push('## Strongest New Correspondences')
  if (data.correspondences.length === 0) {
    lines.push('No new correspondences in the last 24 hours.')
  } else {
    for (const c of data.correspondences) {
      lines.push(`- "${c.atom_a_text}" <-> "${c.atom_b_text}" (${c.strength}, ${c.relationship_type}, ${c.scope})`)
    }
  }
  lines.push('')

  // Review Queue
  lines.push('## Review Queue')
  lines.push(`- ${data.pendingReview} items pending in discovery queue`)
  if (data.gate.flag > 0) {
    lines.push(`- ${data.gate.flag} atoms flagged for specificity review`)
  }
  if (data.gate.redirect_merge > 0) {
    lines.push(`- ${data.gate.redirect_merge} atoms pending merge review`)
  }
  lines.push('')

  return lines.join('\n')
}

// --- Main Entry Point ---

export async function generateDailyReview(
  db: D1Database,
  r2: R2Bucket
): Promise<{ key: string; size: number }> {
  const date = formatDate()

  // Run all queries in parallel
  const [totalNew, newByCategory, updated, gate, dlqFailures, phases, latency, pendingReview, correspondences] =
    await Promise.all([
      queryTotalNewAtoms(db),
      queryNewAtoms(db),
      queryUpdatedAtoms(db),
      queryGateStats(db),
      queryDlqFailures(db),
      queryPhaseStats(db),
      queryLatencyStats(db),
      queryPendingReview(db),
      queryStrongestCorrespondences(db),
    ])

  const markdown = generateMarkdown({
    date, totalNew, newByCategory, updated, gate,
    dlqFailures, phases, latency, pendingReview, correspondences,
  })

  const key = `grimoire/reviews/${date}.md`
  await r2.put(key, markdown, {
    httpMetadata: { contentType: 'text/markdown' },
  })

  console.log(`[daily-review] Generated ${key} (${markdown.length} bytes)`)
  return { key, size: markdown.length }
}
