// Post-harvest pipeline: materialize relationship metadata into atom_relations
// Reads metadata from harvested atoms (GRIMOIRE_DB), creates directed relations,
// and tracks every attempt in source_correspondences (HOBBOT_DB).

import { addRelation } from '@shared/state/relations'
import type { AtomRelationType, AtomRelationSource } from '@shared/grimoire/types'

// --- Types ---

interface CorrespondenceBuildResult {
  source_id: string
  total_relationships: number
  matched: number
  unmatched: number
  created: number
  already_existed: number
  errors: number
  elapsed_ms: number
}

interface RelationshipCandidate {
  source_atom_id: string
  target_text: string
  collection_hint: string
  relation_type: AtomRelationType
  source: AtomRelationSource
  context: string
  strength: number
  confidence: number
}

// --- Config per source ---

interface SourceRelationConfig {
  collection_slug: string
  metadata_key: string
  extract: (atomId: string, metadata: Record<string, unknown>, collectionSlug: string) => RelationshipCandidate[]
}

const SOURCE_CONFIG: Record<string, SourceRelationConfig> = {
  'getty-aat': {
    collection_slug: 'getty-aat',
    metadata_key: 'broader_term',
    extract(atomId, metadata, collectionSlug) {
      const broaderTerm = metadata.broader_term
      if (typeof broaderTerm !== 'string' || !broaderTerm.trim()) return []
      return [{
        source_atom_id: atomId,
        target_text: broaderTerm.trim(),
        collection_hint: collectionSlug,
        relation_type: 'narrower_than',
        source: 'harvested',
        context: 'getty-aat-hierarchy',
        strength: 0.9,
        confidence: 0.95,
      }]
    },
  },
  'wikidata-visual-arts': {
    collection_slug: 'wikidata',
    metadata_key: 'influenced_by',
    extract(atomId, metadata, collectionSlug) {
      const influences = metadata.influenced_by
      if (!Array.isArray(influences)) return []
      return influences
        .filter((inf): inf is { label: string } => inf && typeof inf.label === 'string' && inf.label.trim().length > 0)
        .map(inf => ({
          source_atom_id: atomId,
          target_text: inf.label.trim(),
          collection_hint: collectionSlug,
          relation_type: 'influenced_by' as AtomRelationType,
          source: 'harvested' as AtomRelationSource,
          context: 'wikidata-p737',
          strength: 0.8,
          confidence: 0.8,
        }))
    },
  },
}

// --- Atom lookup ---

async function findTargetAtom(
  db: D1Database,
  targetText: string,
  preferredCollection: string,
): Promise<{ id: string; text: string; collection_slug: string } | null> {
  const result = await db.prepare(
    `SELECT id, text, collection_slug FROM atoms
     WHERE text_lower = lower(?)
     ORDER BY CASE WHEN collection_slug = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(targetText.trim(), preferredCollection).first<{ id: string; text: string; collection_slug: string }>()
  return result ?? null
}

// --- Tracking ---

async function loadProcessedSet(
  db: D1Database,
  sourceId: string,
): Promise<Set<string>> {
  const rows = await db.prepare(
    `SELECT atom_id, target_atom_text, relationship_type
     FROM source_correspondences
     WHERE source_id = ? AND status IN ('created', 'matched')`
  ).bind(sourceId).all<{ atom_id: string; target_atom_text: string; relationship_type: string }>()
  const set = new Set<string>()
  for (const row of rows.results ?? []) {
    set.add(`${row.atom_id}|${row.target_atom_text}|${row.relationship_type}`)
  }
  return set
}

async function recordCorrespondence(
  db: D1Database,
  sourceId: string,
  atomId: string,
  targetText: string,
  targetAtomId: string | null,
  relationshipType: string,
  status: 'matched' | 'unmatched' | 'created',
  correspondenceId: string | null,
): Promise<void> {
  await db.prepare(
    `INSERT INTO source_correspondences
       (source_id, atom_id, target_atom_text, target_atom_id, relationship_type, status, correspondence_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_id, atom_id, target_atom_text, relationship_type)
     DO UPDATE SET
       target_atom_id = excluded.target_atom_id,
       status = excluded.status,
       correspondence_id = excluded.correspondence_id,
       updated_at = datetime('now')`
  ).bind(sourceId, atomId, targetText, targetAtomId, relationshipType, status, correspondenceId).run()
}

// --- Main builder ---

const BATCH_SIZE = 200
const MAX_ELAPSED_MS = 240_000 // 4 minutes

export async function buildCorrespondences(
  grimoireDb: D1Database,
  hobbotDb: D1Database,
  sourceId: string,
): Promise<CorrespondenceBuildResult> {
  const config = SOURCE_CONFIG[sourceId]
  if (!config) throw new Error(`No relationship extractor for source: ${sourceId}`)

  const result: CorrespondenceBuildResult = {
    source_id: sourceId,
    total_relationships: 0,
    matched: 0,
    unmatched: 0,
    created: 0,
    already_existed: 0,
    errors: 0,
    elapsed_ms: 0,
  }

  const startTime = Date.now()

  // Pre-load already-processed set to skip redundant work
  const processed = await loadProcessedSet(hobbotDb, sourceId)
  console.log(`[correspondence] ${sourceId}: ${processed.size} already processed, starting scan`)

  let offset = 0

  while ((Date.now() - startTime) < MAX_ELAPSED_MS) {
    // Fetch atoms with relevant metadata
    const { results: atoms } = await grimoireDb.prepare(
      `SELECT id, text, collection_slug, metadata FROM atoms
       WHERE collection_slug = ?
         AND metadata LIKE ?
       ORDER BY id
       LIMIT ? OFFSET ?`
    ).bind(
      config.collection_slug,
      `%${config.metadata_key}%`,
      BATCH_SIZE,
      offset,
    ).all<{ id: string; text: string; collection_slug: string; metadata: string }>()

    if (!atoms || atoms.length === 0) break

    for (const atom of atoms) {
      let metadata: Record<string, unknown>
      try {
        metadata = JSON.parse(atom.metadata || '{}')
      } catch {
        continue
      }

      const candidates = config.extract(atom.id, metadata, atom.collection_slug)

      for (const candidate of candidates) {
        result.total_relationships++

        // Skip if already processed successfully
        const key = `${candidate.source_atom_id}|${candidate.target_text}|${candidate.relation_type}`
        if (processed.has(key)) {
          result.already_existed++
          continue
        }

        try {
          const target = await findTargetAtom(grimoireDb, candidate.target_text, candidate.collection_hint)

          if (!target) {
            await recordCorrespondence(
              hobbotDb, sourceId, candidate.source_atom_id,
              candidate.target_text, null, candidate.relation_type,
              'unmatched', null,
            )
            result.unmatched++
            continue
          }

          // Prevent self-referencing relations
          if (target.id === candidate.source_atom_id) continue

          const relationResult = await addRelation(grimoireDb, {
            source_atom_id: candidate.source_atom_id,
            target_atom_id: target.id,
            relation_type: candidate.relation_type,
            strength: candidate.strength,
            confidence: candidate.confidence,
            source: candidate.source,
            context: candidate.context,
          })

          const status = relationResult.created ? 'created' : 'matched'
          await recordCorrespondence(
            hobbotDb, sourceId, candidate.source_atom_id,
            candidate.target_text, target.id, candidate.relation_type,
            status, relationResult.id,
          )

          if (relationResult.created) {
            result.created++
          } else {
            result.matched++
          }

          // Mark as processed so re-runs skip it
          processed.add(key)
        } catch (e) {
          result.errors++
          console.error(`[correspondence] error for atom ${candidate.source_atom_id} -> "${candidate.target_text}":`, e instanceof Error ? e.message : e)
        }
      }
    }

    offset += BATCH_SIZE
    console.log(`[correspondence] ${sourceId}: offset=${offset} total=${result.total_relationships} created=${result.created} unmatched=${result.unmatched}`)
  }

  result.elapsed_ms = Date.now() - startTime
  console.log(`[correspondence] ${sourceId}: done in ${result.elapsed_ms}ms`, JSON.stringify(result))
  return result
}
