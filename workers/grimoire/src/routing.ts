import type { AppRoutingRow, SetRoutingInput } from './types'

export async function setRouting(
  db: D1Database,
  input: SetRoutingInput
): Promise<AppRoutingRow> {
  const now = new Date().toISOString()
  await db
    .prepare(
      'INSERT OR REPLACE INTO app_routing (atom_id, app, routing, context, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(input.atom_id, input.app, input.routing, input.context ?? null, now)
    .run()

  return {
    atom_id: input.atom_id,
    app: input.app,
    routing: input.routing,
    context: input.context ?? null,
    created_at: now,
  }
}

export async function getRoutingForAtom(
  db: D1Database,
  atomId: string
): Promise<AppRoutingRow[]> {
  const res = await db
    .prepare('SELECT * FROM app_routing WHERE atom_id = ?')
    .bind(atomId)
    .all<AppRoutingRow>()
  return res.results
}

export async function getRoutingForApp(
  db: D1Database,
  app: string,
  routing?: string
): Promise<Array<AppRoutingRow & { text: string; text_lower: string }>> {
  if (routing) {
    const res = await db
      .prepare(
        `SELECT r.*, a.text, a.text_lower
         FROM app_routing r
         JOIN atoms a ON r.atom_id = a.id
         WHERE r.app = ? AND r.routing = ?
         ORDER BY a.text_lower`
      )
      .bind(app, routing)
      .all<AppRoutingRow & { text: string; text_lower: string }>()
    return res.results
  }

  const res = await db
    .prepare(
      `SELECT r.*, a.text, a.text_lower
       FROM app_routing r
       JOIN atoms a ON r.atom_id = a.id
       WHERE r.app = ?
       ORDER BY r.routing, a.text_lower`
    )
    .bind(app)
    .all<AppRoutingRow & { text: string; text_lower: string }>()
  return res.results
}

export async function bulkSetRouting(
  db: D1Database,
  inputs: SetRoutingInput[]
): Promise<{ set: number; errors: number }> {
  let set = 0
  let errors = 0

  for (let i = 0; i < inputs.length; i += 100) {
    const chunk = inputs.slice(i, i + 100)
    const statements: D1PreparedStatement[] = []
    const now = new Date().toISOString()

    for (const input of chunk) {
      statements.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO app_routing (atom_id, app, routing, context, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(input.atom_id, input.app, input.routing, input.context ?? null, now)
      )
    }

    try {
      await db.batch(statements)
      set += chunk.length
    } catch {
      errors += chunk.length
    }
  }

  return { set, errors }
}

export async function deleteRouting(
  db: D1Database,
  atomId: string,
  app: string
): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM app_routing WHERE atom_id = ? AND app = ?')
    .bind(atomId, app)
    .run()
  return (res.meta.changes ?? 0) > 0
}
