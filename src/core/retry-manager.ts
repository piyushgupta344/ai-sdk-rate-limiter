import type { BackoffStrategy } from '../types.js'
import { RetryExhaustedError } from '../errors.js'

export interface ResolvedRetryConfig {
  maxAttempts: number
  backoff: BackoffStrategy
  baseDelay: number
  maxDelay: number
  jitter: boolean
  parseRetryAfter: boolean
  retryOn: number[]
}

export const DEFAULT_RETRY_CONFIG: ResolvedRetryConfig = {
  maxAttempts: 4,
  backoff: 'exponential',
  baseDelay: 1_000,
  maxDelay: 60_000,
  jitter: true,
  parseRetryAfter: true,
  retryOn: [429, 500, 502, 503, 504],
}

// ---------------------------------------------------------------------------
// Error introspection helpers
// ---------------------------------------------------------------------------

/** Extract HTTP status from various error shapes */
export function extractStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const e = error as Record<string, unknown>

  // Standard fetch Response-like
  if (typeof e['status'] === 'number') return e['status']

  // OpenAI SDK error: { status: number }
  // Anthropic SDK error: { status: number }
  // Vercel AI SDK: wraps as { statusCode: number } or { cause: { status } }
  if (typeof e['statusCode'] === 'number') return e['statusCode']

  // Nested cause
  if (e['cause']) return extractStatus(e['cause'])

  return null
}

/**
 * Extract the Retry-After delay in milliseconds from a 429 response.
 *
 * Handles two formats:
 *   - Integer seconds:  "Retry-After: 5"
 *   - HTTP date:        "Retry-After: Wed, 21 Oct 2015 07:28:00 GMT"
 */
export function extractRetryAfterMs(error: unknown): number | null {
  const headers = extractHeaders(error)
  if (!headers) return null

  const value =
    headers['retry-after'] ??
    headers['Retry-After'] ??
    headers['x-ratelimit-reset-requests'] // OpenAI uses this too (duration string)

  if (!value) return null

  // OpenAI duration format first: "6m0s", "30s", "1ms", "500ms"
  // Must check before parseInt to avoid "6m30s" being parsed as 6
  const durationMs = parseDurationString(value)
  if (durationMs !== null) return durationMs

  // Pure integer seconds (only when no letters present)
  if (/^\d+$/.test(value.trim())) {
    const seconds = parseInt(value, 10)
    if (!isNaN(seconds) && seconds > 0) return seconds * 1_000
  }

  // HTTP date
  const date = new Date(value)
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now()
    return Math.max(0, ms)
  }

  return null
}

/** Extracts rate-limit headers from API response errors */
export function extractHeaders(error: unknown): Record<string, string> | null {
  if (!error || typeof error !== 'object') return null
  const e = error as Record<string, unknown>

  if (e['headers'] && typeof e['headers'] === 'object') {
    return e['headers'] as Record<string, string>
  }

  if (e['response'] && typeof e['response'] === 'object') {
    const response = e['response'] as Record<string, unknown>
    if (response['headers'] && typeof response['headers'] === 'object') {
      return response['headers'] as Record<string, string>
    }
  }

  if (e['cause']) return extractHeaders(e['cause'])

  return null
}

/**
 * Parse OpenAI-style duration strings like "6m30s", "500ms", "1m", "30s"
 * Returns milliseconds or null.
 */
/**
 * Parse duration strings like "6m30s", "500ms", "30s", "1m".
 * Handles milliseconds first to avoid "500ms" matching seconds regex.
 */
function parseDurationString(value: string): number | null {
  // Quick exit: no unit letters means this isn't a duration string
  if (!/[a-z]/i.test(value)) return null

  let total = 0
  let matched = false

  // Milliseconds first — "500ms" must not also count as "500" seconds
  const msMatch = /(\d+)ms/.exec(value)
  if (msMatch?.[1]) {
    total += parseInt(msMatch[1], 10)
    matched = true
  }

  // Minutes: "6m" — negative lookahead excludes the "m" in "ms"
  const minuteMatch = /(\d+)m(?!s)/.exec(value)
  if (minuteMatch?.[1]) {
    total += parseInt(minuteMatch[1], 10) * 60_000
    matched = true
  }

  // Seconds: strip the ms portion first so "500ms" doesn't match as "500m...s"
  const withoutMs = value.replace(/\d+ms/g, '')
  const secondMatch = /(\d+(?:\.\d+)?)s/.exec(withoutMs)
  if (secondMatch?.[1]) {
    total += parseFloat(secondMatch[1]) * 1_000
    matched = true
  }

  return matched ? total : null
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

export function calculateBackoffMs(
  attempt: number, // 1-indexed (1 = first retry, after first failure)
  config: ResolvedRetryConfig,
): number {
  let delay: number

  switch (config.backoff) {
    case 'exponential':
      // Attempt 1: baseDelay * 2^0 = baseDelay
      // Attempt 2: baseDelay * 2^1
      // Attempt 3: baseDelay * 2^2
      delay = config.baseDelay * Math.pow(2, attempt - 1)
      break
    case 'linear':
      delay = config.baseDelay * attempt
      break
    case 'fixed':
      delay = config.baseDelay
      break
  }

  // Jitter: add ±30% randomness to prevent thundering herd
  if (config.jitter) {
    const jitterRange = delay * 0.3
    delay += (Math.random() * 2 - 1) * jitterRange
  }

  return Math.min(Math.max(0, delay), config.maxDelay)
}

// ---------------------------------------------------------------------------
// Main retry wrapper
// ---------------------------------------------------------------------------

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: ResolvedRetryConfig,
  hooks?: {
    onRetry?: (opts: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void
    /** Called when a 429 is received — useful to trigger a global backoff */
    onRateLimited?: (retryAfterMs: number) => void
    modelId?: string
  },
): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Non-retryable: re-throw immediately
      const status = extractStatus(error)
      if (status !== null && !config.retryOn.includes(status)) throw error

      // Last attempt: fall through to throw RetryExhaustedError
      if (attempt === config.maxAttempts) break

      // Determine wait duration
      let delayMs: number
      const retryAfterMs = config.parseRetryAfter ? extractRetryAfterMs(error) : null

      if (retryAfterMs !== null) {
        // Honor exactly what the API tells us — this is the key insight that
        // most libraries miss. Their backoff may be much longer than needed.
        delayMs = retryAfterMs
        hooks?.onRateLimited?.(retryAfterMs)
      } else {
        delayMs = calculateBackoffMs(attempt, config)
      }

      hooks?.onRetry?.({
        attempt,
        maxAttempts: config.maxAttempts,
        delayMs,
        error,
      })

      await sleep(delayMs)
    }
  }

  throw new RetryExhaustedError(hooks?.modelId ?? 'unknown', config.maxAttempts, lastError)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
