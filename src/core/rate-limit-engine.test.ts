import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RateLimitEngine } from './rate-limit-engine.js'
import { QueueTimeoutError, QueueFullError } from '../errors.js'
import type { ModelLimits } from '../types.js'

const LIMITS: ModelLimits = {
  rpm: 3,
  itpm: 1_000,
  otpm: 1_000,
  inputPricePerMillion: 1,
  outputPricePerMillion: 4,
}

describe('RateLimitEngine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // -------------------------------------------------------------------------
  it('allows requests up to the rpm limit', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'

    // First three should pass immediately
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 1_000 })
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 1_000 })
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 1_000 })

    expect(engine.windowSnapshot(key).requests).toBe(3)
  })

  // -------------------------------------------------------------------------
  it('queues requests beyond the rpm limit and resolves when window expires', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'

    // Fill the window
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 5_000 })
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 5_000 })
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 5_000 })

    // 4th request should queue
    let resolved = false
    const p = engine.acquire(key, {
      limits: LIMITS,
      estimatedInputTokens: 10,
      priority: 'normal',
      timeoutMs: 65_000,
    }).then(() => { resolved = true })

    expect(resolved).toBe(false)

    // Advance time past the window
    await vi.advanceTimersByTimeAsync(61_000)
    await p

    expect(resolved).toBe(true)
  })

  // -------------------------------------------------------------------------
  it('drains queue in priority order (high before normal before low)', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'
    const TIGHT: ModelLimits = { ...LIMITS, rpm: 1 }

    // Consume the single slot
    await engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 300_000 })

    const resolved: string[] = []

    // Queue: low first, then normal, then high
    // Despite insertion order, high should resolve first, then normal, then low
    // Timeouts must exceed the total wait: 3 × 61s = 183s → use 300s
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'low', timeoutMs: 300_000 })
      .then(() => resolved.push('low'))
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 300_000 })
      .then(() => resolved.push('normal'))
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'high', timeoutMs: 300_000 })
      .then(() => resolved.push('high'))

    // Advance one window per slot: each slot takes ~61s to open
    await vi.advanceTimersByTimeAsync(62_000)
    await vi.advanceTimersByTimeAsync(62_000)
    await vi.advanceTimersByTimeAsync(62_000)

    expect(resolved).toEqual(['high', 'normal', 'low'])
  })

  // -------------------------------------------------------------------------
  it('rejects with QueueTimeoutError when timeout expires', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'

    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 1_000 })
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 1_000 })
    await engine.acquire(key, { limits: LIMITS, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 1_000 })

    const p = engine.acquire(key, {
      limits: LIMITS,
      estimatedInputTokens: 10,
      priority: 'normal',
      timeoutMs: 5_000, // 5s timeout, window is 60s → will expire
    })

    // Attach handler BEFORE advancing timers to avoid unhandled-rejection warning
    const assertion = expect(p).rejects.toBeInstanceOf(QueueTimeoutError)
    await vi.advanceTimersByTimeAsync(5_001)
    await assertion
  })

  // -------------------------------------------------------------------------
  it('rejects with QueueFullError when queue is at capacity', async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 2 })
    const key = 'openai:gpt-4o'
    const TIGHT: ModelLimits = { ...LIMITS, rpm: 1 }

    await engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 65_000 })

    // Fill the queue
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 65_000 })
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 65_000 })

    // This one should throw immediately (queue is full)
    await expect(
      engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 65_000 })
    ).rejects.toBeInstanceOf(QueueFullError)
  })

  // -------------------------------------------------------------------------
  it('applies backoff and delays queued requests', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'
    const TIGHT: ModelLimits = { ...LIMITS, rpm: 1 }

    await engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 65_000 })

    let resolved = false
    const p = engine.acquire(key, {
      limits: TIGHT,
      estimatedInputTokens: 10,
      priority: 'normal',
      timeoutMs: 120_000,
    }).then(() => { resolved = true })

    // Window expires after 61s, but we apply a 90s backoff
    engine.applyBackoff(key, 90_000)

    await vi.advanceTimersByTimeAsync(61_000)
    expect(resolved).toBe(false) // window cleared but backoff still active

    await vi.advanceTimersByTimeAsync(30_000) // now > 90s backoff
    await p

    expect(resolved).toBe(true)
  })

  // -------------------------------------------------------------------------
  it('blocks on ITPM limit even when RPM has headroom', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'
    const TOKEN_TIGHT: ModelLimits = { ...LIMITS, rpm: 100, itpm: 50 }

    // Single request that uses 40 tokens — fits in 50 ITPM
    await engine.acquire(key, {
      limits: TOKEN_TIGHT,
      estimatedInputTokens: 40,
      priority: 'normal',
      timeoutMs: 1_000,
    })

    // Second request for 20 tokens — would push to 60, over the 50 ITPM limit
    let blocked = true
    const p = engine.acquire(key, {
      limits: TOKEN_TIGHT,
      estimatedInputTokens: 20,
      priority: 'normal',
      timeoutMs: 65_000,
    }).then(() => { blocked = false })

    // Should still be blocked after 1ms (hasn't cleared)
    await vi.advanceTimersByTimeAsync(1)
    expect(blocked).toBe(true)

    // Advance past the window
    await vi.advanceTimersByTimeAsync(61_000)
    await p
    expect(blocked).toBe(false)
  })

  // -------------------------------------------------------------------------
  it('returns estimatedWaitMs of 0 when capacity is available', () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'
    expect(engine.estimatedWaitMs(key, LIMITS, 10)).toBe(0)
  })

  // -------------------------------------------------------------------------
  it('FIFO within the same priority level', async () => {
    const engine = new RateLimitEngine()
    const key = 'openai:gpt-4o'
    const TIGHT: ModelLimits = { ...LIMITS, rpm: 1 }

    await engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 300_000 })

    const order: number[] = []

    // Enqueue at distinct fake-timer timestamps (1ms apart) so FIFO ordering
    // is deterministic — cannot use setTimeout(r,0) with fake timers as it
    // won't resolve until we advance the clock.
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 300_000 }).then(() => order.push(1))
    await vi.advanceTimersByTimeAsync(1) // t=1: gives waiter #1 an earlier enqueued timestamp
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 300_000 }).then(() => order.push(2))
    await vi.advanceTimersByTimeAsync(1) // t=2
    engine.acquire(key, { limits: TIGHT, estimatedInputTokens: 10, priority: 'normal', timeoutMs: 300_000 }).then(() => order.push(3))

    // Each slot opens after ~60s. Advance 3 × 62s to drain all three.
    await vi.advanceTimersByTimeAsync(62_000)
    await vi.advanceTimersByTimeAsync(62_000)
    await vi.advanceTimersByTimeAsync(62_000)

    expect(order).toEqual([1, 2, 3])
  }, 30_000)
})
