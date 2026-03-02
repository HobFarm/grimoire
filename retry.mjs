// retry.mjs
// Drop-in retry wrapper for Gemini API calls in ingest.mjs
// Handles 503 (overloaded) and 429 (rate limit) with exponential backoff.

/**
 * Wrap a Gemini fetch call with exponential backoff retry.
 * @param {Function} fn - Async function that makes the Gemini API call. Should throw on non-2xx.
 * @param {Object} options
 * @param {number} options.maxRetries - Max retry attempts (default 3)
 * @param {number} options.baseDelay - Initial delay in ms (default 2000)
 * @param {number} options.maxDelay - Max delay cap in ms (default 15000)
 * @returns {Promise<any>} Result of fn()
 */
export async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 2000;
  const maxDelay = options.maxDelay ?? 15000;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err?.message || String(err);

      // Bail immediately on explicitly non-retryable errors (e.g. JSON parse failures)
      if (err.retryable === false || attempt === maxRetries) {
        throw err;
      }

      // Only retry on transient errors
      const isRetryable = msg.includes('503') ||
                          msg.includes('429') ||
                          msg.includes('overloaded') ||
                          msg.includes('RESOURCE_EXHAUSTED') ||
                          msg.includes('AbortError') ||
                          msg.includes('fetch failed');

      if (!isRetryable) {
        throw err;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = Math.random() * 500; // add 0-500ms jitter
      console.log(`  Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay + jitter)}ms (${msg.slice(0, 80)})`);
      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Usage in ingest.mjs:
//
// import { withRetry } from './retry.mjs';
//
// // Wrap your Gemini classification call:
// const result = await withRetry(
//   () => classifyBatch(atoms, apiKey),
//   { maxRetries: 3, baseDelay: 2000 }
// );
