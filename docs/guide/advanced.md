# Advanced patterns

## Load balancing across API keys

`createModelPool()` round-robins across multiple wrapped model instances:

```typescript
import { createRateLimiter, createModelPool } from 'ai-sdk-rate-limiter'
import { createOpenAI } from '@ai-sdk/openai'

const limiter1 = createRateLimiter({ limits: { 'gpt-4o': { rpm: 500 } } })
const limiter2 = createRateLimiter({ limits: { 'gpt-4o': { rpm: 500 } } })

const pool = createModelPool([
  limiter1.wrap(createOpenAI({ apiKey: process.env.KEY_1 })('gpt-4o')),
  limiter2.wrap(createOpenAI({ apiKey: process.env.KEY_2 })('gpt-4o')),
])

// Alternates between the two keys automatically
const { text } = await generateText({ model: pool, prompt: 'Hello!' })
```

Use `{ strategy: 'random' }` for random selection instead of round-robin.

## Request deduplication

Concurrent requests with the same `dedupKey` share one API call:

```typescript
// 50 simultaneous users asking the same FAQ → 1 API call
await generateText({
  model,
  prompt: questions[questionId],
  providerOptions: {
    rateLimiter: { dedupKey: `faq:${questionId}` },
  },
})
```

The dedup entry clears on completion, so the next request always makes a fresh call.

## Multi-instance Redis store

Share rate limit state across multiple server instances:

```typescript
import { RedisStore } from 'ai-sdk-rate-limiter/redis'
import Redis from 'ioredis'

const limiter = createRateLimiter({
  store: new RedisStore(new Redis(process.env.REDIS_URL)),
  cost: {
    budget: { daily: 50 },
    store: new RedisCostStore(new Redis(process.env.REDIS_URL)),
  },
})
await limiter.warmUp()
```

## Graceful shutdown

```typescript
// On SIGTERM — drain queue, wait for in-flight requests
process.on('SIGTERM', async () => {
  await limiter.shutdown({ drainMs: 10_000 })
  process.exit(0)
})
```

`shutdown()` immediately rejects all queued requests with `ShutdownError`, stops accepting new ones, and waits up to `drainMs` for in-flight requests to complete.

## Multiple limiters per tier

```typescript
const freeLimiter = createRateLimiter({
  limits: { 'gpt-4o-mini': { rpm: 5 } },
  cost: { budget: { daily: 0.10 }, onExceeded: 'throw' },
  queue: { timeout: 5_000 },
})

const paidLimiter = createRateLimiter({
  limits: { 'gpt-4o': { rpm: 100 } },
  cost: { budget: { daily: 20 } },
})

const model = req.user.plan === 'paid'
  ? paidLimiter.wrap(openai('gpt-4o'))
  : freeLimiter.wrap(openai('gpt-4o-mini'))
```

## AbortSignal support

```typescript
const controller = new AbortController()

// Cancel all queued and in-flight requests
setTimeout(() => controller.abort(), 5000)

const { text } = await generateText({
  model,
  prompt,
  abortSignal: controller.signal,
})
```

The signal is forwarded to both the queue and the underlying API call.

## Custom cost store

```typescript
import type { CostStore, PersistedCostEntry } from 'ai-sdk-rate-limiter'

class PostgresCostStore implements CostStore {
  async append(entry: PersistedCostEntry): Promise<void> {
    await db.query('INSERT INTO cost_entries VALUES ($1, $2, $3, $4, $5)',
      [entry.timestamp, entry.model, entry.inputTokens, entry.outputTokens, entry.costUsd])
  }

  async load(sinceMs: number): Promise<PersistedCostEntry[]> {
    return db.query('SELECT * FROM cost_entries WHERE timestamp > $1', [sinceMs])
  }
}
```

## Combine OTel + event logging

```typescript
import { createOtelPlugin } from 'ai-sdk-rate-limiter/otel'

const limiter = createRateLimiter({
  on: {
    ...createOtelPlugin(trace.getTracer('ai-service')).handlers,
    budgetHit: ({ model, limitUsd, period }) =>
      alerts.send(`Budget alert: ${model} hit $${limitUsd} ${period} cap`),
  },
})
```
