// OAuth 1.0a HMAC-SHA1 signing for X API.
// Uses Web Crypto API (crypto.subtle) for Workers runtime compatibility.

import type { XApiCredentials } from './types'

/** RFC 3986 percent-encode (stricter than encodeURIComponent). */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
}

/** Generate a random 32-char hex nonce. */
function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA1 sign using Web Crypto API. */
async function hmacSha1(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

/**
 * Build the OAuth 1.0a Authorization header for an X API request.
 */
export async function buildOAuthHeader(
  method: string,
  url: string,
  creds: XApiCredentials,
  bodyParams?: Record<string, string>
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = generateNonce()

  // OAuth params (sorted alphabetically in the signature base string)
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  }

  // Collect all params for signature: oauth + URL query + body (form-encoded)
  const allParams: Record<string, string> = { ...oauthParams }

  // Parse URL query params
  const urlObj = new URL(url)
  urlObj.searchParams.forEach((value, key) => {
    allParams[key] = value
  })

  // Add body params if present (only for application/x-www-form-urlencoded)
  if (bodyParams) {
    Object.assign(allParams, bodyParams)
  }

  // Sort and encode params
  const paramString = Object.keys(allParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&')

  // Build base URL (without query params)
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`

  // Signature base string: METHOD&encoded_url&encoded_params
  const baseString = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`

  // Signing key: consumer_secret&token_secret
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessSecret)}`

  const signature = await hmacSha1(signingKey, baseString)
  oauthParams['oauth_signature'] = signature

  // Build Authorization header
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(', ')

  return `OAuth ${headerParts}`
}
