/**
 * RedisStore unit tests — uses a mock Redis client, no real Redis needed.
 *
 * The mock runs each Lua script through a lightweight in-memory interpreter
 * that mirrors the real Redis sorted-set operations used by the store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { RedisStore } from './redis-store.js'
import type { RedisClient } from './redis-store.js'

// ---------------------------------------------------------------------------
// Minimal in-memory Redis mock (sorted sets + string keys)
// ---------------------------------------------------------------------------

interface SortedSetEntry {
  score: number
  member: string
}

class MockRedis implements RedisClient {
  readonly sortedSets = new Map<string, SortedSetEntry[]>()
  readonly strings = new Map<string, { value: string; expiresAt?: number }>()

  private getString(key: string): string | null {
    const entry = this.strings.get(key)
    if (!entry) return null
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.strings.delete(key)
      return null
    }
    return entry.value
  }

  async get(key: string): Promise<string | null> {
    return this.getString(key)
  }

  async set(key: string, value: string, exMode?: string, ttlMs?: number): Promise<string | null> {
    const expiresAt = exMode === 'PX' && ttlMs !== undefined ? Date.now() + ttlMs : undefined
    this.strings.set(key, { value, expiresAt })
    return 'OK'
  }

  async eval(script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    // Route scripts to the appropriate mock implementation based on script content
    if (script.includes('LUA_CHECK_AND_RECORD') || script.includes('ZREMRANGEBYSCORE') && script.includes('ZADD')) {
      return this.runCheckAndRecord(args)
    }
    if (script.includes('ZREVRANGE')) {
      return this.runReconcile(args)
    }
    if (script.includes('LUA_NEXT_SLOT') || script.includes('ZRANGE') && !script.includes('ZADD')) {
      return this.runNextSlot(args)
    }
    return 0
  }

  private runCheckAndRecord(args: Array<string | number>): number {
    // KEYS: args[0]=windowKey, args[1]=backoffKey, args[2]=dailyKey
    // ARGV: args[3]=now, [4]=windowMs, [5]=rpm, [6]=itpm, [7]=estInput,
    //       [8]=memberId, [9]=otpm, [10]=rpd
    const windowKey = String(args[0])
    const backoffKey = String(args[1])
    const dailyKey  = String(args[2])
    const now       = Number(args[3])
    const windowMs  = Number(args[4])
    const rpmLimit  = Number(args[5])
    const itpmLimit = Number(args[6])
    const estInput  = Number(args[7])
    const memberId  = String(args[8])
    const otpmLimit = Number(args[9])
    const rpdLimit  = Number(args[10])
    const dayMs     = 86_400_000

    // Check backoff
    const backoffVal = this.getString(backoffKey)
    if (backoffVal) {
      const until = Number(backoffVal)
      if (until > now) return until
    }

    // Get/evict minute sorted set
    const entries = this.getSortedSet(windowKey)
    const cutoff = now - windowMs
    const active = entries.filter(e => e.score > cutoff)
    this.sortedSets.set(windowKey, active)

    const reqCount = active.length
    let inputSum = 0
    let outputSum = 0
    for (const e of active) {
      const m = e.member.match(/^(\d+):(\d+):/)
      inputSum  += Number(m?.[1] ?? 0)
      outputSum += Number(m?.[2] ?? 0)
    }

    // RPM check
    if (rpmLimit > 0 && reqCount >= rpmLimit) {
      const oldest = active[0]
      return (oldest?.score ?? now) + windowMs + 1
    }

    // ITPM check
    if (itpmLimit > 0 && inputSum + estInput > itpmLimit) {
      let running = inputSum
      for (const e of active) {
        running -= Number(e.member.match(/^(\d+):/)?.[1] ?? 0)
        if (running + estInput <= itpmLimit) {
          return e.score + windowMs + 1
        }
      }
      return now + windowMs + 1
    }

    // RPD check
    if (rpdLimit > 0) {
      const daily = this.getSortedSet(dailyKey)
      const activeDaily = daily.filter(e => e.score > now - dayMs)
      this.sortedSets.set(dailyKey, activeDaily)
      if (activeDaily.length >= rpdLimit) {
        return (activeDaily[0]?.score ?? now) + dayMs + 1
      }
    }

    // OTPM check
    if (otpmLimit > 0 && outputSum >= otpmLimit) {
      let running = outputSum
      for (const e of active) {
        running -= Number(e.member.match(/^\d+:(\d+):/)?.[1] ?? 0)
        if (running < otpmLimit) return e.score + windowMs + 1
      }
      return now + windowMs + 1
    }

    // Reserve
    active.push({ score: now, member: `${estInput}:0:${memberId}` })
    active.sort((a, b) => a.score - b.score)
    this.sortedSets.set(windowKey, active)

    if (rpdLimit > 0) {
      const daily = this.getSortedSet(dailyKey)
      daily.push({ score: now, member: memberId })
      this.sortedSets.set(dailyKey, daily)
    }

    return 0
  }

  private runReconcile(args: Array<string | number>): number {
    const windowKey = String(args[0])
    const actualInp = String(args[1])
    const actualOut = String(args[2])

    const entries = this.getSortedSet(windowKey)

    // Reverse iteration to find last placeholder
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      const match = e.member.match(/^(\d+):(\d+):(.+)$/)
      if (match && match[2] === '0') {
        entries[i] = { score: e.score, member: `${actualInp}:${actualOut}:${match[3]}` }
        return 1
      }
    }
    return 0
  }

  private runNextSlot(args: Array<string | number>): number {
    // KEYS: args[0]=windowKey, args[1]=backoffKey, args[2]=dailyKey
    // ARGV: args[3]=now, [4]=windowMs, [5]=rpm, [6]=itpm, [7]=estInput, [8]=otpm, [9]=rpd
    const windowKey = String(args[0])
    const backoffKey = String(args[1])
    const dailyKey  = String(args[2])
    const now       = Number(args[3])
    const windowMs  = Number(args[4])
    const rpmLimit  = Number(args[5])
    const itpmLimit = Number(args[6])
    const estInput  = Number(args[7])
    const otpmLimit = Number(args[8])
    const rpdLimit  = Number(args[9])
    const dayMs     = 86_400_000

    const backoffVal = this.getString(backoffKey)
    if (backoffVal) {
      const until = Number(backoffVal)
      if (until > now) return until
    }

    const entries = this.getSortedSet(windowKey)
    const active = entries.filter(e => e.score > now - windowMs)
    const reqCount = active.length
    let inputSum = 0
    let outputSum = 0
    for (const e of active) {
      inputSum  += Number(e.member.match(/^(\d+):/)?.[1] ?? 0)
      outputSum += Number(e.member.match(/^\d+:(\d+):/)?.[1] ?? 0)
    }

    // RPD check
    let rpdBlocked = false
    let rpdNextSlot = now
    if (rpdLimit > 0) {
      const daily = this.getSortedSet(dailyKey)
      const activeDaily = daily.filter(e => e.score > now - dayMs)
      if (activeDaily.length >= rpdLimit) {
        rpdBlocked = true
        rpdNextSlot = (activeDaily[0]?.score ?? now) + dayMs + 1
      }
    }

    const rpmOk  = rpmLimit === 0 || reqCount < rpmLimit
    const itpmOk = itpmLimit === 0 || inputSum + estInput <= itpmLimit
    const otpmOk = otpmLimit === 0 || outputSum < otpmLimit
    if (rpmOk && itpmOk && otpmOk && !rpdBlocked) return 0

    let nextSlot = now
    if (!rpmOk && active[0]) {
      nextSlot = Math.max(nextSlot, active[0].score + windowMs + 1)
    }
    if (!itpmOk) {
      let running = inputSum
      for (const e of active) {
        running -= Number(e.member.match(/^(\d+):/)?.[1] ?? 0)
        if (running + estInput <= itpmLimit) {
          nextSlot = Math.max(nextSlot, e.score + windowMs + 1)
          break
        }
      }
    }
    if (rpdBlocked) {
      nextSlot = Math.max(nextSlot, rpdNextSlot)
    }
    if (!otpmOk) {
      let running = outputSum
      for (const e of active) {
        running -= Number(e.member.match(/^\d+:(\d+):/)?.[1] ?? 0)
        if (running < otpmLimit) {
          nextSlot = Math.max(nextSlot, e.score + windowMs + 1)
          break
        }
      }
    }
    return nextSlot
  }

  private getSortedSet(key: string): SortedSetEntry[] {
    let s = this.sortedSets.get(key)
    if (!s) { s = []; this.sortedSets.set(key, s) }
    return s
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const LIMITS = {
  rpm: 5,
  itpm: 1_000,
  inputPricePerMillion: 2.5,
  outputPricePerMillion: 10.0,
}

let mockRedis: MockRedis
let store: RedisStore

beforeEach(() => {
  mockRedis = new MockRedis()
  store = new RedisStore(mockRedis as unknown as RedisClient)
})

describe('RedisStore — checkAndRecord', () => {
  it('allows request when under RPM limit', async () => {
    const result = await store.checkAndRecord('openai:gpt-4o', 100, LIMITS)
    expect(result).toBeLessThanOrEqual(Date.now())
  })

  it('blocks when RPM limit is reached', async () => {
    const key = 'openai:gpt-4o'
    for (let i = 0; i < 5; i++) {
      await store.checkAndRecord(key, 10, LIMITS)
    }
    const blocked = await store.checkAndRecord(key, 10, LIMITS)
    expect(blocked).toBeGreaterThan(Date.now())
  })

  it('blocks when ITPM limit is reached', async () => {
    const key = 'openai:gpt-4o'
    await store.checkAndRecord(key, 800, LIMITS)
    const blocked = await store.checkAndRecord(key, 300, LIMITS)
    expect(blocked).toBeGreaterThan(Date.now())
  })

  it('allows after ITPM evicts old entries (different keys test)', async () => {
    // Separate keys don't interfere
    await store.checkAndRecord('openai:gpt-4o', 500, LIMITS)
    const result = await store.checkAndRecord('openai:gpt-4o-mini', 500, LIMITS)
    expect(result).toBeLessThanOrEqual(Date.now())
  })
})

describe('RedisStore — reconcile', () => {
  it('updates the most recent placeholder with actual values', async () => {
    const key = 'openai:gpt-4o'
    await store.checkAndRecord(key, 100, LIMITS)
    await store.reconcile(key, 80, 40)

    const entries = mockRedis.sortedSets.get('rl:openai:gpt-4o:window') ?? []
    expect(entries[0]?.member).toMatch(/^80:40:/)
  })
})

describe('RedisStore — backoff', () => {
  it('blocks requests during active backoff', async () => {
    const key = 'openai:gpt-4o'
    const untilMs = Date.now() + 10_000
    await store.setBackoff(key, untilMs)

    const blocked = await store.checkAndRecord(key, 10, LIMITS)
    expect(blocked).toBeGreaterThanOrEqual(untilMs)
  })

  it('getBackoff returns 0 when no backoff set', async () => {
    const result = await store.getBackoff('openai:gpt-4o')
    expect(result).toBe(0)
  })

  it('getBackoff returns stored value', async () => {
    const untilMs = Date.now() + 5_000
    await store.setBackoff('openai:gpt-4o', untilMs)
    const result = await store.getBackoff('openai:gpt-4o')
    expect(result).toBeCloseTo(untilMs, -2)
  })
})

describe('RedisStore — nextSlotMs', () => {
  it('returns 0 when no usage recorded', async () => {
    const result = await store.nextSlotMs('openai:gpt-4o', LIMITS, 10)
    expect(result).toBe(0)
  })

  it('returns future ms when RPM is maxed', async () => {
    const key = 'openai:gpt-4o'
    for (let i = 0; i < 5; i++) {
      await store.checkAndRecord(key, 10, LIMITS)
    }
    const next = await store.nextSlotMs(key, LIMITS, 10)
    expect(next).toBeGreaterThan(Date.now())
  })
})

describe('RedisStore — multi-instance simulation', () => {
  it('two stores sharing the same mock Redis enforce RPM collectively', async () => {
    const store1 = new RedisStore(mockRedis as unknown as RedisClient)
    const store2 = new RedisStore(mockRedis as unknown as RedisClient)
    const key = 'openai:gpt-4o'

    // Instance 1 uses 4 of 5 RPM slots
    for (let i = 0; i < 4; i++) {
      const r = await store1.checkAndRecord(key, 10, LIMITS)
      expect(r).toBeLessThanOrEqual(Date.now())
    }

    // Instance 2 uses the last slot
    const r = await store2.checkAndRecord(key, 10, LIMITS)
    expect(r).toBeLessThanOrEqual(Date.now())

    // Both instances now see the limit hit
    const blocked1 = await store1.checkAndRecord(key, 10, LIMITS)
    const blocked2 = await store2.checkAndRecord(key, 10, LIMITS)
    expect(blocked1).toBeGreaterThan(Date.now())
    expect(blocked2).toBeGreaterThan(Date.now())
  })
})
