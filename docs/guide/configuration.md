# Configuration

## Full config reference

```typescript
const limiter = createRateLimiter({
  // Override built-in model limits
  limits: {
    'gpt-4o': { rpm: 500, itpm: 2_000_000 },
  },

  // Cost tracking and budget caps
  cost: {
    budget: { hourly: 5, daily: 50, monthly: 1000 },
    onExceeded: 'queue',          // 'throw' | 'queue' | 'fallback'
    store: new RedisCostStore(redis), // optional persistent store
  },

  // Queue behavior
  queue: {
    maxSize: 500,                 // max waiting requests
    timeout: 30_000,             // ms before a queued request times out
    onFull: 'throw',             // 'throw' | 'drop-low'
  },

  // Retry behavior
  retry: {
    maxAttempts: 4,
    backoff: 'exponential',      // 'exponential' | 'linear' | 'fixed'
    baseDelay: 1_000,
    maxDelay: 60_000,
    jitter: true,
    parseRetryAfter: true,       // honor Retry-After headers
    retryOn: [429, 500, 502, 503, 504],
    callTimeout: 30_000,         // per-call API timeout
  },

  // Circuit breaker
  circuit: {
    failureThreshold: 5,         // consecutive 5xx before opening
    cooldownMs: 60_000,          // how long to stay open
    tripOn: [500, 502, 503, 504],
  },

  // Per-scope rate limits (multi-tenant)
  scopes: {
    'user:free:*':  { rpm: 5,   itpm: 10_000 },
    'user:pro:*':   { rpm: 60,  itpm: 200_000 },
    'org:*':        { rpm: 300, maxConcurrent: 20 },
  },

  // Event handlers
  on: {
    rateLimited: ({ model, source, resetAt }) => { /* ... */ },
    budgetHit:   ({ model, period, limitUsd, usingFallback }) => { /* ... */ },
    completed:   ({ model, costUsd, latencyMs }) => { /* ... */ },
    dropped:     ({ model, reason }) => { /* ... */ },
    circuitOpen: ({ model, failures, cooldownMs }) => { /* ... */ },
  },

  // Redis store for sharing rate limit state across instances
  store: new RedisStore(new Redis(process.env.REDIS_URL)),

  // Debug logging
  debug: false,
})
```

## `limits`

Override built-in model limits from the registry:

```typescript
limits: {
  'gpt-4o':      { rpm: 500, itpm: 2_000_000 },
  'gpt-4o-mini': { rpm: 30_000, itpm: 150_000_000 },
}
```

You only need to set fields you want to override — unset fields fall back to the built-in registry values.

## `cost.onExceeded`

| Value | Behavior |
|---|---|
| `'throw'` (default) | Throws `BudgetExceededError` immediately |
| `'queue'` | Holds the request until the period rolls over |
| `'fallback'` | Transparently retries with the fallback model from `limiter.wrap(model, { fallback })` |

## `queue.onFull`

| Value | Behavior |
|---|---|
| `'throw'` (default) | Throws `QueueFullError` when queue hits `maxSize` |
| `'drop-low'` | Drops lowest-priority waiting requests to make room |

## `retry.callTimeout`

Sets a per-call timeout for the AI API request itself. If the call exceeds this, it is abandoned and retried (if attempts remain):

```typescript
retry: { callTimeout: 10_000 } // abandon calls taking > 10s
```

Override per-request:
```typescript
providerOptions: {
  rateLimiter: { callTimeout: 5_000 },
}
```

## `debug`

```typescript
const limiter = createRateLimiter({ debug: true })
// [ai-sdk-rate-limiter] gpt-4o: execute (provider="openai" priority="normal")
// [ai-sdk-rate-limiter] gpt-4o: queuing (queueDepth=3 estimatedWaitMs=1200 priority="normal")
// [ai-sdk-rate-limiter] gpt-4o: dequeued (waitedMs=1187 priority="normal")
// [ai-sdk-rate-limiter] gpt-4o: completed (tokens=342+87 costUsd=0.000021 latencyMs=1343 streaming=false)
```

Zero overhead when disabled — no string building or property access occurs.
