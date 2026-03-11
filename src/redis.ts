/**
 * ai-sdk-rate-limiter/redis
 *
 * Redis-backed rate-limit store for sharing rate limit state across multiple
 * instances (serverless functions, pods, workers).
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from 'ai-sdk-rate-limiter'
 * import { RedisStore } from 'ai-sdk-rate-limiter/redis'
 * import Redis from 'ioredis'
 *
 * const limiter = createRateLimiter({
 *   store: new RedisStore(new Redis(process.env.REDIS_URL)),
 * })
 * ```
 *
 * Install ioredis (or any compatible Redis client) as a peer dependency:
 * ```
 * npm install ioredis
 * ```
 *
 * The RedisStore satisfies the RateLimitStore interface, so any Redis client
 * with `eval()`, `set()`, and `get()` methods works — including ioredis,
 * node-redis, and Upstash Redis.
 */

export { RedisStore } from './store/redis-store.js'
export type { RedisClient, RedisStoreOptions } from './store/redis-store.js'
export type { RateLimitStore } from './store/interface.js'
