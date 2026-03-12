/**
 * Singleton rate limiter — shared across all requests in this process.
 *
 * Scoped limits give every user their own isolated RPM window so one
 * user's burst can't starve everyone else. Free users get 5 RPM each,
 * Pro users get 60 RPM each — all enforced from a single limiter instance.
 */

import { createRateLimiter } from 'ai-sdk-rate-limiter'

export const limiter = createRateLimiter({
  // Per-tier rate limits. Wildcard patterns match scope strings:
  //   'user:free:alice' → matches 'user:free:*' → 5 RPM
  //   'user:pro:bob'    → matches 'user:pro:*'  → 60 RPM
  scopes: {
    'user:free:*': { rpm: 5,   itpm: 20_000  },
    'user:pro:*':  { rpm: 60,  itpm: 200_000 },
    'org:*':       { rpm: 300, itpm: 1_000_000, maxConcurrent: 20 },
  },

  cost: {
    // Global daily budget across all users — adjust for your production spend.
    budget: { daily: 100 },
    onExceeded: 'throw',
  },

  retry: {
    maxAttempts: 3,
    backoff: 'exponential',
    parseRetryAfter: true,
  },

  queue: {
    maxSize: 1000,
    timeout: 30_000,
    onFull: 'drop-low', // drop low-priority requests before throwing
  },

  on: {
    rateLimited: ({ model, source, limitType }) =>
      console.warn(`[limiter] ${model} ${limitType} rate limited (${source})`),

    dropped: ({ model, reason, scope }) =>
      console.warn(`[limiter] request dropped — reason: ${reason}, scope: ${scope ?? 'unscoped'}`),

    completed: ({ model, inputTokens, outputTokens, costUsd, scope }) =>
      console.log(`[limiter] ${model} ${inputTokens}+${outputTokens}tok $${costUsd.toFixed(6)} scope=${scope ?? '-'}`),
  },
})
