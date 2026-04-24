#!/usr/bin/env node
/**
 * RSS Feed URL Verifier
 *
 * Fetches each candidate feed URL and checks for valid RSS/Atom XML.
 * Outputs verified and dead lists as JSON for migration generation.
 *
 * Usage: node scripts/verify-rss-feeds.mjs
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from './ingest/utils/env.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VERIFIED_FILE = join(__dirname, 'rss-feeds-verified.json')
const DEAD_FILE = join(__dirname, 'rss-feeds-dead.json')

// All candidate feeds with metadata
const CANDIDATES = [
  // === AI research blogs (core, weight 1.5, poll 360min) ===
  { id: 'rss-huggingface', name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-deepmind', name: 'DeepMind Blog', url: 'https://deepmind.com/blog/feed/basic/', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-bair', name: 'BAIR Berkeley', url: 'https://bair.berkeley.edu/blog/feed.xml', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-eleutherai', name: 'EleutherAI', url: 'https://blog.eleuther.ai/index.xml', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-stanford-crfm', name: 'Stanford CRFM', url: 'https://crfm.stanford.edu/feed', tier: 'core', weight: 1.5, poll: 360 },

  // === AI image/video provider blogs (core, weight 1.5, poll 360min) ===
  { id: 'rss-replicate', name: 'Replicate Blog', url: 'https://replicate.com/blog/rss', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-stability-ai', name: 'Stability AI', url: 'https://stability.ai/blog?format=rss', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-nvidia-dev', name: 'NVIDIA Developer Blog', url: 'https://developer.nvidia.com/blog/feed', tier: 'core', weight: 1.5, poll: 360 },

  // === StyleFusion provider ecosystem (core, weight 1.5, poll 360min) ===
  { id: 'rss-fal-ai', name: 'fal.ai Blog', url: 'https://blog.fal.ai/rss/', tier: 'core', weight: 1.5, poll: 360, alts: ['https://blog.fal.ai/rss.xml'] },
  { id: 'rss-runway', name: 'Runway Research', url: 'https://runwayml.com/research/rss.xml', tier: 'core', weight: 1.5, poll: 360, alts: ['https://runwayml.com/feed'] },
  { id: 'rss-comfyui', name: 'ComfyUI Releases', url: 'https://github.com/comfyanonymous/ComfyUI/releases.atom', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-bfl', name: 'Black Forest Labs', url: 'https://blackforestlabs.ai/feed/', tier: 'core', weight: 1.5, poll: 360 },
  { id: 'rss-civitai', name: 'Civitai Blog', url: 'https://civitai.com/api/rss', tier: 'core', weight: 1.5, poll: 360 },

  // === Tech journalism (adjacent, weight 1.0, poll 180min) ===
  { id: 'rss-wired-ai', name: 'Wired AI', url: 'https://www.wired.com/feed/tag/ai/latest/rss', tier: 'adjacent', weight: 1.0, poll: 180 },
  { id: 'rss-mit-tech-review', name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', tier: 'adjacent', weight: 1.0, poll: 180 },
  { id: 'rss-techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', tier: 'adjacent', weight: 1.0, poll: 180 },
  { id: 'rss-404-media', name: '404 Media', url: 'https://www.404media.co/rss', tier: 'adjacent', weight: 1.0, poll: 180 },
  { id: 'rss-venturebeat-ai', name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', tier: 'adjacent', weight: 1.0, poll: 180 },

  // === Individual researchers/writers (adjacent, weight 1.0, poll 360min) ===
  { id: 'rss-simon-willison', name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-chip-huyen', name: 'Chip Huyen', url: 'https://huyenchip.com/feed', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-latent-space', name: 'Latent Space', url: 'https://www.latent.space/feed', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-one-useful-thing', name: 'One Useful Thing', url: 'https://www.oneusefulthing.org/feed', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-ahead-of-ai', name: 'Ahead of AI (Raschka)', url: 'https://magazine.sebastianraschka.com/feed', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-the-decoder', name: 'The Decoder', url: 'https://the-decoder.com/feed/', tier: 'adjacent', weight: 1.0, poll: 360 },

  // === arXiv feeds (adjacent, weight 0.8, poll 720min) ===
  { id: 'rss-arxiv-cs-cv', name: 'arXiv cs.CV', url: 'https://arxiv.org/rss/cs.CV', tier: 'adjacent', weight: 0.8, poll: 720 },
  { id: 'rss-arxiv-cs-lg', name: 'arXiv cs.LG', url: 'https://arxiv.org/rss/cs.LG', tier: 'adjacent', weight: 0.8, poll: 720 },

  // === Visual arts, creative tech (adjacent, weight 1.0, poll 360min) ===
  { id: 'rss-colossal', name: 'Colossal', url: 'https://www.thisiscolossal.com/feed/', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-creative-bloq', name: 'Creative Bloq', url: 'https://www.creativebloq.com/feed', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-its-nice-that', name: "It's Nice That", url: 'https://www.itsnicethat.com/rss', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-booooooom', name: 'Booooooom', url: 'https://www.booooooom.com/feed/', tier: 'adjacent', weight: 1.0, poll: 360 },
  { id: 'rss-petapixel', name: 'PetaPixel', url: 'https://petapixel.com/feed', tier: 'adjacent', weight: 1.0, poll: 360 },

  // === YouTube channels (adjacent, weight 1.0, poll 720min, awareness-only) ===
  { id: 'rss-yt-two-minute-papers', name: 'Two Minute Papers', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', tier: 'adjacent', weight: 1.0, poll: 720, ingest_to_grimoire: false },
  { id: 'rss-yt-matt-wolfe', name: 'Matt Wolfe', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UChpleBmo18P08aKCIgti38g', tier: 'adjacent', weight: 1.0, poll: 720, ingest_to_grimoire: false },
  { id: 'rss-yt-ai-explained', name: 'AI Explained', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNJ1Ymd5yFuUPtn21xtRbbw', tier: 'adjacent', weight: 1.0, poll: 720, ingest_to_grimoire: false },

  // === Hospitality, live events, indie (long_tail, weight 0.5, poll 720min) ===
  { id: 'rss-skift', name: 'Skift', url: 'https://skift.com/feed/', tier: 'long_tail', weight: 0.5, poll: 720 },
  { id: 'rss-restaurant-biz', name: 'Restaurant Business Online', url: 'https://www.restaurantbusinessonline.com/rss.xml', tier: 'long_tail', weight: 0.5, poll: 720 },
  { id: 'rss-live-design', name: 'Live Design', url: 'https://www.livedesignonline.com/rss.xml', tier: 'long_tail', weight: 0.5, poll: 720 },
  { id: 'rss-plsn', name: 'PLSN', url: 'https://plsn.com/feed/', tier: 'long_tail', weight: 0.5, poll: 720 },
  { id: 'rss-indie-hackers', name: 'Indie Hackers', url: 'https://www.indiehackers.com/feed.xml', tier: 'long_tail', weight: 0.5, poll: 720 },
]

const RSS_MARKERS = ['<rss', '<feed', '<channel', '<entry>', '<item>']

async function verifyUrl(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GrimoireBot/1.0 (+https://hob.farm)' },
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!res.ok) {
      return { status: 'HTTP_ERROR', code: res.status }
    }

    const body = await res.text()
    const hasMarker = RSS_MARKERS.some(m => body.includes(m))

    if (!hasMarker) {
      return { status: 'INVALID_XML', snippet: body.slice(0, 200) }
    }

    return { status: 'OK', items: (body.match(/<item>/gi) || body.match(/<entry>/gi) || []).length }
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' }
    return { status: 'ERROR', message: e.message }
  } finally {
    clearTimeout(timeout)
  }
}

async function main() {
  const verified = []
  const dead = []

  console.log(`[verify] Checking ${CANDIDATES.length} candidate feeds...\n`)

  for (const candidate of CANDIDATES) {
    const urls = [candidate.url, ...(candidate.alts || [])]
    let result = null
    let workingUrl = null

    for (const url of urls) {
      process.stdout.write(`  ${candidate.name} (${url})... `)
      result = await verifyUrl(url)
      console.log(result.status + (result.code ? ` ${result.code}` : '') + (result.items ? ` (${result.items} items)` : ''))

      if (result.status === 'OK') {
        workingUrl = url
        break
      }

      // Brief pause before trying alt URL
      if (urls.indexOf(url) < urls.length - 1) {
        await sleep(500)
      }
    }

    if (workingUrl) {
      verified.push({ ...candidate, url: workingUrl, alts: undefined })
    } else {
      dead.push({ ...candidate, result })
    }

    await sleep(300) // Be polite
  }

  console.log(`\n[verify] Results:`)
  console.log(`  Verified: ${verified.length}`)
  console.log(`  Dead: ${dead.length}`)

  if (dead.length > 0) {
    console.log(`\n  Dead feeds:`)
    for (const d of dead) {
      console.log(`    ${d.name}: ${d.result.status}${d.result.code ? ' ' + d.result.code : ''}`)
    }
  }

  writeFileSync(VERIFIED_FILE, JSON.stringify(verified, null, 2))
  writeFileSync(DEAD_FILE, JSON.stringify(dead, null, 2))
  console.log(`\n[verify] Wrote ${VERIFIED_FILE}`)
  console.log(`[verify] Wrote ${DEAD_FILE}`)
}

main().catch(e => { console.error(`[fatal] ${e.message}`); process.exit(1) })
