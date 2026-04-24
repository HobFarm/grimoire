/**
 * Gemini Flash extraction + JSON sanitization.
 * Patterns from batch-process.mjs:252-400 and backfill-contexts.mjs:62-120
 */

import { GEMINI_URL, getGeminiKey, sleep } from './env.mjs';

let _geminiKey = null;
function geminiKey() {
  if (!_geminiKey) _geminiKey = getGeminiKey();
  return _geminiKey;
}

// --- JSON Sanitization (from batch-process.mjs:252-315) ---

function sanitizeGeminiJson(raw) {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract JSON if wrapped in text explanation
  if (!cleaned.startsWith('[') && !cleaned.startsWith('{')) {
    const firstBracket = cleaned.indexOf('[');
    const firstBrace = cleaned.indexOf('{');
    const start = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)
      ? firstBracket : firstBrace;
    if (start >= 0) {
      const closer = cleaned[start] === '[' ? ']' : '}';
      const end = cleaned.lastIndexOf(closer);
      if (end > start) {
        cleaned = cleaned.slice(start, end + 1);
      }
    }
  }

  // Fix trailing commas
  cleaned = cleaned.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

  // Remove control characters inside string literals
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const code = cleaned.charCodeAt(i);

    if (escaped) { result += char; escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; result += char; continue; }
    if (char === '"') { inString = !inString; result += char; continue; }
    if (inString && code < 0x20) { result += ' '; continue; }
    result += char;
  }

  return result;
}

// Truncated array repair (from batch-process.mjs:321-350)
function repairTruncatedArray(sanitized) {
  const trimmed = sanitized.trimEnd();
  if (trimmed.endsWith(']')) return null;

  let lastCompleteObj = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 1 && ch === '}') lastCompleteObj = i;
    }
  }

  if (lastCompleteObj > 0) {
    console.log(`  [repair] Truncated array detected, salvaging up to position ${lastCompleteObj}`);
    return trimmed.slice(0, lastCompleteObj + 1) + ']';
  }
  return null;
}

function parseGeminiJson(raw) {
  const sanitized = sanitizeGeminiJson(raw);

  try {
    return JSON.parse(sanitized);
  } catch {
    // Try truncation repair
    const repaired = repairTruncatedArray(sanitized);
    if (repaired) {
      try { return JSON.parse(repaired); } catch { /* fall through */ }
    }
    throw new Error(`Failed to parse Gemini JSON: ${sanitized.slice(0, 200)}`);
  }
}

// --- Gemini API Call ---

async function fetchGemini(prompt, attempt = 1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(`${GEMINI_URL}?key=${geminiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          maxOutputTokens: 4096,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      }),
    });

    clearTimeout(timeoutId);

    if (res.status === 429 || res.status === 503 || res.status === 500) {
      if (attempt < 3) {
        const delay = attempt * 10_000;
        console.log(`  [gemini] ${res.status}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
        await sleep(delay);
        return fetchGemini(prompt, attempt + 1);
      }
      throw new Error(`Gemini ${res.status} after ${attempt} attempts`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`Gemini returned empty response: ${JSON.stringify(data).slice(0, 300)}`);
    }

    return text;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      if (attempt < 3) {
        console.log(`  [gemini] Timeout, retrying (attempt ${attempt + 1}/3)`);
        await sleep(5000);
        return fetchGemini(prompt, attempt + 1);
      }
      throw new Error('Gemini request timed out after 3 attempts');
    }
    throw err;
  }
}

/**
 * Call Gemini and parse JSON response.
 */
export async function callGemini(prompt) {
  const raw = await fetchGemini(prompt);
  return parseGeminiJson(raw);
}

/**
 * Call Gemini and return raw text (for non-JSON responses like context generation).
 */
export async function callGeminiText(prompt) {
  // Override to use text mode, not JSON
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  const res = await fetch(`${GEMINI_URL}?key=${geminiKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });

  clearTimeout(timeoutId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// --- Noise Filter ---

// Terms that pass length/word validation but are not visual vocabulary
const NOISE_PATTERNS = [
  // Languages, ethnic groups, political entities
  /\blanguage[s]?\b/, /\bdialect\b/, /\bempire\b/, /\bkingdom\b/, /\bdynasty\b/,
  /\balliance\b/, /\bconfederacy\b/, /\bcivilization\b/, /\bcivilisation\b/,
  // Geographic/political
  /\bcentral\s+(america|mexico)\b/, /\bnorth\s+america\b/, /\bsouth\s+america\b/,
  /\bwest\s+africa\b/, /\beast\s+africa\b/,
  // Academic/abstract
  /\blinguistic\b/, /\bethnic\b/, /\bsovereign\b/, /\bgovernance\b/,
  /\bscholar\b/, /\bacademic\b/, /\bresearch\b/, /\bhistorian\b/,
  /\barchaeolog/i, /\bethnograph/i,
  // Generic filler
  /^(the|a|an)\s/i, /\bstyles?\s*$/i, /^(modern|ancient|traditional|classic|typical)\s/i,
  /\baccomplishment/, /\bachievement/, /\binfluence\b/,
];

function isNonVisualTerm(text) {
  return NOISE_PATTERNS.some(p => p.test(text));
}

// --- Extraction ---

const EXTRACTION_PROMPT = (domainLabel, collections) => `Extract visual vocabulary from this text about ${domainLabel} for an AI image generation system.

WHAT TO EXTRACT:
- Specific artifacts, objects, tools (obsidian mirror, jade mosaic, ball court marker)
- Materials, textures, surfaces (stucco relief, beaten gold, indigo dye)
- Architectural elements, structures (stepped pyramid, corbel arch, granary)
- Garments, wearable items (huipil, feathered headdress, beaded collar)
- Patterns, motifs, decorative elements (serpent motif, geometric frieze, scroll pattern)
- Art/craft techniques (lost-wax casting, slip painting, copperplate etching)
- Color terms tied to materials (cinnabar red, turquoise blue, ochre)
- Body decoration (scarification, face paint, tattooed markings)

WHAT TO SKIP:
- Place names, city names, country names, empire names, geographic regions
- Language names, ethnic group names, dynasty names, era names
- Scholar names, author names, dates, page numbers, ISBNs
- Abstract concepts (sovereignty, alliance, tradition, culture, governance)
- Generic words (art, people, society, system, style, form, type)
- Military/political terms unless they describe something visual
- Anything you cannot draw, photograph, or render in an image

Each term: 1-6 words, 3-80 characters. Lowercase.
Assign each term a collection_slug from: ${collections.join(', ')}

COLLECTION RULES:
- environment-props: objects, furniture, architectural elements, tools, vessels
- styles: named aesthetic styles, art movements, architectural styles only
- style-medium: art techniques, rendering methods, craft processes
- nature: natural materials, plants, animals, minerals, pigments
- clothing: garments worn on body
- clothing-accessories: jewelry, ornaments, headpieces
- colors: color terms
- features-body: body markings, modifications, decorations
- environment: specific place types (temple, marketplace, courtyard)
- lighting: light sources and qualities
- composition: spatial arrangements, layout principles

Return JSON array: [{"t":"term","c":"collection_slug"},...]
No markdown. No explanation. Just the array.`;

/**
 * Extract visual terms from a text chunk using Gemini.
 * @param {string} text - Text chunk to extract from
 * @param {string} domainLabel - Human-readable domain name for prompt
 * @param {string[]} collections - Valid collection slugs for this domain
 * @returns {Array<{text: string, collection_slug: string}>}
 */
export async function extractTerms(text, domainLabel, collections) {
  const prompt = EXTRACTION_PROMPT(domainLabel, collections) + '\n\nTEXT:\n' + text;

  const results = await callGemini(prompt);
  if (!Array.isArray(results)) {
    console.error('  [extract] Non-array response, skipping chunk');
    return [];
  }

  const terms = [];
  for (const item of results) {
    const t = (item.t || item.text || '').trim();
    const c = item.c || item.collection_slug || item.col || 'uncategorized';

    // Client-side validation matching isValidAtom()
    if (t.length < 3 || t.length > 80) continue;
    if (t.split(/\s+/).length > 6) continue;
    if (t.includes('\n')) continue;
    if (/^[\d\W]+$/.test(t)) continue;

    // Post-extraction noise filter: skip non-visual garbage
    const lower = t.toLowerCase();
    if (isNonVisualTerm(lower)) continue;

    terms.push({ text: t, collection_slug: c });
  }

  return terms;
}
