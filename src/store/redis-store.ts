/**
 * Redis-backed rate-limit store.
 *
 * Uses a Redis sorted set per model key to track requests within the sliding
 * window. Lua scripts make check-and-record operations atomic, preventing
 * races between concurrent instances (serverless functions, pods, workers).
 *
 * Install ioredis (or any compatible client) as a peer dependency:
 *   npm install ioredis
 *
 * Usage:
 *   import { RedisStore } from 'ai-sdk-rate-limiter/redis'
 *   import Redis from 'ioredis'
 *
 *   const limiter = createRateLimiter({
 *     store: new RedisStore(new Redis(process.env.REDIS_URL)),
 *   })
 */

import type { ModelLimits } from '../types.js'
import type { RateLimitStore } from './interface.js'

// ---------------------------------------------------------------------------
// Minimal Redis client interface — satisfied by ioredis, node-redis, upstash
// ---------------------------------------------------------------------------

export interface RedisClient {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    time: number,
    setMode: 'NX',
  ): Promise<string | null>
  set(key: string, value: string, expiryMode: 'PX', time: number): Promise<string | null>
  get(key: string): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * Atomic check-and-record.
 *
 * KEYS[1]  sorted set: "rl:{key}:window"
 * KEYS[2]  backoff key: "rl:{key}:backoff"
 * ARGV[1]  now (ms)
 * ARGV[2]  windowMs (60000)
 * ARGV[3]  rpm limit (0 = unlimited)
 * ARGV[4]  itpm limit (0 = unlimited)
 * ARGV[5]  estimatedInputTokens
 * ARGV[6]  unique member ID for this request
 *
 * Returns: number (0 = allowed, >0 = nextSlotAtMs)
 */
const LUA_CHECK_AND_RECORD = `
local now        = tonumber(ARGV[1])
local windowMs   = tonumber(ARGV[2])
local rpmLimit   = tonumber(ARGV[3])
local itpmLimit  = tonumber(ARGV[4])
local estInput   = tonumber(ARGV[5])
local memberId   = ARGV[6]

-- Respect a server-issued backoff
local backoffVal = redis.call('GET', KEYS[2])
if backoffVal then
  local backoffUntil = tonumber(backoffVal)
  if backoffUntil > now then
    return backoffUntil
  end
end

-- Evict entries outside the window
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)

-- Gather all remaining members
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local reqCount = #members
local inputSum  = 0

for _, m in ipairs(members) do
  -- member format: "inputTokens:outputTokens:id"
  local inp = tonumber(m:match('^(%d+):'))
  if inp then inputSum = inputSum + inp end
end

-- RPM check
if rpmLimit > 0 and reqCount >= rpmLimit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldestTs = tonumber(oldest[2] or now)
  return oldestTs + windowMs + 1
end

-- ITPM check
if itpmLimit > 0 and inputSum + estInput > itpmLimit then
  local withScores = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
  local running = inputSum
  for i = 1, #withScores, 2 do
    local inp = tonumber(withScores[i]:match('^(%d+):')) or 0
    local ts  = tonumber(withScores[i+1])
    running = running - inp
    if running + estInput <= itpmLimit then
      return ts + windowMs + 1
    end
  end
  return now + windowMs + 1
end

-- Reserve slot
local member = estInput .. ':0:' .. memberId
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], windowMs + 5000)

return 0
`

/**
 * Replace estimated tokens with actual values for the most-recent placeholder.
 *
 * KEYS[1]  sorted set: "rl:{key}:window"
 * ARGV[1]  actualInputTokens
 * ARGV[2]  actualOutputTokens
 *
 * Finds the newest member with outputTokens=0 and updates it.
 */
const LUA_RECONCILE = `
local actual_inp = ARGV[1]
local actual_out = ARGV[2]

local members = redis.call('ZREVRANGE', KEYS[1], 0, -1, 'WITHSCORES')

for i = 1, #members, 2 do
  local m  = members[i]
  local ts = members[i+1]
  -- Check for outputTokens = 0 (placeholder format: "input:0:id")
  local inp, out = m:match('^(%d+):(%d+):')
  if inp and out == '0' then
    redis.call('ZREM', KEYS[1], m)
    local id = m:match('^%d+:%d+:(.+)$')
    local newMember = actual_inp .. ':' .. actual_out .. ':' .. (id or 'x')
    redis.call('ZADD', KEYS[1], ts, newMember)
    return 1
  end
end

return 0
`

/**
 * Read-only estimate of next available slot.
 *
 * KEYS[1]  sorted set
 * KEYS[2]  backoff key
 * ARGV[1]  now (ms)
 * ARGV[2]  windowMs
 * ARGV[3]  rpmLimit
 * ARGV[4]  itpmLimit
 * ARGV[5]  estimatedInputTokens
 */
const LUA_NEXT_SLOT = `
local now       = tonumber(ARGV[1])
local windowMs  = tonumber(ARGV[2])
local rpmLimit  = tonumber(ARGV[3])
local itpmLimit = tonumber(ARGV[4])
local estInput  = tonumber(ARGV[5])

local backoffVal = redis.call('GET', KEYS[2])
if backoffVal then
  local backoffUntil = tonumber(backoffVal)
  if backoffUntil > now then return backoffUntil end
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)

local members  = redis.call('ZRANGE', KEYS[1], 0, -1)
local reqCount = #members
local inputSum = 0

for _, m in ipairs(members) do
  local inp = tonumber(m:match('^(%d+):'))
  if inp then inputSum = inputSum + inp end
end

-- Available now?
local rpmOk  = rpmLimit == 0 or reqCount < rpmLimit
local itpmOk = itpmLimit == 0 or inputSum + estInput <= itpmLimit
if rpmOk and itpmOk then return 0 end

local nextSlot = now

if rpmLimit > 0 and reqCount >= rpmLimit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldestTs = tonumber(oldest[2] or now)
  if oldestTs + windowMs + 1 > nextSlot then
    nextSlot = oldestTs + windowMs + 1
  end
end

if itpmLimit > 0 and inputSum + estInput > itpmLimit then
  local withScores = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
  local running = inputSum
  for i = 1, #withScores, 2 do
    local inp = tonumber(withScores[i]:match('^(%d+):')) or 0
    local ts  = tonumber(withScores[i+1])
    running = running - inp
    if running + estInput <= itpmLimit then
      local candidate = ts + windowMs + 1
      if candidate > nextSlot then nextSlot = candidate end
      break
    end
  end
end

return nextSlot
`

// ---------------------------------------------------------------------------
// RedisStore
// ---------------------------------------------------------------------------

export interface RedisStoreOptions {
  /**
   * Key prefix for all Redis keys. Default: 'rl:'
   * Useful for namespacing when multiple apps share a Redis instance.
   */
  keyPrefix?: string
  /**
   * Sliding window size in milliseconds. Default: 60_000 (1 minute).
   * Should match the provider's rate limit window.
   */
  windowMs?: number
}

let _counter = 0

export class RedisStore implements RateLimitStore {
  private readonly redis: RedisClient
  private readonly prefix: string
  private readonly windowMs: number

  constructor(redis: RedisClient, options: RedisStoreOptions = {}) {
    this.redis = redis
    this.prefix = options.keyPrefix ?? 'rl:'
    this.windowMs = options.windowMs ?? 60_000
  }

  async checkAndRecord(
    key: string,
    estimatedInputTokens: number,
    limits: ModelLimits,
  ): Promise<number> {
    const memberId = `${Date.now()}_${++_counter}`
    const result = await this.redis.eval(
      LUA_CHECK_AND_RECORD,
      2,
      this.windowKey(key),
      this.backoffKey(key),
      Date.now(),
      this.windowMs,
      limits.rpm,
      limits.itpm ?? 0,
      estimatedInputTokens,
      memberId,
    )
    return Number(result)
  }

  async reconcile(
    key: string,
    actualInputTokens: number,
    actualOutputTokens: number,
  ): Promise<void> {
    await this.redis.eval(
      LUA_RECONCILE,
      1,
      this.windowKey(key),
      actualInputTokens,
      actualOutputTokens,
    )
  }

  async setBackoff(key: string, untilMs: number): Promise<void> {
    const ttlMs = Math.max(0, untilMs - Date.now()) + 5_000
    await this.redis.set(this.backoffKey(key), String(untilMs), 'PX', ttlMs)
  }

  async getBackoff(key: string): Promise<number> {
    const val = await this.redis.get(this.backoffKey(key))
    return val ? Number(val) : 0
  }

  async nextSlotMs(
    key: string,
    limits: ModelLimits,
    estimatedInputTokens = 0,
  ): Promise<number> {
    const result = await this.redis.eval(
      LUA_NEXT_SLOT,
      2,
      this.windowKey(key),
      this.backoffKey(key),
      Date.now(),
      this.windowMs,
      limits.rpm,
      limits.itpm ?? 0,
      estimatedInputTokens,
    )
    return Number(result)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private windowKey(key: string): string {
    return `${this.prefix}${key}:window`
  }

  private backoffKey(key: string): string {
    return `${this.prefix}${key}:backoff`
  }
}
