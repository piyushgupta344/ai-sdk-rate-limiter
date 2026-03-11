import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from './in-memory-store.js'

const LIMITS = {
  rpm: 5,
  itpm: 1_000,
  inputPricePerMillion: 2.5,
  outputPricePerMillion: 10.0,
}

describe('InMemoryStore — checkAndRecord', () => {
  it('allows request when under RPM limit', async () => {
    const store = new InMemoryStore()
    const result = await store.checkAndRecord('openai:gpt-4o', 100, LIMITS)
    expect(result).toBeLessThanOrEqual(Date.now())
  })

  it('blocks when RPM limit is reached', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    for (let i = 0; i < 5; i++) {
      const r = await store.checkAndRecord(key, 10, LIMITS)
      expect(r).toBeLessThanOrEqual(Date.now())
    }

    // 6th request should be blocked
    const blocked = await store.checkAndRecord(key, 10, LIMITS)
    expect(blocked).toBeGreaterThan(Date.now())
  })

  it('blocks when ITPM limit is reached', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    // 900 tokens — still under 1000 ITPM limit
    await store.checkAndRecord(key, 900, LIMITS)

    // 200 more would push to 1100, exceeding 1000 ITPM
    const blocked = await store.checkAndRecord(key, 200, LIMITS)
    expect(blocked).toBeGreaterThan(Date.now())
  })

  it('allows request again after window expires', async () => {
    vi.useFakeTimers()
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    // Fill up RPM
    for (let i = 0; i < 5; i++) {
      await store.checkAndRecord(key, 10, LIMITS)
    }

    // Advance time past the 60s window
    vi.advanceTimersByTime(61_000)

    const result = await store.checkAndRecord(key, 10, LIMITS)
    expect(result).toBeLessThanOrEqual(Date.now())

    vi.useRealTimers()
  })

  it('returns a future timestamp when rate limited', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    for (let i = 0; i < 5; i++) {
      await store.checkAndRecord(key, 10, LIMITS)
    }

    const blocked = await store.checkAndRecord(key, 10, LIMITS)
    const nowApprox = Date.now()
    // nextSlotAt should be ~60s from when the first request was recorded
    expect(blocked).toBeGreaterThan(nowApprox)
    expect(blocked).toBeLessThan(nowApprox + 65_000)
  })
})

describe('InMemoryStore — reconcile', () => {
  it('updates the most recent placeholder entry with actual values', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    // Record an estimate of 100 input tokens
    await store.checkAndRecord(key, 100, LIMITS)

    // Reconcile with actuals
    await store.reconcile(key, 75, 30)

    // The snapshot should now reflect 75 input tokens (not 100)
    const snap = store.snapshot(key)
    expect(snap.inputTokens).toBe(75)
    expect(snap.outputTokens).toBe(30)
  })

  it('does nothing when there are no window entries', async () => {
    const store = new InMemoryStore()
    // Should not throw
    await expect(store.reconcile('openai:gpt-4o', 10, 5)).resolves.toBeUndefined()
  })
})

describe('InMemoryStore — backoff', () => {
  it('blocks all requests while backoff is active', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'
    const untilMs = Date.now() + 5_000

    await store.setBackoff(key, untilMs)

    const blocked = await store.checkAndRecord(key, 10, LIMITS)
    expect(blocked).toBeGreaterThanOrEqual(untilMs)
  })

  it('does not downgrade an existing longer backoff', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'
    const longBackoff = Date.now() + 30_000

    await store.setBackoff(key, longBackoff)
    await store.setBackoff(key, Date.now() + 1_000) // shorter — should be ignored

    const result = await store.getBackoff(key)
    expect(result).toBeCloseTo(longBackoff, -2)
  })

  it('allows requests after backoff expires', async () => {
    vi.useFakeTimers()
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    await store.setBackoff(key, Date.now() + 2_000)

    vi.advanceTimersByTime(3_000)

    const result = await store.checkAndRecord(key, 10, LIMITS)
    expect(result).toBeLessThanOrEqual(Date.now())

    vi.useRealTimers()
  })

  it('getBackoff returns 0 when no backoff is set', async () => {
    const store = new InMemoryStore()
    const result = await store.getBackoff('openai:gpt-4o')
    expect(result).toBe(0)
  })
})

describe('InMemoryStore — nextSlotMs', () => {
  it('returns 0 when a slot is available', async () => {
    const store = new InMemoryStore()
    const result = await store.nextSlotMs('openai:gpt-4o', LIMITS, 10)
    expect(result).toBe(0)
  })

  it('returns future ms when RPM is maxed', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    for (let i = 0; i < 5; i++) {
      await store.checkAndRecord(key, 10, LIMITS)
    }

    const next = await store.nextSlotMs(key, LIMITS, 10)
    expect(next).toBeGreaterThan(Date.now())
  })

  it('respects ITPM in next-slot estimate', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    await store.checkAndRecord(key, 800, LIMITS)

    // 300 tokens would push past 1000 ITPM limit
    const next = await store.nextSlotMs(key, LIMITS, 300)
    expect(next).toBeGreaterThan(Date.now())
  })
})

describe('InMemoryStore — snapshot and currentBackoff', () => {
  it('snapshot returns request count and token sums', async () => {
    const store = new InMemoryStore()
    const key = 'openai:gpt-4o'

    await store.checkAndRecord(key, 100, LIMITS)
    await store.checkAndRecord(key, 200, LIMITS)

    const snap = store.snapshot(key)
    expect(snap.requests).toBe(2)
    expect(snap.inputTokens).toBe(300)
  })

  it('currentBackoff returns null when no backoff', () => {
    const store = new InMemoryStore()
    expect(store.currentBackoff('openai:gpt-4o')).toBeNull()
  })

  it('currentBackoff returns expiry when active', async () => {
    const store = new InMemoryStore()
    const untilMs = Date.now() + 10_000
    await store.setBackoff('openai:gpt-4o', untilMs)
    expect(store.currentBackoff('openai:gpt-4o')).toBeCloseTo(untilMs, -2)
  })
})
