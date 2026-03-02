import { readFileSync, writeFileSync } from 'fs'

const m = JSON.parse(readFileSync('c:/Users/xkxxk/grimoire/triage-manifest.json', 'utf-8'))
const targets = new Set(['noun_full.txt', 'noun.txt', 'noun-general.txt'])
const before = m.files.length

m.files = m.files.filter(f => {
  if (targets.has(f.file) && f.folder === 'Adjectives') return false
  return true
})

const after = m.files.length
m.total_files = after

// Recalculate summary
const byStrategy = {}
const byPriority = {}
const byType = {}
let totalAtoms = 0
for (const f of m.files) {
  byStrategy[f.ingest_strategy] = (byStrategy[f.ingest_strategy] || 0) + 1
  byPriority[f.priority] = (byPriority[f.priority] || 0) + 1
  byType[f.type] = (byType[f.type] || 0) + 1
  totalAtoms += f.estimated_atom_yield || 0
}
m.summary = { by_strategy: byStrategy, by_priority: byPriority, by_type: byType, total_estimated_atoms: totalAtoms }

writeFileSync('c:/Users/xkxxk/grimoire/triage-manifest.json', JSON.stringify(m, null, 2))
console.log(`Removed: ${before - after} files`)
console.log(`Files after: ${after}`)
console.log(`Estimated atoms after: ${totalAtoms}`)
