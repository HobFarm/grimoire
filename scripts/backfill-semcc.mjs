#!/usr/bin/env node
// Drives POST /admin/backfill-semcc until done:true.
// Usage: node scripts/backfill-semcc.mjs
//
// Reads HOBBOT_SERVICE_TOKEN from env.local or env.

import fs from 'node:fs'
import path from 'node:path'

const ENDPOINT = 'https://grimoire.damp-violet-bf89.workers.dev/admin/backfill-semcc'
const LIMIT = 5000

function loadToken() {
  if (process.env.HOBBOT_SERVICE_TOKEN) return process.env.HOBBOT_SERVICE_TOKEN
  const envPath = path.resolve(process.cwd(), 'env.local')
  if (!fs.existsSync(envPath)) throw new Error('env.local not found and HOBBOT_SERVICE_TOKEN not set')
  const content = fs.readFileSync(envPath, 'utf8')
  const match = content.match(/^\s*#?\s*HOBBOT_SERVICE_TOKEN=(\S+)/m)
  if (!match) throw new Error('HOBBOT_SERVICE_TOKEN not found in env.local')
  const raw = match[1]
  const colonIdx = raw.indexOf(':')
  return colonIdx >= 1 ? raw.slice(colonIdx + 1) : raw
}

const token = loadToken()
let cursor = ''
let totalUpdated = 0
let totalProcessed = 0
let call = 0
const start = Date.now()

while (true) {
  call++
  const callStart = Date.now()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cursor, limit: LIMIT }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  const data = await res.json()
  totalUpdated += data.updated
  totalProcessed += data.processed ?? 0
  const dt = Date.now() - callStart
  console.log(`[${call}] processed=${data.processed ?? 0} updated=${data.updated} next=${data.next_cursor ?? 'null'} (${dt}ms) | total=${totalProcessed}`)
  if (data.done) break
  cursor = data.next_cursor
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
console.log(`\nDone. ${call} calls, ${totalProcessed} atoms processed, ${totalUpdated} rows updated in ${elapsed}s.`)
