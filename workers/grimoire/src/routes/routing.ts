import { Hono } from 'hono'
import type { Env, SetRoutingInput } from '../types'
import {
  setRouting,
  getRoutingForApp,
  bulkSetRouting,
  deleteRouting,
} from '../routing'

const app = new Hono<{ Bindings: Env }>()

app.get('/:app', async (c) => {
  const appName = c.req.param('app')
  const routing = c.req.query('routing') || undefined
  const results = await getRoutingForApp(c.env.DB, appName, routing)
  return c.json({ routing: results })
})

app.post('/', async (c) => {
  try {
    const body = await c.req.json<SetRoutingInput>()
    if (!body.atom_id || !body.app || !body.routing) {
      return c.json({ error: 'atom_id, app, and routing are required' }, 400)
    }
    const result = await setRouting(c.env.DB, body)
    return c.json(result, 201)
  } catch (error) {
    if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
      return c.json({ error: 'Invalid atom_id' }, 400)
    }
    console.error('Error setting routing:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.post('/bulk', async (c) => {
  try {
    const body = await c.req.json<{ routes: SetRoutingInput[] }>()
    if (!body.routes || body.routes.length === 0) {
      return c.json({ error: 'routes array is required' }, 400)
    }
    const result = await bulkSetRouting(c.env.DB, body.routes)
    return c.json(result)
  } catch (error) {
    console.error('Error in bulk routing:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.delete('/:atom_id/:app', async (c) => {
  const atomId = c.req.param('atom_id')
  const appName = c.req.param('app')
  const deleted = await deleteRouting(c.env.DB, atomId, appName)
  if (!deleted) return c.json({ error: 'Routing entry not found' }, 404)
  return c.json({ deleted: true })
})

export { app as routingRoutes }
