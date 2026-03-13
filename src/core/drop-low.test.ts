import { describe, it, expect } from 'vitest'
import { RateLimitEngine } from './rate-limit-engine.js'
import { QueueFullError } from '../errors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const limits = {
  rpm: 1,
  inputPricePerMillion: 0,
  outputPricePerMillion: 0,
}

const KEY = 'openai:gpt-4o'

/**
 * Fill the rpm window so subsequent acquire() calls get rate-limited and queue.
 * We do this by calling acquire() once (rpm=1 → window is now full).
 */
async function fillWindow(engine: RateLimitEngine) {
  await engine.acquire(KEY, {
    limits,
    estimatedInputTokens: 0,
    priority: 'normal',
    timeoutMs: 30_000,
  })
}

/** Flush the microtask queue enough for an async acquire() to reach the queue */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queue onFull: 'drop-low'", () => {
  it('evicts a low-priority waiter when a high-priority request arrives and queue is full', async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 1 })
    await fillWindow(engine)

    // Queue a low-priority waiter — becomes the sole queued item (queue at max)
    const lowPromise = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'low', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks() // let it reach the waiters array

    // High-priority request arrives — queue full, drop-low evicts the low waiter
    const _highPromise = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'high', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks() // let eviction propagate

    await expect(lowPromise).rejects.toBeInstanceOf(QueueFullError)

    engine.shutdown() // clean up pending waiters
    await _highPromise.catch(() => {})
  })

  it('drops the incoming low-priority request when there are no low waiters to evict', async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 1 })
    await fillWindow(engine)

    // Fill queue with a high-priority waiter
    const _highQueued = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'high', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks()

    // Incoming low-priority — no low waiter to evict → thrown immediately
    await expect(
      engine.acquire(KEY, {
        limits, estimatedInputTokens: 0, priority: 'low', timeoutMs: 30_000, onFull: 'drop-low',
      }),
    ).rejects.toBeInstanceOf(QueueFullError)

    engine.shutdown()
    await _highQueued.catch(() => {})
  })

  it('normal-priority can also evict a low-priority waiter', async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 1 })
    await fillWindow(engine)

    const lowPromise = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'low', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks()

    const _normalPromise = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'normal', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks()

    await expect(lowPromise).rejects.toBeInstanceOf(QueueFullError)

    engine.shutdown()
    await _normalPromise.catch(() => {})
  })

  it("throws for the incoming request when onFull is 'throw', even with mixed priorities", async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 1 })
    await fillWindow(engine)

    // Fill queue with a low-priority waiter
    const _lowQueued = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'low', timeoutMs: 30_000,
    })
    await flushMicrotasks()

    // High-priority incoming — but onFull='throw', so it throws immediately
    await expect(
      engine.acquire(KEY, {
        limits, estimatedInputTokens: 0, priority: 'high', timeoutMs: 30_000, onFull: 'throw',
      }),
    ).rejects.toBeInstanceOf(QueueFullError)

    engine.shutdown()
    await _lowQueued.catch(() => {})
  })

  it('default behavior (no onFull) throws for any incoming request when queue is full', async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 1 })
    await fillWindow(engine)

    const _lowQueued = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'low', timeoutMs: 30_000,
    })
    await flushMicrotasks()

    // High-priority incoming — no onFull specified, defaults to throw
    await expect(
      engine.acquire(KEY, {
        limits, estimatedInputTokens: 0, priority: 'high', timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(QueueFullError)

    engine.shutdown()
    await _lowQueued.catch(() => {})
  })

  it('evicts only the tail low-priority waiter, leaving higher-priority waiters intact', async () => {
    const engine = new RateLimitEngine({ maxQueueSize: 2 })
    await fillWindow(engine)

    // Fill queue: one normal + one low (sorted order: normal at [0], low at [1])
    const normalQueued = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'normal', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks()
    const lowQueued = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'low', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks()

    // High-priority arrives — evicts the tail low waiter, not the normal one
    const _highPromise = engine.acquire(KEY, {
      limits, estimatedInputTokens: 0, priority: 'high', timeoutMs: 30_000, onFull: 'drop-low',
    })
    await flushMicrotasks()

    await expect(lowQueued).rejects.toBeInstanceOf(QueueFullError)
    // normalQueued is still in the queue (not evicted)
    expect(engine.queueDepth(KEY)).toBe(2) // normal + high

    engine.shutdown()
    await normalQueued.catch(() => {})
    await _highPromise.catch(() => {})
  })
})
