import { Hono } from 'hono'
import type { Env, ClassifyRequest, ClassifyBatchRequest } from '../types'
import { classifyText, ClassifyError } from '../classify'
import { buildModelContext } from '../models'

const app = new Hono<{ Bindings: Env }>()

app.post('/', async (c) => {
  try {
    const body = await c.req.json<ClassifyRequest>()
    const ctx = await buildModelContext(c.env)
    const result = await classifyText(c.env.DB, ctx, body)
    return c.json(result)
  } catch (error) {
    if (error instanceof ClassifyError) {
      return c.json(
        { error: error.message, ...(error.details ? { details: error.details } : {}) },
        error.status as 400 | 502 | 503
      )
    }
    console.error('Unexpected error in /classify:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.post('/batch', async (c) => {
  try {
    const body = await c.req.json<ClassifyBatchRequest>()

    if (!body.items || body.items.length === 0) {
      return c.json({ error: 'items array is required' }, 400)
    }

    const ctx = await buildModelContext(c.env)
    const results = await Promise.allSettled(
      body.items.map(item =>
        classifyText(c.env.DB, ctx, {
          text: item.text,
          categories: item.categories,
          contexts: body.contexts,
          max_results: body.max_results_per_item,
        })
      )
    )

    return c.json(
      results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : {
              classifications: [],
              unclassified: [],
              context_used: [],
              error: r.reason instanceof Error ? r.reason.message : 'Unknown error',
            }
      )
    )
  } catch (error) {
    console.error('Unexpected error in /classify/batch:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export { app as classifyRoutes }
