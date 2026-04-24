import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { Env } from './types'
import { classifyRoutes } from './routes/classify'
import { registerTaxonomyRoutes } from './routes/taxonomy'
import { atomRoutes } from './routes/atoms'
import { searchRoutes } from './routes/search'
import { ingestRoutes } from './routes/ingest'
import { routingRoutes } from './routes/routing'
import { adminApp } from './admin'
import { knowledgeApp } from './knowledge'
import { imageApp } from './fromImage'
import { moodboardApp } from './routes/moodboard'
import { moodboardAnalysisApp } from './routes/moodboard-analysis'
import { dimensionApp } from './routes/dimension'
import { manifestsApp } from './routes/manifests'
import { resolveApp } from './resolve'
import { invoke, InvokeError } from './invoke'
import { scanAndEnqueue } from './cron'
import { handleClassifyBatch, handleVectorizeBatch, handleEnrichBatch, handleDlqBatch } from './queue-consumers'
import type { ClassifyMessage, DiscoveryMessage, VectorizeMessage, EnrichMessage } from './types'

const app = new Hono<{ Bindings: Env }>()

// --- CORS Middleware ---

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') || ''
  const allowedRaw = c.env.ALLOWED_ORIGINS || ''
  const allowed = allowedRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const isAllowed =
    allowed.length === 0
      ? origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')
      : allowed.includes(origin)

  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': isAllowed ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  await next()

  if (isAllowed) {
    c.header('Access-Control-Allow-Origin', origin)
  }
})

// --- Admin Auth Middleware ---

async function resolveServiceTokens(env: Env): Promise<string> {
  const raw = env.SERVICE_TOKENS as unknown
  if (raw && typeof raw === 'object' && 'get' in raw && typeof (raw as { get: unknown }).get === 'function') {
    return await (raw as { get: () => Promise<string> }).get() ?? ''
  }
  return (raw as string) ?? ''
}

const serviceTokenAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized', code: 401 }, 401)
  }

  const token = authHeader.slice(7).trim()
  const tokenList = await resolveServiceTokens(c.env)

  let valid = false
  for (const pair of tokenList.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    const secret = colonIdx >= 1 ? trimmed.slice(colonIdx + 1).trim() : trimmed
    if (secret === token) { valid = true; break }
  }

  if (!valid) {
    return c.json({ error: 'unauthorized', code: 401 }, 401)
  }

  await next()
}

app.use('/admin/*', serviceTokenAuth)
app.use('/api/v1/*', serviceTokenAuth)

// --- Health ---

app.get('/health', (c) =>
  c.json({ status: 'ok', worker: 'grimoire', version: '2.0' })
)

// --- Invoke (prompt assembly engine) ---

app.post('/invoke', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.incantation) return c.json({ error: 'incantation slug is required' }, 400)
    if (body.modality && !['visual', 'narrative', 'both'].includes(body.modality)) {
      return c.json({ error: 'modality must be visual, narrative, or both' }, 400)
    }
    const result = await invoke(c.env, body)
    return c.json(result)
  } catch (error) {
    if (error instanceof InvokeError) return c.json({ error: error.message }, error.status as 400 | 404 | 500)
    console.error('Error in /invoke:', error)
    return c.json({ error: 'Invocation failed' }, 500)
  }
})

// --- Mount Sub-Apps ---

app.route('/classify', classifyRoutes)
registerTaxonomyRoutes(app)
app.route('/atoms', atomRoutes)
app.route('/search', searchRoutes)
app.route('/ingest', ingestRoutes)
app.route('/routing', routingRoutes)
app.route('/admin', adminApp)
app.route('/admin/moodboard', moodboardApp)
app.route('/admin/moodboard', moodboardAnalysisApp)
app.route('/admin/dimension', dimensionApp)
app.route('/admin/manifests', manifestsApp)
app.route('/knowledge', knowledgeApp)
app.route('/image', imageApp)
app.route('/api/v1/resolve', resolveApp)

// Daily review: read-only, no auth required (accessed via service binding from MCP tools)
app.get('/review/daily', async (c) => {
  if (!c.env.R2) return c.json({ error: 'R2 binding not configured' }, 503)
  const date = c.req.query('date') || new Date().toISOString().split('T')[0]
  const key = `grimoire/reviews/${date}.md`
  const obj = await c.env.R2.get(key)
  if (!obj) return c.json({ error: 'No review found', date }, 404)
  return c.text(await obj.text())
})

// --- Workflow Re-exports (Cloudflare requires class exports from main entry) ---

export { BulkRetagWorkflow } from './workflows'
export { BulkCorrespondencesWorkflow } from './workflows'

// --- Default Export ---

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await scanAndEnqueue(env, ctx)
  },

  async queue(
    batch: MessageBatch<ClassifyMessage | DiscoveryMessage | VectorizeMessage | EnrichMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const queue = batch.queue

    if (queue.endsWith('-dlq')) {
      await handleDlqBatch(batch, env)
      return
    }

    switch (queue) {
      case 'grimoire-classify':
      case 'grimoire-discovery':
        await handleClassifyBatch(batch as MessageBatch<ClassifyMessage | DiscoveryMessage>, env)
        break
      case 'grimoire-vectorize':
        await handleVectorizeBatch(batch as MessageBatch<VectorizeMessage>, env)
        break
      case 'grimoire-enrich':
        await handleEnrichBatch(batch as MessageBatch<EnrichMessage>, env)
        break
      default:
        console.error(`[queue] Unknown queue: ${queue}`)
        batch.ackAll()
    }
  },
}
