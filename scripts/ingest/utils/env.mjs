#!/usr/bin/env node
/**
 * Environment loader + constants for ingestion scripts.
 * Reads from ../../.env (project root) or process.env.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

// Load .env from project root
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

export const ACCOUNT_ID = 'e343cbfa70c5166f00d871e513ae352a';
export const DATABASE_ID = '3cb1cdee-17af-477c-ab0a-5a18447948ef';
export const D1_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';
export const WORKER_URL = 'https://grimoire.damp-violet-bf89.workers.dev';

export function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env or environment');
  return key;
}

export function getCfToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;

  // Fall back to wrangler OAuth token
  const configPath = join(homedir(), '.wrangler', 'config', 'default.toml');
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) {
      console.log('[auth] Using wrangler OAuth token');
      return match[1];
    }
  }

  throw new Error('CF_API_TOKEN not set and no wrangler OAuth token found');
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
