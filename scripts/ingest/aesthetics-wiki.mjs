#!/usr/bin/env node
/**
 * Aesthetics Wiki Moodboard Ingestion
 *
 * Pulls aesthetics from aesthetics.fandom.com via MediaWiki API, uploads 9 source
 * images per aesthetic to R2, triggers per-image extraction, then aggregates N IRs
 * into one moodboard IR via /admin/moodboard/aggregate.
 *
 * State is observation-driven: R2 and D1 are authoritative. moodboards.status is advisory.
 *
 * Usage:
 *   node scripts/ingest/aesthetics-wiki.mjs --discover-only --limit 100
 *   node scripts/ingest/aesthetics-wiki.mjs --limit 3
 *   node scripts/ingest/aesthetics-wiki.mjs --slug cottagecore
 *   node scripts/ingest/aesthetics-wiki.mjs --slug cottagecore --skip-composite
 *
 * Compositing (optional): requires `(cd scripts && npm install)` for sharp.
 * If sharp is not installed, composite phase is skipped with a warning.
 */

import { createHash } from 'node:crypto'
import { writeFileSync, existsSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { sleep, WORKER_URL } from './utils/env.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const FANDOM_API = 'https://aesthetics.fandom.com/api.php'
// "Category:Aesthetics" is empty on this wiki; the authoritative root is "Aesthetics Wiki Articles".
const CATEGORY = 'Category:Aesthetics Wiki Articles'
const USER_AGENT = 'HobBot/1.0 (https://hob.farm; grimoire moodboard ingest)'
const SOURCE = 'aesthetics-wiki'
const LICENSE = 'CC-BY-SA'
const TARGET_IMAGES_PER_MOODBOARD = 9
// Fandom thumbnails are sized for display (~200-300px), not source image dimensions.
// The normalized URL strips the scale-to-width-down suffix to get the original high-res file.
// Only filter obvious chrome (tiny icons, site logos); let content images through regardless of thumbnail size.
const MIN_THUMBNAIL_WIDTH = 100
const EXTRACT_BATCH_SIZE = 3 // worker wall-time budget: 3 Gemma calls per invocation, script loops
const DESCRIPTION_MAX = 1500
const FETCH_TIMEOUT_MS = 15_000
const MEDIAWIKI_DELAY_MS = 500
const NAMESPACE_PREFIXES = [
  'Template:', 'User:', 'Category:', 'File:',
  'Help:', 'Special:', 'MediaWiki:', 'Module:', 'Portal:',
]

// ─── CLI ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const flags = {
    discoverOnly: args.includes('--discover-only'),
    skipComposite: args.includes('--skip-composite'),
  }
  const limitIdx = args.indexOf('--limit')
  flags.limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null
  const slugIdx = args.indexOf('--slug')
  flags.slug = slugIdx >= 0 ? args[slugIdx + 1] : null
  return flags
}

// ─── Env / auth ─────────────────────────────────────────────────────

function getServiceToken() {
  const token = process.env.HOBBOT_SERVICE_TOKEN
  if (!token) throw new Error('HOBBOT_SERVICE_TOKEN not set in .env or environment')
  return token
}

// ─── MediaWiki ──────────────────────────────────────────────────────

async function mediawikiGet(params) {
  const url = new URL(FANDOM_API)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) throw new Error(`MediaWiki HTTP ${res.status} for ${url.pathname}?${url.searchParams}`)
    return await res.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function discoverAesthetics(limit) {
  const all = []
  let cmcontinue = null
  while (true) {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: CATEGORY,
      cmlimit: '500',
      cmtype: 'page',
      format: 'json',
    }
    if (cmcontinue) params.cmcontinue = cmcontinue

    const data = await mediawikiGet(params)
    const members = data.query?.categorymembers ?? []
    for (const m of members) {
      if (!isValidAestheticTitle(m.title)) continue
      all.push({ title: m.title, pageid: m.pageid })
      if (limit && all.length >= limit) return all
    }
    cmcontinue = data.continue?.cmcontinue
    if (!cmcontinue) break
    await sleep(MEDIAWIKI_DELAY_MS)
  }
  return all
}

function isValidAestheticTitle(title) {
  if (title.includes('List of')) return false
  if (title.endsWith('(disambiguation)')) return false
  for (const prefix of NAMESPACE_PREFIXES) {
    if (title.startsWith(prefix)) return false
  }
  return true
}

function deriveSlug(title) {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function fetchAestheticPage(title) {
  const data = await mediawikiGet({
    action: 'parse',
    page: title,
    format: 'json',
    prop: 'text|images',
  })
  if (data.error) {
    throw new Error(`parse error for "${title}": ${data.error.info ?? data.error.code}`)
  }
  return data.parse
}

function extractSourceDescription(html) {
  const cleaned = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')

  const paragraphs = []
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let m
  while ((m = pRe.exec(cleaned)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) paragraphs.push(text)
    if (paragraphs.length >= 3) break
  }

  const joined = paragraphs.join('\n\n').trim()
  return joined.length > DESCRIPTION_MAX
    ? joined.slice(0, DESCRIPTION_MAX).replace(/\s+\S*$/, '') + '...'
    : joined
}

function extractImageUrls(html) {
  const urls = []
  const seen = new Set()

  // Gather all <img> tags under <figure> and gallery containers first, then fallback to all.
  // Fandom image URLs typically look like: https://static.wikia.nocookie.net/aesthetics/images/.../file.jpg/revision/latest/scale-to-width-down/{W}?cb=...
  // Strip the thumbnail suffix to get the original.
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = imgRe.exec(html)) !== null) {
    const rawSrc = m[1]
    const normalized = normalizeFandomImageUrl(rawSrc)
    if (!normalized) continue
    if (seen.has(normalized)) continue
    if (/\.svg(\?|$)/i.test(normalized)) continue
    if (isLikelyChrome(rawSrc, m[0])) continue
    if (!meetsMinWidth(rawSrc)) continue
    seen.add(normalized)
    urls.push(normalized)
  }

  return urls
}

function normalizeFandomImageUrl(src) {
  if (!src) return null
  // Data URIs, inline SVG, etc.
  if (src.startsWith('data:')) return null
  // Fandom thumbnails: strip /revision/latest/... suffix
  const base = src.replace(/\/revision\/latest.*$/, '').replace(/\/scale-to-width-down\/\d+/, '')
  // Strip query string
  const clean = base.split('?')[0]
  if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(clean)) return null
  return clean
}

function isLikelyChrome(src, fullTag) {
  const lc = src.toLowerCase()
  if (lc.includes('site-logo') || lc.includes('sitelogo') || lc.includes('wiki-logo')) return true
  if (lc.includes('wordmark')) return true
  if (/\bicon\b/i.test(fullTag) && /\b(width|height)="?(\d+)/i.test(fullTag)) {
    const widthMatch = fullTag.match(/\bwidth="?(\d+)/i)
    if (widthMatch && parseInt(widthMatch[1], 10) < 100) return true
  }
  return false
}

function meetsMinWidth(src) {
  const m = src.match(/scale-to-width-down\/(\d+)/i)
  if (m) {
    return parseInt(m[1], 10) >= MIN_THUMBNAIL_WIDTH
  }
  // No explicit size in URL -> assume original, meets width.
  return true
}

// ─── Image download + hash ──────────────────────────────────────────

async function downloadImage(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) throw new Error(`image HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer
  } finally {
    clearTimeout(timeoutId)
  }
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

function extFromUrl(url) {
  const ext = extname(url.split('?')[0]).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext
  return '.jpg'
}

// ─── R2 via wrangler CLI ────────────────────────────────────────────

function r2ObjectHead(key) {
  // wrangler doesn't expose a head command directly in a clean way; use `list` with a specific prefix.
  try {
    const out = execSync(
      `npx wrangler r2 object get "grimoire/${key}" --pipe --remote`,
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT },
    )
    return out.length > 0
  } catch {
    return false
  }
}

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

// ─── Composite (optional sharp) ─────────────────────────────────────

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

// ─── Ingestion pipeline per aesthetic ───────────────────────────────

async function ingestAesthetic(title, { skipComposite }) {
  const slug = deriveSlug(title)
  const moodboardId = `${SOURCE}:${slug}`
  const r2Prefix = `moodboards/${SOURCE}/${slug}`
  const sourceUrl = `https://aesthetics.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

  console.log(`\n[${slug}] starting (${title})`)

  const existing = await moodboardStatus(moodboardId)
  if (existing?.moodboard?.status === 'aggregated' || existing?.moodboard?.status === 'reviewed') {
    console.log(`[${slug}] already ${existing.moodboard.status}, skipping`)
    return { slug, moodboardId, status: existing.moodboard.status, skipped: true }
  }

  // 1. Fetch page.
  let parsed
  try {
    parsed = await fetchAestheticPage(title)
  } catch (err) {
    console.log(`[${slug}] fetch failed: ${err.message}`)
    return { slug, moodboardId, error: 'fetch_failed' }
  }

  const html = parsed.text?.['*'] ?? ''
  const sourceDescription = extractSourceDescription(html)
  const imageUrls = extractImageUrls(html).slice(0, TARGET_IMAGES_PER_MOODBOARD)

  if (imageUrls.length === 0) {
    console.log(`[${slug}] no images found, skipping`)
    return { slug, moodboardId, error: 'no_images' }
  }

  console.log(`[${slug}] found ${imageUrls.length} image(s), description ${sourceDescription.length} chars`)

  // 2. Download + hash + upload images.
  const tempDir = join(tmpdir(), `aesthetics-wiki-${slug}`)
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })

  const sourceImageKeys = []
  const imageBuffers = []

  for (let i = 0; i < imageUrls.length; i++) {
    const imgUrl = imageUrls[i]
    try {
      const buffer = await downloadImage(imgUrl)
      imageBuffers.push(buffer)
      const hash = hashBuffer(buffer)
      const ext = extFromUrl(imgUrl)
      const r2Key = `${r2Prefix}/sources/${hash}${ext}`

      const tempFile = join(tempDir, `${hash}${ext}`)
      writeFileSync(tempFile, buffer)
      try {
        r2PutFile(r2Key, tempFile)
        console.log(`[${slug}] uploaded ${r2Key} (${Math.round(buffer.length / 1024)}KB)`)
        sourceImageKeys.push(r2Key)
      } finally {
        try { unlinkSync(tempFile) } catch {}
      }
    } catch (err) {
      console.log(`[${slug}] image ${i + 1} failed: ${err.message}`)
    }
  }

  if (sourceImageKeys.length === 0) {
    console.log(`[${slug}] no images uploaded, aborting`)
    return { slug, moodboardId, error: 'upload_failed' }
  }

  // 3. Optional composite.
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

  // 4. Write manifest.
  const manifest = {
    moodboard_id: moodboardId,
    source: SOURCE,
    slug,
    title,
    source_url: sourceUrl,
    source_description: sourceDescription,
    license: LICENSE,
    source_image_keys: sourceImageKeys,
    composite_r2_key: compositeKey,
    ingested_at: new Date().toISOString(),
  }
  const manifestKey = `${r2Prefix}/manifest.json`
  r2PutText(manifestKey, JSON.stringify(manifest, null, 2))
  console.log(`[${slug}] manifest uploaded`)

  // 5. Register moodboard row.
  await moodboardRegister({
    moodboard_id: moodboardId,
    source: SOURCE,
    slug,
    title,
    source_url: sourceUrl,
    source_description: sourceDescription,
    license: LICENSE,
    source_count: sourceImageKeys.length,
    composite_r2_key: compositeKey,
    manifest_r2_key: manifestKey,
    metadata: JSON.stringify(manifest),
  })
  console.log(`[${slug}] registered moodboard row`)

  // 6. Trigger batch extraction. Loop if remaining > 0.
  const extractPrefix = `${r2Prefix}/sources/`
  let totalProcessed = 0
  let invocations = 0
  while (true) {
    invocations++
    const data = await imageExtractBatch(extractPrefix, moodboardId, EXTRACT_BATCH_SIZE)
    totalProcessed += data.processed ?? 0
    const remaining = data.remaining ?? 0
    console.log(`[${slug}] extract batch #${invocations}: processed=${data.processed} skipped=${data.skipped} failed=${data.failed} remaining=${remaining}`)
    if (remaining === 0) break
    if (invocations > 20) {
      console.log(`[${slug}] batch loop safety cap hit`)
      break
    }
  }

  // 7. Aggregate.
  try {
    const agg = await moodboardAggregate(moodboardId)
    console.log(`[${slug}] aggregated: ir_r2_key=${agg.ir_r2_key} model=${agg.model} ${agg.duration_ms}ms fallback_used=${agg.fallback_used}`)
    return { slug, moodboardId, status: 'aggregated', ir_r2_key: agg.ir_r2_key }
  } catch (err) {
    console.log(`[${slug}] aggregation failed: ${err.message}`)
    return { slug, moodboardId, error: 'aggregation_failed', detail: err.message }
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs()

  let titles

  if (flags.slug) {
    // Single-slug mode: reconstruct the MediaWiki title heuristically.
    // User passes the canonical title via --slug (with spaces replaced by underscores is also fine).
    titles = [{ title: flags.slug.replace(/_/g, ' '), pageid: null }]
  } else {
    console.log(`[discover] fetching Category:Aesthetics members${flags.limit ? ` (limit ${flags.limit})` : ''}...`)
    titles = await discoverAesthetics(flags.limit ?? null)
    console.log(`[discover] ${titles.length} candidate aesthetics found`)
  }

  if (flags.discoverOnly) {
    for (const t of titles) {
      console.log(`  ${t.title} (pageid=${t.pageid ?? '?'})`)
    }
    return
  }

  const results = []
  for (const t of titles) {
    try {
      const result = await ingestAesthetic(t.title, { skipComposite: flags.skipComposite })
      results.push(result)
    } catch (err) {
      console.log(`[${t.title}] FATAL: ${err.message}`)
      results.push({ title: t.title, error: 'fatal', detail: err.message })
    }
    await sleep(MEDIAWIKI_DELAY_MS)
  }

  console.log(`\n[summary] ${results.length} aesthetic(s) processed:`)
  for (const r of results) {
    if (r.skipped) console.log(`  SKIP  ${r.slug}`)
    else if (r.error) console.log(`  FAIL  ${r.slug ?? r.title}: ${r.error}${r.detail ? ` (${r.detail})` : ''}`)
    else console.log(`  OK    ${r.slug}`)
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
