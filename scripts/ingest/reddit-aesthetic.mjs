#!/usr/bin/env node
/**
 * Reddit Aesthetic-Sub Moodboard Ingestion
 *
 * Treats each subreddit as a single moodboard: 9 top-of-window qualifying image posts
 * become the source set. Reuses the moodboards table, /admin/moodboard/register,
 * /image/extract/batch, and /admin/moodboard/aggregate endpoints unchanged.
 *
 * Public JSON endpoints only. No OAuth. User-Agent header is mandatory.
 *
 * Usage:
 *   node scripts/ingest/reddit-aesthetic.mjs --discover-only
 *   node scripts/ingest/reddit-aesthetic.mjs --limit 3
 *   node scripts/ingest/reddit-aesthetic.mjs --sub Liminalspace
 *   node scripts/ingest/reddit-aesthetic.mjs --sub Y2K --window month
 *   node scripts/ingest/reddit-aesthetic.mjs --sub WeirdCore --skip-composite
 */

import { createHash } from 'node:crypto'
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { sleep, WORKER_URL } from './utils/env.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

// Canonical allowlist. Adding subs is a one-line edit. No per-run override flag for v0.
const SUBREDDITS = [
  'CottagecorePics',
  'Liminalspace',
  'RetroFuturism',
  'Cyberpunk',
  'VHSAesthetic',
  'Outrun',
  'CozyPlaces',
  'DarkAcademia',
  'Y2K',
  'WeirdCore',
  'FrutigerAero',
  'Dreamcore',
  'BackroomsIRL',
  'ImaginaryCityscapes',
  'Vaporwave',
]

const SOURCE = 'reddit'
const LICENSE = 'reddit-user-content'
const TARGET_IMAGES_PER_MOODBOARD = 9
const USER_AGENT = 'HobFarm-Moodboard-Ingestion/1.0 (by /u/anonymous)'
const REDDIT_BASE = 'https://www.reddit.com'
const REDDIT_OLD_BASE = 'https://old.reddit.com'
const SUB_DELAY_MS = 1000
const IMAGE_DELAY_MS = 500
const FETCH_TIMEOUT_MS = 15_000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // matches fromImage.ts /extract endpoint guard
const EXTRACT_BATCH_SIZE = 3 // worker wall-time budget: 3 Gemma calls per invocation, script loops
const SUBREDDIT_DESCRIPTION_MAX = 1500
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif)$/i
const IMAGE_URL_HOSTS = ['i.redd.it', 'i.imgur.com']

// ─── CLI ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const flags = {
    discoverOnly: args.includes('--discover-only'),
    skipComposite: args.includes('--skip-composite'),
  }
  const limitIdx = args.indexOf('--limit')
  flags.limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null
  const subIdx = args.indexOf('--sub')
  flags.sub = subIdx >= 0 ? args[subIdx + 1] : null
  const windowIdx = args.indexOf('--window')
  flags.window = windowIdx >= 0 ? args[windowIdx + 1] : null
  if (flags.window && !['week', 'month'].includes(flags.window)) {
    throw new Error(`--window must be "week" or "month", got "${flags.window}"`)
  }
  return flags
}

// ─── Env / auth ─────────────────────────────────────────────────────

function getServiceToken() {
  const token = process.env.HOBBOT_SERVICE_TOKEN
  if (!token) throw new Error('HOBBOT_SERVICE_TOKEN not set in .env or environment')
  return token
}

// ─── Reddit JSON ────────────────────────────────────────────────────

async function redditGetJson(path, { allowOldFallback = true } = {}) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let res = await fetch(`${REDDIT_BASE}${path}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    })
    if (res.status === 403 && allowOldFallback) {
      console.log(`  [reddit] 403 on www; retrying old.reddit.com for ${path}`)
      res = await fetch(`${REDDIT_OLD_BASE}${path}`, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      })
    }
    if (!res.ok) throw new Error(`reddit HTTP ${res.status} for ${path}`)
    return await res.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function getSubAbout(sub) {
  const data = await redditGetJson(`/r/${sub}/about.json`)
  const d = data?.data ?? {}
  return {
    display_name_prefixed: d.display_name_prefixed ?? `r/${sub}`,
    public_description: stripRedditMarkdown(d.public_description ?? d.description ?? '').slice(0, SUBREDDIT_DESCRIPTION_MAX),
    subscribers: d.subscribers ?? null,
    url_path: d.url ?? `/r/${sub}/`,
  }
}

async function getSubTop(sub, window, limit = 50) {
  const data = await redditGetJson(`/r/${sub}/top.json?t=${window}&limit=${limit}`)
  const children = data?.data?.children ?? []
  return children.map((c) => c.data).filter(Boolean)
}

function stripRedditMarkdown(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Post filter ────────────────────────────────────────────────────

function isImagePost(post) {
  if (!post || !post.url) return false
  if (post.is_gallery || post.is_video) return false
  if (post.over_18) return false
  if (post.removed_by_category) return false
  if (post.stickied) return false

  const postHintOk = post.post_hint === 'image'
  const extOk = IMAGE_EXT_RE.test(post.url)
  let hostOk = false
  try {
    const u = new URL(post.url)
    hostOk = IMAGE_URL_HOSTS.includes(u.hostname)
  } catch {
    return false
  }

  return postHintOk || extOk || hostOk
}

// ─── Image download + hash + extension ──────────────────────────────

const CONTENT_TYPE_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

async function downloadImage(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) throw new Error(`image HTTP ${res.status}`)
    const contentType = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType }
  } finally {
    clearTimeout(timeoutId)
  }
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

function resolveExtension(url, contentType) {
  // 1. URL suffix
  const urlExt = extname(url.split('?')[0]).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(urlExt)) return urlExt
  // 2. Content-Type header
  const ctExt = CONTENT_TYPE_TO_EXT[contentType]
  if (ctExt) return ctExt
  // 3. Default
  return '.jpg'
}

// ─── R2 via wrangler CLI (mirrors aesthetics-wiki.mjs) ──────────────

function r2PutFile(key, filePath) {
  execSync(
    `npx wrangler r2 object put "grimoire/${key}" --file "${filePath}" --remote`,
    { stdio: 'pipe', cwd: REPO_ROOT },
  )
}

function r2PutText(key, text, contentType = 'application/json') {
  const tempFile = join(tmpdir(), `r2put-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tempFile, text)
  try {
    execSync(
      `npx wrangler r2 object put "grimoire/${key}" --file "${tempFile}" --content-type "${contentType}" --remote`,
      { stdio: 'pipe', cwd: REPO_ROOT },
    )
  } finally {
    try { unlinkSync(tempFile) } catch {}
  }
}

// ─── Grimoire worker calls ──────────────────────────────────────────

async function grimoirePost(path, body, { auth } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = `Bearer ${getServiceToken()}`
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) {
    const err = new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function moodboardStatus(moodboardId) {
  try {
    return await grimoirePost('/admin/moodboard/status', { moodboard_id: moodboardId }, { auth: true })
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

async function moodboardRegister(row) {
  return grimoirePost('/admin/moodboard/register', row, { auth: true })
}

async function moodboardAggregate(moodboardId) {
  return grimoirePost('/admin/moodboard/aggregate', { moodboard_id: moodboardId }, { auth: true })
}

async function imageExtractBatch(prefix, moodboardId, limit) {
  return grimoirePost('/image/extract/batch', { prefix, moodboard_id: moodboardId, limit })
}

// ─── Composite (optional sharp, mirrors aesthetics-wiki.mjs) ────────

async function tryLoadSharp() {
  try {
    const mod = await import('sharp')
    return mod.default
  } catch {
    return null
  }
}

async function buildComposite(sharp, imageBuffers) {
  const cell = 512
  const grid = 3
  const canvas = sharp({
    create: {
      width: cell * grid,
      height: cell * grid,
      channels: 3,
      background: { r: 136, g: 136, b: 136 },
    },
  })

  const overlays = []
  for (let i = 0; i < Math.min(imageBuffers.length, grid * grid); i++) {
    const resized = await sharp(imageBuffers[i])
      .resize(cell, cell, { fit: 'cover' })
      .toBuffer()
    overlays.push({
      input: resized,
      left: (i % grid) * cell,
      top: Math.floor(i / grid) * cell,
    })
  }

  return canvas.composite(overlays).jpeg({ quality: 85 }).toBuffer()
}

// ─── Ingestion pipeline per subreddit ───────────────────────────────

async function ingestSubreddit(subName, { skipComposite, windowFlag }) {
  const slug = subName.toLowerCase()
  const moodboardId = `${SOURCE}:${slug}`
  const r2Prefix = `moodboards/${SOURCE}/${slug}`
  const subUrl = `${REDDIT_BASE}/r/${subName}/`

  console.log(`\n[${slug}] starting (r/${subName})`)

  // 3b. Idempotency.
  const existing = await moodboardStatus(moodboardId)
  if (existing?.moodboard?.status === 'aggregated' || existing?.moodboard?.status === 'reviewed') {
    console.log(`[${slug}] already ${existing.moodboard.status}, skipping`)
    return { slug, moodboardId, status: existing.moodboard.status, skipped: true }
  }

  // 3c. Subreddit metadata.
  let about
  try {
    about = await getSubAbout(subName)
  } catch (err) {
    console.log(`[${slug}] about.json failed: ${err.message}`)
    return { slug, moodboardId, error: 'about_failed', detail: err.message }
  }

  // 3d. Top posts with window fallback.
  const primaryWindow = windowFlag === 'month' ? 'month' : 'week'
  let topPosts
  try {
    topPosts = await getSubTop(subName, primaryWindow, primaryWindow === 'week' ? 50 : 100)
  } catch (err) {
    console.log(`[${slug}] top.json (${primaryWindow}) failed: ${err.message}`)
    return { slug, moodboardId, error: 'top_failed', detail: err.message }
  }

  let qualifying = topPosts.filter(isImagePost)
  let windowUsed = primaryWindow

  if (qualifying.length < TARGET_IMAGES_PER_MOODBOARD && primaryWindow === 'week' && windowFlag !== 'week') {
    console.log(`[${slug}] only ${qualifying.length} qualifying posts in week; retrying month`)
    try {
      const monthPosts = await getSubTop(subName, 'month', 100)
      const monthQualifying = monthPosts.filter(isImagePost)
      if (monthQualifying.length >= TARGET_IMAGES_PER_MOODBOARD) {
        qualifying = monthQualifying
        windowUsed = 'month'
      } else {
        qualifying = monthQualifying
        windowUsed = 'month'
      }
    } catch (err) {
      console.log(`[${slug}] top.json (month) failed: ${err.message}`)
    }
  }

  if (qualifying.length < TARGET_IMAGES_PER_MOODBOARD) {
    console.log(`[${slug}] only ${qualifying.length} qualifying posts across ${windowUsed}; skipping (undersized moodboards not produced)`)
    return { slug, moodboardId, error: 'undersized', window: windowUsed, qualifying_count: qualifying.length }
  }

  console.log(`[${slug}] ${qualifying.length} qualifying posts from ${windowUsed}-top; downloading up to ${TARGET_IMAGES_PER_MOODBOARD}`)

  // 3e. Download + hash + upload. Iterate through the ranked qualifying list,
  // skip oversize, stop once we have TARGET_IMAGES_PER_MOODBOARD valid uploads.
  const tempDir = join(tmpdir(), `reddit-ingest-${slug}`)
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })

  const sourceImageKeys = []
  const imageBuffers = []
  const postMetadata = []

  for (let i = 0; i < qualifying.length; i++) {
    if (sourceImageKeys.length >= TARGET_IMAGES_PER_MOODBOARD) break
    const post = qualifying[i]
    if (i > 0) await sleep(IMAGE_DELAY_MS)

    try {
      const { buffer, contentType } = await downloadImage(post.url)
      if (buffer.length > MAX_IMAGE_BYTES) {
        console.log(`[${slug}] post ${i + 1} (${Math.round(buffer.length / 1024 / 1024)}MB) exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit, skipping to next qualifying post`)
        continue
      }
      const ext = resolveExtension(post.url, contentType)
      const hash = hashBuffer(buffer)
      const r2Key = `${r2Prefix}/sources/${hash}${ext}`

      const tempFile = join(tempDir, `${hash}${ext}`)
      writeFileSync(tempFile, buffer)
      try {
        r2PutFile(r2Key, tempFile)
        console.log(`[${slug}] uploaded ${r2Key} (${Math.round(buffer.length / 1024)}KB, ct=${contentType || '?'})`)
        sourceImageKeys.push(r2Key)
        imageBuffers.push(buffer)
        postMetadata.push({
          reddit_post_id: `t3_${post.id}`,
          permalink: post.permalink,
          author: post.author ? `u/${post.author}` : null,
          score: post.score ?? null,
          created_utc: post.created_utc ?? null,
          url: post.url,
        })
      } finally {
        try { unlinkSync(tempFile) } catch {}
      }
    } catch (err) {
      console.log(`[${slug}] post ${i + 1} (${post.url}) failed: ${err.message}`)
    }
  }

  if (sourceImageKeys.length < TARGET_IMAGES_PER_MOODBOARD) {
    console.log(`[${slug}] only ${sourceImageKeys.length}/${TARGET_IMAGES_PER_MOODBOARD} images uploaded successfully; skipping aggregation`)
    return { slug, moodboardId, error: 'download_underfilled', uploaded: sourceImageKeys.length }
  }

  // 3f. Optional composite.
  let compositeKey = null
  if (!skipComposite) {
    const sharp = await tryLoadSharp()
    if (!sharp) {
      console.log(`[${slug}] sharp not available, skipping composite (run "cd scripts && npm install" to enable)`)
    } else {
      try {
        const compositeBuffer = await buildComposite(sharp, imageBuffers)
        const compositeTemp = join(tempDir, 'composite.jpg')
        writeFileSync(compositeTemp, compositeBuffer)
        compositeKey = `${r2Prefix}/composite.jpg`
        r2PutFile(compositeKey, compositeTemp)
        unlinkSync(compositeTemp)
        console.log(`[${slug}] composite uploaded (${Math.round(compositeBuffer.length / 1024)}KB)`)
      } catch (err) {
        console.log(`[${slug}] composite failed (non-fatal): ${err.message}`)
      }
    }
  }

  // 3g. Manifest.
  const manifest = {
    moodboard_id: moodboardId,
    source: SOURCE,
    slug,
    title: about.display_name_prefixed,
    source_url: subUrl,
    source_description: about.public_description,
    license: LICENSE,
    source_image_keys: sourceImageKeys,
    composite_r2_key: compositeKey,
    source_post_metadata: postMetadata,
    window_used: windowUsed,
    ingested_at: new Date().toISOString(),
  }
  const manifestKey = `${r2Prefix}/manifest.json`
  r2PutText(manifestKey, JSON.stringify(manifest, null, 2))
  console.log(`[${slug}] manifest uploaded`)

  // 3h. Register moodboard row.
  await moodboardRegister({
    moodboard_id: moodboardId,
    source: SOURCE,
    slug,
    title: about.display_name_prefixed,
    source_url: subUrl,
    source_description: about.public_description,
    license: LICENSE,
    source_count: sourceImageKeys.length,
    composite_r2_key: compositeKey,
    manifest_r2_key: manifestKey,
    metadata: JSON.stringify(manifest),
  })
  console.log(`[${slug}] registered moodboard row`)

  // 3i. Batch extraction.
  const extractPrefix = `${r2Prefix}/sources/`
  let invocations = 0
  while (true) {
    invocations++
    const data = await imageExtractBatch(extractPrefix, moodboardId, EXTRACT_BATCH_SIZE)
    const remaining = data.remaining ?? 0
    console.log(`[${slug}] extract batch #${invocations}: processed=${data.processed} skipped=${data.skipped} failed=${data.failed} remaining=${remaining}`)
    if (remaining === 0) break
    if (invocations > 20) {
      console.log(`[${slug}] batch loop safety cap hit`)
      break
    }
  }

  // 3k. Aggregate.
  try {
    const agg = await moodboardAggregate(moodboardId)
    console.log(`[${slug}] aggregated: ir_r2_key=${agg.ir_r2_key} model=${agg.model} ${agg.duration_ms}ms fallback_used=${agg.fallback_used}`)
    return { slug, moodboardId, status: 'aggregated', ir_r2_key: agg.ir_r2_key, window: windowUsed }
  } catch (err) {
    console.log(`[${slug}] aggregation failed: ${err.message}`)
    return { slug, moodboardId, error: 'aggregation_failed', detail: err.message, window: windowUsed }
  }
}

// ─── Discovery ──────────────────────────────────────────────────────

async function discoverAllSubs(limit) {
  const subs = limit ? SUBREDDITS.slice(0, limit) : SUBREDDITS
  for (const sub of subs) {
    try {
      const about = await getSubAbout(sub)
      console.log(`  r/${sub}  subscribers=${about.subscribers ?? '?'}  desc="${about.public_description.slice(0, 200)}"`)
    } catch (err) {
      console.log(`  r/${sub}  ERROR: ${err.message}`)
    }
    await sleep(SUB_DELAY_MS)
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs()

  if (flags.discoverOnly) {
    console.log(`[discover] fetching about.json for ${flags.limit ? flags.limit : SUBREDDITS.length} sub(s)...`)
    await discoverAllSubs(flags.limit)
    return
  }

  let subs
  if (flags.sub) {
    subs = [flags.sub]
  } else {
    subs = flags.limit ? SUBREDDITS.slice(0, flags.limit) : SUBREDDITS
  }

  const results = []
  for (const sub of subs) {
    try {
      const result = await ingestSubreddit(sub, { skipComposite: flags.skipComposite, windowFlag: flags.window })
      results.push(result)
    } catch (err) {
      console.log(`[${sub}] FATAL: ${err.message}`)
      results.push({ sub, error: 'fatal', detail: err.message })
    }
    await sleep(SUB_DELAY_MS)
  }

  console.log(`\n[summary] ${results.length} subreddit(s) processed:`)
  for (const r of results) {
    if (r.skipped) console.log(`  SKIP  ${r.slug}`)
    else if (r.error) console.log(`  FAIL  ${r.slug ?? r.sub}: ${r.error}${r.detail ? ` (${r.detail})` : ''}${r.window ? ` [${r.window}]` : ''}`)
    else console.log(`  OK    ${r.slug} [${r.window}]`)
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
