// X API v2 client for posting tweets and fetching metrics.

import { buildOAuthHeader } from './auth'
import type {
  XApiCredentials,
  TweetResponse,
  TweetMetrics,
  MediaUploadInit,
  MediaUploadFinalize,
} from './types'

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function getCredentials(env: {
  X_CONSUMER_KEY: string
  X_CONSUMER_SECRET: string
  X_ACCESS_TOKEN: string
  X_ACCESS_SECRET: string
}): XApiCredentials {
  return {
    consumerKey: env.X_CONSUMER_KEY,
    consumerSecret: env.X_CONSUMER_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET,
  }
}

/**
 * Post a tweet. Text-only or with media_ids.
 */
export async function postTweet(
  env: {
    X_CONSUMER_KEY: string
    X_CONSUMER_SECRET: string
    X_ACCESS_TOKEN: string
    X_ACCESS_SECRET: string
  },
  text: string,
  mediaIds?: string[]
): Promise<TweetResponse> {
  const creds = getCredentials(env)
  const url = 'https://api.x.com/2/tweets'

  const body: Record<string, unknown> = { text }
  if (mediaIds?.length) {
    body.media = { media_ids: mediaIds }
  }

  const authHeader = await buildOAuthHeader('POST', url, creds)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`X API POST /tweets ${response.status}: ${errorText.slice(0, 500)}`)
  }

  return response.json() as Promise<TweetResponse>
}

/**
 * Fetch engagement metrics for a tweet.
 */
export async function getTweetMetrics(
  env: {
    X_CONSUMER_KEY: string
    X_CONSUMER_SECRET: string
    X_ACCESS_TOKEN: string
    X_ACCESS_SECRET: string
  },
  tweetId: string
): Promise<TweetMetrics> {
  const creds = getCredentials(env)
  const url = `https://api.x.com/2/tweets/${tweetId}?tweet.fields=public_metrics`

  const authHeader = await buildOAuthHeader('GET', url, creds)

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': authHeader },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`X API GET /tweets/${tweetId} ${response.status}: ${errorText.slice(0, 500)}`)
  }

  return response.json() as Promise<TweetMetrics>
}

/**
 * Upload media to X via v1.1 chunked upload.
 * INIT -> APPEND -> FINALIZE flow.
 */
export async function uploadMedia(
  env: {
    X_CONSUMER_KEY: string
    X_CONSUMER_SECRET: string
    X_ACCESS_TOKEN: string
    X_ACCESS_SECRET: string
  },
  imageData: ArrayBuffer,
  mimeType: string = 'image/png'
): Promise<string> {
  const creds = getCredentials(env)
  const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json'
  const totalBytes = imageData.byteLength

  // INIT
  const initParams: Record<string, string> = {
    command: 'INIT',
    total_bytes: totalBytes.toString(),
    media_type: mimeType,
  }

  const initAuth = await buildOAuthHeader('POST', uploadUrl, creds, initParams)
  const initBody = new URLSearchParams(initParams)

  const initRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': initAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: initBody.toString(),
  })

  if (!initRes.ok) {
    const errorText = await initRes.text()
    throw new Error(`X media INIT ${initRes.status}: ${errorText.slice(0, 500)}`)
  }

  const initData = (await initRes.json()) as MediaUploadInit
  const mediaId = initData.media_id_string

  // APPEND (single chunk for images under 5MB)
  const appendForm = new FormData()
  appendForm.append('command', 'APPEND')
  appendForm.append('media_id', mediaId)
  appendForm.append('segment_index', '0')
  appendForm.append('media_data', arrayBufferToBase64(imageData))

  // APPEND uses multipart, OAuth header signs only oauth params (not multipart body)
  const appendAuth = await buildOAuthHeader('POST', uploadUrl, creds)

  const appendRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Authorization': appendAuth },
    body: appendForm,
  })

  if (!appendRes.ok && appendRes.status !== 204) {
    const errorText = await appendRes.text()
    throw new Error(`X media APPEND ${appendRes.status}: ${errorText.slice(0, 500)}`)
  }

  // FINALIZE
  const finalParams: Record<string, string> = {
    command: 'FINALIZE',
    media_id: mediaId,
  }

  const finalAuth = await buildOAuthHeader('POST', uploadUrl, creds, finalParams)
  const finalBody = new URLSearchParams(finalParams)

  const finalRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': finalAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: finalBody.toString(),
  })

  if (!finalRes.ok) {
    const errorText = await finalRes.text()
    throw new Error(`X media FINALIZE ${finalRes.status}: ${errorText.slice(0, 500)}`)
  }

  const finalData = (await finalRes.json()) as MediaUploadFinalize

  // If processing is needed, wait for it
  if (finalData.processing_info) {
    await waitForProcessing(env, mediaId, finalData.processing_info.check_after_secs)
  }

  return mediaId
}

async function waitForProcessing(
  env: {
    X_CONSUMER_KEY: string
    X_CONSUMER_SECRET: string
    X_ACCESS_TOKEN: string
    X_ACCESS_SECRET: string
  },
  mediaId: string,
  initialWait: number
): Promise<void> {
  const creds = getCredentials(env)
  const maxAttempts = 10
  let waitSecs = initialWait

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, waitSecs * 1000))

    const statusUrl = `https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=${mediaId}`
    const auth = await buildOAuthHeader('GET', statusUrl, creds)

    const res = await fetch(statusUrl, {
      headers: { 'Authorization': auth },
    })

    if (!res.ok) break

    const data = (await res.json()) as {
      processing_info?: { state: string; check_after_secs?: number; error?: { message: string } }
    }

    if (!data.processing_info || data.processing_info.state === 'succeeded') return
    if (data.processing_info.state === 'failed') {
      throw new Error(`Media processing failed: ${data.processing_info.error?.message ?? 'unknown'}`)
    }

    waitSecs = data.processing_info.check_after_secs ?? 5
  }
}
