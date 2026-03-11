import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withRetry,
  extractRetryAfterMs,
  extractStatus,
  calculateBackoffMs,
  DEFAULT_RETRY_CONFIG,
} from './retry-manager.js'
import { RetryExhaustedError } from '../errors.js'

// ---------------------------------------------------------------------------
// extractStatus
// ---------------------------------------------------------------------------
describe('extractStatus', () => {
  it('extracts status from flat error', () => {
    expect(extractStatus({ status: 429 })).toBe(429)
  })

  it('extracts statusCode from OpenAI-style errors', () => {
    expect(extractStatus({ statusCode: 503 })).toBe(503)
  })

  it('extracts status from nested cause', () => {
    expect(extractStatus({ cause: { status: 500 } })).toBe(500)
  })

  it('returns null for non-HTTP errors', () => {
    expect(extractStatus(new Error('Network error'))).toBeNull()
    expect(extractStatus(null)).toBeNull()
    expect(extractStatus('string error')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractRetryAfterMs
// ---------------------------------------------------------------------------
describe('extractRetryAfterMs', () => {
  it('parses integer seconds from Retry-After header', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': '5' } })).toBe(5_000)
  })

  it('parses OpenAI duration format "6m30s"', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': '6m30s' } })).toBe(390_000)
  })

  it('parses "30s" format', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': '30s' } })).toBe(30_000)
  })

  it('parses "500ms" format', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': '500ms' } })).toBe(500)
  })

  it('returns null when no header present', () => {
    expect(extractRetryAfterMs({ headers: {} })).toBeNull()
    expect(extractRetryAfterMs({ status: 429 })).toBeNull()
  })

  it('parses from nested response.headers', () => {
    expect(
      extractRetryAfterMs({ response: { headers: { 'retry-after': '10' } } })
    ).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// calculateBackoffMs
// ---------------------------------------------------------------------------
describe('calculateBackoffMs', () => {
  it('doubles on each exponential attempt', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: false }
    expect(calculateBackoffMs(1, config)).toBe(1_000)
    expect(calculateBackoffMs(2, config)).toBe(2_000)
    expect(calculateBackoffMs(3, config)).toBe(4_000)
    expect(calculateBackoffMs(4, config)).toBe(8_000)
  })

  it('caps at maxDelay', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, jitter: false, maxDelay: 3_000 }
    expect(calculateBackoffMs(10, config)).toBe(3_000)
  })

  it('linear backoff increments by baseDelay per attempt', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, backoff: 'linear' as const, jitter: false }
    expect(calculateBackoffMs(1, config)).toBe(1_000)
    expect(calculateBackoffMs(2, config)).toBe(2_000)
    expect(calculateBackoffMs(3, config)).toBe(3_000)
  })

  it('fixed backoff always returns baseDelay', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, backoff: 'fixed' as const, jitter: false }
    expect(calculateBackoffMs(1, config)).toBe(1_000)
    expect(calculateBackoffMs(5, config)).toBe(1_000)
  })
})

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------
describe('withRetry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, DEFAULT_RETRY_CONFIG)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 and succeeds on second attempt', async () => {
    const error429 = { status: 429, headers: {} }
    const fn = vi.fn()
      .mockRejectedValueOnce(error429)
      .mockResolvedValue('ok')

    const onRetry = vi.fn()
    const promise = withRetry(fn, { ...DEFAULT_RETRY_CONFIG, jitter: false }, { onRetry })

    // First call fails → backoff → second call succeeds
    await vi.runAllTimersAsync()

    const result = await promise
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('honors Retry-After header instead of computing backoff', async () => {
    const error = { status: 429, headers: { 'retry-after': '7' } }
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('done')

    const onRetry = vi.fn()
    const promise = withRetry(fn, { ...DEFAULT_RETRY_CONFIG, jitter: false }, { onRetry })

    await vi.runAllTimersAsync()
    await promise

    // The delay passed to onRetry should be exactly 7000ms (from the header)
    expect(onRetry.mock.calls[0]?.[0].delayMs).toBe(7_000)
  })

  it('throws RetryExhaustedError after maxAttempts', async () => {
    const error = { status: 429, headers: {} }
    const fn = vi.fn().mockRejectedValue(error)

    const promise = withRetry(fn, { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3, jitter: false })
    // Attach handler before advancing timers to avoid unhandled-rejection warning
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryExhaustedError)
    await vi.runAllTimersAsync()
    await assertion
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry non-retryable status codes', async () => {
    const error = { status: 400 } // Bad Request — not in retryOn list
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withRetry(fn, DEFAULT_RETRY_CONFIG)).rejects.toEqual(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('calls onRateLimited when 429 has Retry-After', async () => {
    const error = { status: 429, headers: { 'retry-after': '5' } }
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok')

    const onRateLimited = vi.fn()
    const promise = withRetry(
      fn,
      { ...DEFAULT_RETRY_CONFIG, jitter: false },
      { onRateLimited },
    )

    await vi.runAllTimersAsync()
    await promise

    expect(onRateLimited).toHaveBeenCalledWith(5_000)
  })

  it('retries 500, 502, 503, 504 errors', async () => {
    for (const status of [500, 502, 503, 504]) {
      const fn = vi.fn()
        .mockRejectedValueOnce({ status })
        .mockResolvedValue('ok')

      const promise = withRetry(fn, { ...DEFAULT_RETRY_CONFIG, jitter: false })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
      vi.clearAllMocks()
    }
  })
})
