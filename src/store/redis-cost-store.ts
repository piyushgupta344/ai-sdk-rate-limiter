/**
 * Redis-backed cost store.
 *
 * Persists request cost entries in a sorted set (score = timestamp) so that
 * budget caps survive process restarts. Uses the same Redis client interface
 * as RedisStore — any client with eval(), get(), and set() works.
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from 'ai-sdk-rate-limiter'
 * import { RedisCostStore } from 'ai-sdk-rate-limiter/redis'
 * import Redis from 'ioredis'
 *
 * const redis = new Redis(process.env.REDIS_URL)
 * const limiter = createRateLimiter({
 *   cost: { store: new RedisCostStore(redis) },
 * })
 * await limiter.warmUp() // pre-loads the last 30 days of cost history
 * ```
 */

import type { RedisClient } from './redis-store.js'
import type { CostStore, PersistedCostEntry } from './cost-store-interface.js'

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * Append a cost entry and evict entries older than 31 days.
 *
 * KEYS[1]  sorted set key
 * ARGV[1]  score (timestamp ms)
 * ARGV[2]  JSON-encoded entry (member)
 * ARGV[3]  evict-before score (now - 31 days)
 * ARGV[4]  TTL in ms (31 days + buffer)
 */
const LUA_APPEND = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`

/**
 * Load all entries at or after a given timestamp.
 *
 * KEYS[1]  sorted set key
 * ARGV[1]  min score (sinceMs)
 */
const LUA_LOAD = `
return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')
`

// ---------------------------------------------------------------------------
// RedisCostStore
// ---------------------------------------------------------------------------

const MONTH_MS  = 30 * 24 * 60 * 60_000
const BUFFER_MS =  1 * 24 * 60 * 60_000

export interface RedisCostStoreOptions {
  /** Key prefix. Default: 'rlcost:' */
  keyPrefix?: string
  /** How long to retain entries. Default: 30 days */
  retentionMs?: number
}

export class RedisCostStore implements CostStore {
  private readonly redis: RedisClient
  private readonly key: string
  private readonly retentionMs: number

  constructor(redis: RedisClient, options: RedisCostStoreOptions = {}) {
    this.redis       = redis
    this.key         = (options.keyPrefix ?? 'rlcost:') + 'entries'
    this.retentionMs = options.retentionMs ?? MONTH_MS
  }

  async append(entry: PersistedCostEntry): Promise<void> {
    try {
      const member    = JSON.stringify(entry)
      const evictBefore = entry.timestamp - this.retentionMs
      const ttlMs     = this.retentionMs + BUFFER_MS

      await this.redis.eval(
        LUA_APPEND, 1,
        this.key,
        entry.timestamp,
        member,
        evictBefore,
        ttlMs,
      )
    } catch {
      // Fire-and-forget — cost persistence is best-effort
    }
  }

  async load(sinceMs: number): Promise<PersistedCostEntry[]> {
    try {
      const result = await this.redis.eval(LUA_LOAD, 1, this.key, sinceMs)
      if (!Array.isArray(result)) return []

      const entries: PersistedCostEntry[] = []
      for (const raw of result as unknown[]) {
        try {
          const parsed = JSON.parse(String(raw)) as PersistedCostEntry
          if (typeof parsed.timestamp === 'number' && typeof parsed.costUsd === 'number') {
            entries.push(parsed)
          }
        } catch {
          // Skip malformed entries
        }
      }
      return entries
    } catch {
      return []
    }
  }
}
