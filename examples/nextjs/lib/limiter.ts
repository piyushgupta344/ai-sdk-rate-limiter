/**
 * Singleton rate limiter shared across all API routes.
 *
 * In Next.js, module-level state is shared within a single Node.js process.
 * This means one limiter instance tracks cost and rate limits across all
 * concurrent requests — exactly what you want.
 *
 * For multi-instance deployments (e.g. multiple Vercel replicas), swap the
 * default in-memory store for RedisStore to share state across instances:
 *
 *   import { RedisStore } from 'ai-sdk-rate-limiter/redis'
 *   store: new RedisStore(new Redis(process.env.REDIS_URL!))
 */

import { createRateLimiter } from 'ai-sdk-rate-limiter'

export const limiter = createRateLimiter({
  cost: {
    // Hard cap: never spend more than $10/day across all models.
    // Remove or increase for production — this is conservative for demos.
    budget: { daily: 10 },
    onExceeded: 'throw',
  },

  retry: {
    maxAttempts: 4,
    backoff: 'exponential',
    parseRetryAfter: true,
  },

  queue: {
    maxSize: 200,
    timeout: 30_000,
  },

  on: {
    rateLimited: ({ model, source, resetAt }) => {
      console.warn(
        `[rate-limiter] ${model} rate limited (${source}), resets at ${new Date(resetAt).toISOString()}`,
      )
    },
    retrying: ({ model, attempt, maxAttempts, delayMs }) => {
      console.warn(`[rate-limiter] ${model} retry ${attempt}/${maxAttempts} in ${delayMs}ms`)
    },
    budgetHit: ({ model, currentCostUsd, limitUsd, period }) => {
      console.error(
        `[rate-limiter] budget hit for ${model}: $${currentCostUsd.toFixed(4)} / $${limitUsd} (${period})`,
      )
    },
    completed: ({ model, inputTokens, outputTokens, costUsd, latencyMs }) => {
      console.log(
        `[rate-limiter] ${model}: ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(6)}, ${latencyMs}ms`,
      )
    },
  },
})
